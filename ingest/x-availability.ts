import { readAllXIntake, convertXThread } from "./x-thread-intake.ts";
import { join } from "node:path";
import { z } from "zod";
import type { Catalog, Prompt } from "../packages/schema/catalog.ts";
import { atomic, json } from "./publication.ts";
import { checkXAvailability } from "./x.ts";
import { convertXDiscovery } from "./x-intake.ts";
import { isNativeXDraft, nativeXSourceIssue, nativeXPostIDs } from "./x-source.ts";
import { mergeCreatorCache, type CreatorCache } from "./creators.ts";

const recordSchema = z.object({ checkedAt: z.iso.datetime(), status: z.enum(["ready", "withheld"]),
  removed: z.boolean().optional(), revision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const stateSchema = z.record(z.string().regex(/^x-post-\d{1,19}$/), recordSchema);
const ledgerSchema = z.array(z.object({ ids: z.array(z.string().regex(/^\d{1,19}$/)).min(1).max(100),
  state: z.enum(["reserved", "completed", "failed"]), at: z.iso.datetime() }).strict()).max(4);
export type XAvailabilityState = z.infer<typeof stateSchema>;
export async function readXAvailability(root: string): Promise<XAvailabilityState> {
  return stateSchema.parse(await json(join(root, "x-availability", "state.json"), {}));
}
/** Rechecks refresh a matching source only; changed or withdrawn posts cannot be resurrected by retention. */
export function filterXAvailability<T extends Prompt>(items: readonly T[], state: XAvailabilityState, now = Date.now()) {
  const withheldIDs: string[] = [];
  const prompts = items.flatMap(item => {
    if (!isNativeXDraft(item)) return [item];
    const record = state[item.id], post = item.source.post;
    if (!post || record?.status !== "ready" || record.revision !== item.source.revision) { withheldIDs.push(item.id); return []; }
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
/** Separate maintenance budget: default two requests, bounded to four / 400 posts per UTC day. No automatic retries. Caller holds daily.lock. */
export async function prepareXAvailability(root: string, options: { enabled: boolean; bearer?: string; now?: string;
  lookup?: typeof checkXAvailability; maxRequests?: number } ) {
  const now = options.now ?? new Date().toISOString(), nowMS = Date.parse(now), day = now.slice(0, 10);
  if (!Number.isFinite(nowMS)) throw new Error("Invalid X availability time");
  const maxRequests = options.maxRequests ?? Number(process.env.PROMPIX_X_AVAILABILITY_MAX_REQUESTS ?? 2);
  if (!Number.isInteger(maxRequests) || maxRequests < 0 || maxRequests > 4) throw new Error("Invalid X availability budget");
  const state = await readXAvailability(root);
  const report = { status: "cached", requests: 0, checked: 0, withheld: 0 };
  if (!options.enabled || !options.bearer) return { state, report };
  const ledgerPath = join(root, "x-availability", `${day}.json`);
  const ledger = ledgerSchema.parse(await json(ledgerPath, []));
  if (ledger.some(attempt => attempt.state !== "completed") || ledger.length >= maxRequests) return { state, report: { ...report, status: "daily-limit" } };
  const intake = await readAllXIntake(root);
  const due = intake.candidates.filter(item => {
    const checked = Math.max(Date.parse(item.source.post?.checkedAt ?? "") || 0, Date.parse(state[item.id]?.checkedAt ?? "") || 0);
    const record = state[item.id];
    if (record?.removed) return false;
    return !record || (record.status === "ready" && record.revision !== item.source.revision) || nowMS - checked >= 12 * 3600_000;
  }).sort((a, b) => Date.parse(a.source.post?.checkedAt ?? "1970-01-01") - Date.parse(b.source.post?.checkedAt ?? "1970-01-01"));
  while (due.length && ledger.length < maxRequests) {
    const batch: typeof due = [], required = new Set<string>();
    while (due.length) {
      const next = nativeXPostIDs(due[0]);
      if (new Set([...required, ...next]).size > 100) break;
      const item = due.shift()!; batch.push(item); next.forEach(id => required.add(id));
    }
    const ids = [...required];
    const attempt: z.infer<typeof ledgerSchema>[number] = { ids, state: "reserved", at: now };
    ledger.push(attempt); await atomic(ledgerPath, ledger); report.requests++;
    try {
      const result = await (options.lookup ?? checkXAvailability)(options.bearer, ids);
      const name = `${day}-check-${String(ledger.length).padStart(3, "0")}.json`;
      const snapshot = { capturedAt: now, ...result };
      const refreshed = convertXDiscovery([{ name, data: snapshot }]).candidates;
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
        state[item.id] = { checkedAt: now, status: candidate?.source.revision ? "ready" : "withheld",
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
    } catch {
      attempt.state = "failed"; await atomic(ledgerPath, ledger); report.status = "failed"; break;
    }
  }
  return { state, report };
}
