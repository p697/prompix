import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Candidate } from "./sources.ts";
import { nativeXPostIDs } from "./x-source.ts";
import { atomic } from "./publication.ts";
import { configuredXSpendBudget, maintenanceReserveSchema, maintenanceRunway } from "./x-spend.ts";

/** Called under daily.lock before maintenance or growth. Only immutable numeric
 * identities determine the cost census; no source text enters the budget directory. */
export function maintenanceCensus(items: readonly Candidate[], protectedIDs: ReadonlySet<string>, inactiveIDs: ReadonlySet<string>, now: Date,
  hybrid: boolean) {
  const expected = [...protectedIDs].filter(id => /^x-post-\d{1,19}$/.test(id) && !inactiveIDs.has(id));
  const expectedSet = new Set(expected);
  const protectedItems = items.filter(item => expectedSet.has(item.id));
  // Match the maintenance router: even a standalone root belonging to an unapproved
  // thread is checked officially, so it cannot be priced as a cheap standalone.
  const threadIDs = new Set(items.filter(item => item.source.context).flatMap(nativeXPostIDs));
  const official = new Set(protectedItems.filter(item => !hybrid || threadIDs.has(item.source.post?.id ?? "") || item.source.post?.parentID || item.source.mediaPostID).flatMap(nativeXPostIDs));
  const standalone = new Set(protectedItems.flatMap(nativeXPostIDs).filter(id => !official.has(id)));
  const present = new Set(protectedItems.filter(item => nativeXPostIDs(item).length > 0).map(item => item.id));
  const missing = expected.filter(id => !present.has(id));
  const plan = maintenanceReserveSchema.parse({ version: 1, checkedAt: now.toISOString(), complete: missing.length === 0,
    standalone: standalone.size, officialPosts: official.size,
    sourceSetSHA256: createHash("sha256").update(JSON.stringify({ expected: expected.sort(), standalone: [...standalone].sort(), official: [...official].sort() })).digest("hex") });
  return { plan, missing, runway: maintenanceRunway(plan, now) };
}

export async function saveMaintenanceCensus(items: readonly Candidate[], protectedIDs: ReadonlySet<string>, inactiveIDs: ReadonlySet<string>, now: Date,
  hasPublishedHistory: boolean, environment: NodeJS.ProcessEnv = process.env) {
  const budget = configuredXSpendBudget(environment);
  if (!budget?.protectMaintenance) return;
  const hybrid = ["twitterapi", "rapidapi"].includes(environment.PROMPIX_X_RECHECK_PROVIDER ?? "");
  const result = maintenanceCensus(items, protectedIDs, inactiveIDs, now, hybrid);
  result.plan.complete &&= hasPublishedHistory;
  // Atomic replacement cannot expose a partial census to another guarded reader.
  // Spending stays serialized by the original ledger lock and format.
  await atomic(join(budget.root, "maintenance-reserve.json"), result.plan);
  return { ...result.plan, missingSources: result.missing.length, runwayUSD: result.runway.monthly / 1e6,
    dailyHeadroomUSD: result.runway.daily / 1e6, remainingDays: result.runway.days };
}
