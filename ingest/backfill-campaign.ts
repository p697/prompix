import { z } from "zod";

const quotaSchema = z.object({ observedAt: z.iso.datetime(), ordinaryUsageAllowed: z.literal(true),
  weeklyUsedPercent: z.number().min(0).max(100), source: z.literal("codex-account-rate-limits") }).strict();
/** Account-wide samples are admission signals, not per-job billing measurements. */
export function assertSubscriptionSnapshot(raw: unknown, now = Date.now()): void {
  const snapshot = quotaSchema.parse(raw), age = now - Date.parse(snapshot.observedAt);
  if (age < 0 || age > 65 * 60_000 || snapshot.weeklyUsedPercent >= 90)
    throw new Error("Subscription quota requires a fresh ordinary-usage check with at least 10% headroom; no new request authorized");
}
const expansionSchema = z.object({ version: z.literal(1), target: z.literal(10000), reviewedAt: z.iso.datetime(),
  qualifiedTotal: z.number().int().min(2000), reviewedIDs: z.array(z.string().min(1)).min(50),
  unresolvedBlockingIssues: z.literal(0), sharedAccountedUSD: z.number().nonnegative().lt(100),
  projectedTotalUSD: z.number().nonnegative().max(100), ordinaryQuotaVerified: z.literal(true),
  evidencePath: z.string().min(1) }).strict();
/** Written by the owner after checking the milestone; the collector cannot self-approve its output. */
export function campaignTarget(raw: unknown, startedAt: string, now = Date.now()): 2000 | 10000 {
  if (raw === null) return 2000;
  const audit = expansionSchema.parse(raw), at = Date.parse(audit.reviewedAt);
  if (at < Date.parse(startedAt) || at > now || now - at > 72 * 3600_000 || new Set(audit.reviewedIDs).size !== audit.reviewedIDs.length)
    throw new Error("Expansion requires current, distinct milestone review evidence");
  return 10000;
}
