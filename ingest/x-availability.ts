import { join } from "node:path";
import { z } from "zod";
import type { Catalog, Prompt } from "../packages/schema/catalog.ts";
import { atomic, json } from "./publication.ts";
import { checkXAvailability } from "./x.ts";
import { convertXDiscovery, readXIntake } from "./x-intake.ts";
import { isNativeXDraft, nativeXSourceIssue } from "./x-source.ts";
import { mergeCreatorCache, type CreatorCache } from "./creators.ts";

const recordSchema = z.object({ checkedAt: z.iso.datetime(), status: z.enum(["ready", "withheld"]),
  removed: z.boolean().optional(), revision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const stateSchema = z.record(z.string().regex(/^x-post-\d{1,19}$/), recordSchema);
const ledgerSchema = z.array(z.object({ ids: z.array(z.string().regex(/^\d{1,19}$/)).min(1).max(100),
  state: z.enum(["reserved", "completed", "failed"]), at: z.iso.datetime() }).strict()).max(2);
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
    item = { ...item, source: { ...item.source, post: { ...post, checkedAt: record.checkedAt } } };
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
/** Separate bounded maintenance budget: at most two requests / 200 posts per UTC day. No automatic retries. Caller holds daily.lock. */
export async function prepareXAvailability(root: string, options: { enabled: boolean; bearer?: string; now?: string;
  lookup?: typeof checkXAvailability } ) {
  const now = options.now ?? new Date().toISOString(), nowMS = Date.parse(now), day = now.slice(0, 10);
  if (!Number.isFinite(nowMS)) throw new Error("Invalid X availability time");
  const state = await readXAvailability(root);
  const report = { status: "cached", requests: 0, checked: 0, withheld: 0 };
  if (!options.enabled || !options.bearer) return { state, report };
  const ledgerPath = join(root, "x-availability", `${day}.json`);
  const ledger = ledgerSchema.parse(await json(ledgerPath, []));
  if (ledger.some(attempt => attempt.state !== "completed") || ledger.length >= 2) return { state, report: { ...report, status: "daily-limit" } };
  const intake = await readXIntake(root);
  const due = intake.candidates.filter(item => {
    const checked = Math.max(Date.parse(item.source.post?.checkedAt ?? "") || 0, Date.parse(state[item.id]?.checkedAt ?? "") || 0);
    return !state[item.id] || state[item.id].revision !== item.source.revision || nowMS - checked >= 12 * 3600_000;
  }).sort((a, b) => Date.parse(a.source.post?.checkedAt ?? "1970-01-01") - Date.parse(b.source.post?.checkedAt ?? "1970-01-01"));
  while (due.length && ledger.length < 2) {
    const batch = due.splice(0, 100), ids = batch.map(item => item.id.slice("x-post-".length));
    const attempt: z.infer<typeof ledgerSchema>[number] = { ids, state: "reserved", at: now };
    ledger.push(attempt); await atomic(ledgerPath, ledger); report.requests++;
    try {
      const result = await (options.lookup ?? checkXAvailability)(options.bearer, ids);
      const name = `${day}-check-${String(ledger.length).padStart(3, "0")}.json`;
      const snapshot = { capturedAt: now, ...result };
      const refreshed = convertXDiscovery([{ name, data: snapshot }]).candidates;
      // Persist withdrawals first, before a snapshot write could fail.
      for (const id of ids) {
        const candidate = refreshed.find(item => item.id === `x-post-${id}`);
        state[`x-post-${id}`] = { checkedAt: now, status: candidate?.source.revision ? "ready" : "withheld",
          ...(result.unavailable.includes(id) ? { removed: true } : {}),
          ...(candidate?.source.revision ? { revision: candidate.source.revision } : {}) };
      }
      await atomic(join(root, "x-availability", "state.json"), stateSchema.parse(state));
      await atomic(join(root, "x-discovery", name), snapshot);
      const creatorsPath = join(root, "creators.json");
      await atomic(creatorsPath, mergeCreatorCache(await json<CreatorCache>(creatorsPath, {}), result.creators));
      attempt.state = "completed"; report.status = "checked"; report.checked += ids.length; report.withheld += ids.filter(id => state[`x-post-${id}`].status === "withheld").length;
      await atomic(ledgerPath, ledger);
    } catch {
      attempt.state = "failed"; await atomic(ledgerPath, ledger); report.status = "failed"; break;
    }
  }
  return { state, report };
}
