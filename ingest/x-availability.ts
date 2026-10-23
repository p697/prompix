import { randomUUID } from "node:crypto";
import { readAllXIntake, convertXThread } from "./x-thread-intake.ts";
import { join } from "node:path";
import { z } from "zod";
import type { Catalog, Prompt } from "../packages/schema/catalog.ts";
import { atomic, json } from "./publication.ts";
import { checkXAvailability } from "./x.ts";
import { convertXDiscovery } from "./x-intake.ts";
import { readXExcerptReviews } from "./x-excerpts.ts";
import { isNativeXDraft, nativeXSourceIssue, nativeXPostIDs, nativeXSourceDigest } from "./x-source.ts";
import { mergeCreatorCache, type CreatorCache } from "./creators.ts";
import { reviewsSchema } from "./editorial.ts";
import { editorialCacheSchema, editorialDecisionKey, editorialQueue } from "./editorial-runner.ts";
import { readQualityHolds } from "./quality-holds.ts";
import { moderationSchema } from "./publication.ts";
import { TwitterAPIClient } from "./twitterapi.ts";
import { RapidAPIClient } from "./rapidapi.ts";
import { configuredXSpendBudget, XBudgetExceeded } from "./x-spend.ts";
import { saveMaintenanceCensus } from "./x-maintenance-reserve.ts";
import { recheckXStandalone, refreshedXSource, type XRecheckOptions } from "./x-recheck.ts";
import type { XMaintenanceAdmission } from "./x-maintenance-admission.ts";

import { thirdPartyOnly } from "./x-third-party.ts";

const recordSchema = z.object({ checkedAt: z.iso.datetime(), status: z.enum(["ready", "withheld"]),
  checkedBy: z.enum(["official", "twitterapi", "rapidapi"]).optional(),
  scopeIDs: z.array(z.string().regex(/^\d{1,19}$/)).max(10).optional(),
  removed: z.boolean().optional(), revision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const stateSchema = z.record(z.string().regex(/^x-post-\d{1,19}$/), recordSchema);
const ledgerSchema = z.array(z.object({ ids: z.array(z.string().regex(/^\d{1,19}$/)).min(1).max(100),
  state: z.enum(["reserved", "completed", "failed"]), at: z.iso.datetime() }).strict()).max(4);
export type XAvailabilityState = z.infer<typeof stateSchema>;
export async function readXAvailability(root: string): Promise<XAvailabilityState> {
  return stateSchema.parse(await json(join(root, "x-availability", "state.json"), {}));
}
function thirdPartyCheck(record: XAvailabilityState[string] | undefined) {
  return record?.checkedBy === "twitterapi" || record?.checkedBy === "rapidapi";
}
/** Only exact complete intake snapshots can supply a free, non-renewing availability check. */
function freshDiscoveryRecord(item: Prompt, record: XAvailabilityState[string] | undefined, threadIDs: ReadonlySet<string>, now: number) {
  const post = item.source.post, checked = Date.parse(post?.checkedAt ?? "");
  if (!isNativeXDraft(item) || !post || record?.removed || threadIDs.has(post.id) || !Number.isFinite(checked) || checked > now ||
      now - checked >= 12 * 3600_000 || (record && checked <= Date.parse(record.checkedAt)) || nativeXSourceIssue(item, now) ||
      nativeXSourceDigest(item) !== item.source.revision) return;
  return { checkedAt: new Date(checked).toISOString(), status: "ready" as const, revision: item.source.revision, checkedBy: item.source.acquiredVia ?? "official" as const };
}

/** Called under daily.lock after collection, before editorial. Never fetches or grants approval. */
export async function adoptFreshXDiscoveries(root: string, items: readonly Prompt[], state: XAvailabilityState, now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error("Invalid X discovery adoption time");
  const next = { ...state }, threadIDs = new Set(items.filter(item => item.source.context).flatMap(nativeXPostIDs));
  let reused = 0;
  for (const item of items) {
    const record = freshDiscoveryRecord(item, state[item.id], threadIDs, now);
    if (record) { next[item.id] = record; reused++; }
  }
  if (reused) await atomic(join(root, "x-availability", "state.json"), stateSchema.parse(next));
  return { state: next, reused };
}

/** Rechecks refresh a matching source only; changed or withdrawn posts cannot be resurrected by retention. */
export function filterXAvailability<T extends Prompt>(items: readonly T[], state: XAvailabilityState, now = Date.now()) {
  const withheldIDs: string[] = [];
  const prompts = items.flatMap(item => {
    if (!isNativeXDraft(item)) return [item];
    const record = state[item.id], post = item.source.post;
    const needsJointCheck = !!(item.source.context || post?.parentID || item.source.mediaPostID);
    if (!post || record?.status !== "ready" || record.revision !== item.source.revision || (needsJointCheck && thirdPartyCheck(record) && !nativeXPostIDs(item).every(id => record.scopeIDs?.includes(id)))) {
      withheldIDs.push(item.id); return [];
    }
    item = { ...item, source: { ...item.source, post: { ...post, checkedAt: record.checkedAt },
      ...(item.source.context ? { context: item.source.context.map(source => ({ ...source, checkedAt: record.checkedAt })) } : {}) } };
    if (nativeXSourceIssue(item, now)) { withheldIDs.push(item.id); return []; }
    return [item];
  });
  return { prompts, withheldIDs };
}
export async function assertXAvailability(root: string, catalog: Pick<Catalog, "prompts">) {
  if (!catalog.prompts.some(isNativeXDraft)) return;
  const result = filterXAvailability(catalog.prompts, await readXAvailability(root));
  if (result.withheldIDs.length) throw new Error(`X posts need a current source check: ${result.withheldIDs.join(", ")}`);
}
export function configuredRecheck(environment: NodeJS.ProcessEnv = process.env): XRecheckOptions | undefined {
  const provider = environment.PROMPIX_X_RECHECK_PROVIDER ?? "official";
  if (provider === "official") return;
  if (provider !== "twitterapi" && provider !== "rapidapi") throw new Error("Invalid X recheck provider");
  const budget = configuredXSpendBudget(environment), key = provider === "rapidapi" ? environment.RAPIDAPI_KEY : environment.TWITTERAPI_IO_KEY;
  if (!budget || !key) throw new Error("Third-party rechecks require a shared dollar budget and key");
  const client = provider === "rapidapi" ? new RapidAPIClient(key, budget) : new TwitterAPIClient(key, budget);
  const maxRequests = Number(environment.PROMPIX_X_RECHECK_MAX_REQUESTS ?? 16);
  const dailyRequestCeiling = Number(environment.PROMPIX_X_RECHECK_DAILY_CEILING ?? 40);
  if (!Number.isInteger(dailyRequestCeiling) || dailyRequestCeiling < 1 || dailyRequestCeiling > 80
    || !Number.isInteger(maxRequests) || maxRequests < 0 || maxRequests > dailyRequestCeiling)
    throw new Error("Invalid configured third-party recheck budget");
  return { provider, lookup: client.lookup.bind(client), maxRequests, dailyRequestCeiling };
}
/** Separate maintenance budget: default two requests, bounded to four / 400 posts per UTC day. No automatic retries. Caller holds daily.lock. */
export async function prepareXAvailability(root: string, options: { enabled: boolean; bearer?: string; now?: string;
  lookup?: typeof checkXAvailability; maxRequests?: number; recheck?: XRecheckOptions; admission?: XMaintenanceAdmission; environment?: NodeJS.ProcessEnv } ) {
  const now = options.now ?? new Date().toISOString(), nowMS = Date.parse(now), day = now.slice(0, 10);
  if (!Number.isFinite(nowMS)) throw new Error("Invalid X availability time");
  const maxRequests = options.maxRequests ?? Number(process.env.PROMPIX_X_AVAILABILITY_MAX_REQUESTS ?? 2);
  if (!Number.isInteger(maxRequests) || maxRequests < 0 || maxRequests > 4) throw new Error("Invalid X availability budget");
  if (options.admission && (!Number.isInteger(options.admission.maxDrafts) || options.admission.maxDrafts < 0 || options.admission.maxDrafts > 192))
    throw new Error("Invalid X draft maintenance allowance");
  const state = await readXAvailability(root);
  const report = { status: "cached", requests: 0, checked: 0, withheld: 0, skippedInactive: 0, reusedDiscovery: 0, deferredDrafts: 0,
    maintenanceReserve: undefined as Awaited<ReturnType<typeof saveMaintenanceCensus>>,
    recheck: undefined as Awaited<ReturnType<typeof recheckXStandalone>> | undefined };
  const env = options.environment ?? process.env, thirdParty = thirdPartyOnly(env);
  if (!options.enabled || (!thirdParty && !options.bearer)) return { state, report };
  const ledgerPath = join(root, "x-availability", `${day}.json`);
  const ledger = ledgerSchema.parse(await json(ledgerPath, []));
  const intake = await readAllXIntake(root);
  const excerpts = await readXExcerptReviews(root);
  const reviews = reviewsSchema.parse(await json(join(root, "editorial.json"), {}));
  const decisions = editorialCacheSchema.parse(await json(join(root, "editorial", "decisions.json"), { version: 1, decisions: {} })).decisions;
  const removed = new Set(moderationSchema.parse(await json(join(root, "moderation.json"), { removedIDs: [] })).removedIDs);
  const holds = await readQualityHolds(root);
  const protectedIDs = new Set([...Object.keys(reviews), ...(options.admission?.publishedIDs ?? []),
    ...Object.values(decisions).filter(decision => decision.decision === "approve").map(decision => decision.id)]);
  const isInactive = (item: typeof intake.candidates[number]) => removed.has(item.id) || !!holds.holds[item.id] ||
    (!protectedIDs.has(item.id) && !!decisions[editorialDecisionKey(item)] && decisions[editorialDecisionKey(item)].decision !== "approve");
  report.maintenanceReserve = await saveMaintenanceCensus(intake.candidates, protectedIDs,
    new Set([...removed, ...Object.keys(holds.holds), ...Object.entries(state).filter(([, value]) => value.removed).map(([id]) => id)]), new Date(now), !!options.admission, env);
  // Include fresh drafts in the queue: they already occupy upcoming review slots and cost no recheck.
  const admitted = options.admission ? new Set(editorialQueue(intake.candidates.filter(item =>
    !isInactive(item) && !protectedIDs.has(item.id) && !options.admission!.attemptedIDs.has(item.id)), [],
    Math.floor(nowMS / 86400000)).slice(0, options.admission.maxDrafts).map(item => item.id)) : undefined;
  const threadIDs = new Set(intake.candidates.filter(item => item.source.context).flatMap(nativeXPostIDs));
  const sourceCheckedAt = (item: typeof intake.candidates[number]) => Math.min(...[...(item.source.context ?? []), item.source.post]
    .map(source => Date.parse(source?.checkedAt ?? "") || 0));
  const checkedAt = (item: typeof intake.candidates[number]) => Math.max(sourceCheckedAt(item),
    Date.parse(state[item.id]?.checkedAt ?? "") || 0);
  let due = intake.candidates.filter(item => {
    // A previous approval or publication may still back a retained edition.
    if (isInactive(item)) {
      report.skippedInactive++; return false;
    }
    const checked = checkedAt(item);
    const record = state[item.id];
    if (record?.removed) return false;
    // Threads still need a joint lookup even when one dependency was freshly acquired.
    const discovery = freshDiscoveryRecord(item, record, threadIDs, nowMS);
    if (discovery) {
      state[item.id] = discovery; report.reusedDiscovery++; return false;
    }
    // A recently recorded standalone result cannot defer a now-known joint
    // dependency check. Keep the daily official quota; retry at its next window.
    const incompleteScope = threadIDs.has(item.source.post!.id) && thirdPartyCheck(record) && !nativeXPostIDs(item).every(id => record?.scopeIDs?.includes(id));
    const needsCheck = incompleteScope || !record || (record.status === "ready" && record.revision !== item.source.revision) || nowMS - checked >= 12 * 3600_000;
    if (needsCheck && admitted && !protectedIDs.has(item.id) && !admitted.has(item.id)) {
      report.deferredDrafts++; return false;
    }
    return needsCheck;
  }).sort((a, b) => Number(protectedIDs.has(b.id)) - Number(protectedIDs.has(a.id)) || checkedAt(a) - checkedAt(b) || a.id.localeCompare(b.id));
  if (report.reusedDiscovery) await atomic(join(root, "x-availability", "state.json"), stateSchema.parse(state));
  const recheck = options.recheck ?? configuredRecheck(env);
  if (recheck) {
    const verified = new Set<string>();
    report.recheck = await recheckXStandalone(root, due.filter(item => thirdParty || !threadIDs.has(item.source.post!.id)), {
      ...recheck, joint: thirdParty, protectedIDs, now, excerpts, apply: async (matched, unresolved, result, ids) => {
        if (thirdParty) {
          const snapshot = { ...result, capturedAt: now };
          const affected = intake.candidates.filter(item => nativeXPostIDs(item).some(id => ids.includes(id)));
          for (const item of affected) {
            const complete = nativeXPostIDs(item).every(id => ids.includes(id));
            const next = complete ? refreshedXSource(item, result, now, excerpts) : undefined;
            state[item.id] = { checkedAt: now, status: next ? "ready" : "withheld", checkedBy: result.provider,
              ...(next ? { revision: next.source.revision, scopeIDs: nativeXPostIDs(item) } : {}) };
            if (next) verified.add(item.id);
            if (item.source.context && complete) await atomic(join(root, "x-replies", "checks", `${item.id}.json`),
              { rootID: item.source.context[0].id, snapshot });
          }
          await atomic(join(root, "x-availability", "state.json"), stateSchema.parse(state));
          for (let offset = 0; offset < result.posts.length; offset += 100) {
            const posts = result.posts.slice(offset, offset + 100);
            await atomic(join(root, "x-discovery", `${day}-check-000-${randomUUID()}.json`), { ...snapshot, posts,
              media: result.media.filter(m => posts.some(post => post.attachments?.media_keys?.includes(m.media_key))) });
          }
          const path = join(root, "creators.json");
          await atomic(path, mergeCreatorCache(await json<CreatorCache>(path, {}), result.creators));
          report.withheld += affected.filter(item => state[item.id].status === "withheld").length;
          return;
        }
        for (const item of matched) {
          verified.add(item.id);
          state[item.id] = { checkedAt: now, status: "ready", revision: item.source.revision, checkedBy: recheck.provider ?? "twitterapi" };
        }
        // A changed or unknown source cannot keep an older ready record if the
        // official fallback is unavailable or over budget. Omission never deletes it.
        for (const item of unresolved) state[item.id] = { checkedAt: now, status: "withheld", checkedBy: recheck.provider ?? "twitterapi" };
        await atomic(join(root, "x-availability", "state.json"), stateSchema.parse(state));
      },
    });
    due = due.filter(item => !verified.has(item.id));
    if (report.recheck.requests) report.status = report.recheck.status;
  }
  if (thirdParty) return { state, report: { ...report, status: report.recheck?.status ?? "not-configured" } };
  if (ledger.some(attempt => attempt.state !== "completed") || ledger.length >= maxRequests)
    return { state, report: { ...report, status: "daily-limit" } };
  while (due.length && ledger.length < maxRequests) {
    const batch: typeof due = [], required = new Set<string>();
    const protectedBatch = protectedIDs.has(due[0].id);
    while (due.length) {
      if (protectedIDs.has(due[0].id) !== protectedBatch) break;
      const next = nativeXPostIDs(due[0]);
      if (new Set([...required, ...next]).size > 100) break;
      const item = due.shift()!; batch.push(item); next.forEach(id => required.add(id));
    }
    const ids = [...required];
    const attempt: z.infer<typeof ledgerSchema>[number] = { ids, state: "reserved", at: now };
    ledger.push(attempt); await atomic(ledgerPath, ledger); report.requests++;
    try {
      const result = await (options.lookup ?? checkXAvailability)(options.bearer!, ids, protectedBatch ? "maintenance" : "growth");
      const name = `${day}-check-${String(ledger.length).padStart(3, "0")}.json`;
      const snapshot = { capturedAt: now, ...result };
      const refreshed = convertXDiscovery([{ name, data: snapshot }], {}, excerpts).candidates;
      // Also refresh already-known single posts covered by a dependency lookup.
      // Even partial dependency checks withhold a thread until its entire chain is verified.
      // Otherwise a refreshed root could leave an older approved reply visible.
      const affected = intake.candidates.filter(item => nativeXPostIDs(item).some(id => ids.includes(id)));
      for (const item of affected) {
        const rootID = item.source.context?.[0].id;
        const missing = nativeXPostIDs(item).some(id => result.unavailable.includes(id));
        const complete = nativeXPostIDs(item).every(id => ids.includes(id));
        const candidate = missing || !complete ? undefined : rootID ? convertXThread(snapshot, rootID).candidates.find(value => value.id === item.id)
          : refreshed.find(value => value.id === item.id);
        state[item.id] = { checkedAt: now, status: candidate?.source.revision ? "ready" : "withheld", checkedBy: "official",
          ...(nativeXPostIDs(item).some(id => result.unavailable.includes(id)) ? { removed: true } : {}),
          ...(candidate?.source.revision ? { revision: candidate.source.revision } : {}) };
      }
      await atomic(join(root, "x-availability", "state.json"), stateSchema.parse(state));
      for (const item of affected) if (item.source.context && (nativeXPostIDs(item).every(id => ids.includes(id)) ||
        nativeXPostIDs(item).some(id => result.unavailable.includes(id)))) {
        await atomic(join(root, "x-replies", "checks", `${item.id}.json`), { rootID: item.source.context[0].id, snapshot });
      }
      await atomic(join(root, "x-discovery", name), snapshot);
      const creatorsPath = join(root, "creators.json");
      await atomic(creatorsPath, mergeCreatorCache(await json<CreatorCache>(creatorsPath, {}), result.creators));
      attempt.state = "completed"; report.status = "checked"; report.checked += ids.length; report.withheld += batch.filter(item => state[item.id].status === "withheld").length;
      await atomic(ledgerPath, ledger);
    } catch (error) {
      if (error instanceof XBudgetExceeded) {
        ledger.pop(); await atomic(ledgerPath, ledger); report.requests--; report.status = "budget-limited"; break;
      }
      attempt.state = "failed"; await atomic(ledgerPath, ledger); report.status = "failed"; break;
    }
  }
  return { state, report };
}
