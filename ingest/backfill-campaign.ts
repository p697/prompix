import { z } from "zod";

const quotaSchema = z.object({ observedAt: z.iso.datetime(), ordinaryUsageAllowed: z.literal(true),
  weeklyUsedPercent: z.number().min(0).max(100), source: z.literal("codex-account-rate-limits") }).strict();
const quotaGrantSchema = z.object({ version: z.literal(1), run: z.string().min(1),
  stageID: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), authorizedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  stopAtPercent: z.literal(95) }).strict();
export type SubscriptionGrantContext = { grant: unknown; run: string; stageID: string | null };
/** A private, expiring user grant applies to one stage; the default remains90. */
export function subscriptionStopPercent(context?: SubscriptionGrantContext, now = Date.now()): number {
  if (!context || context.grant == null) return 90;
  const grant = quotaGrantSchema.parse(context.grant);
  const start = Date.parse(grant.authorizedAt), end = Date.parse(grant.expiresAt);
  if (grant.run !== context.run || grant.stageID !== context.stageID || start > now || end <= now
    || end <= start || end - start > 7 * 24 * 3600_000)
    throw new Error("Subscription grant is expired or does not match this stage");
  return grant.stopAtPercent;
}
/** Account-wide samples are admission signals, not per-job billing measurements. */
export function assertSubscriptionSnapshot(raw: unknown, now = Date.now(), context?: SubscriptionGrantContext): void {
  const snapshot = quotaSchema.parse(raw), age = now - Date.parse(snapshot.observedAt);
  const stopAt = subscriptionStopPercent(context, now);
  if (age < 0 || age > 65 * 60_000 || snapshot.weeklyUsedPercent >= stopAt)
    throw new Error(`Subscription quota requires a fresh ordinary-usage check below ${stopAt}%; no new request authorized`);
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


const continuationSchema = z.object({ version: z.literal(1), run: z.string().min(1), authorizedAt: z.iso.datetime(),
  newReadyAtStart: z.number().int().nonnegative(), additionalQualified: z.literal(1000),
  observedQualifiedTotal: z.number().int().positive(), evidencePath: z.string().min(1) }).strict();
/** A later user-approved bounded increment replaces, rather than enables, the old10000 goal. */
export function continuationTarget(raw: unknown, run: string, baselineCount: number, seedCount: number, startedAt: string, now = Date.now()): number | null {
  if (raw === null) return null;
  const grant = continuationSchema.parse(raw), at = Date.parse(grant.authorizedAt);
  const target = baselineCount + seedCount + grant.newReadyAtStart + grant.additionalQualified;
  if (grant.run !== run || at < Date.parse(startedAt) || at > now || !Number.isInteger(target) || target > 10000)
    throw new Error("Invalid bounded campaign continuation");
  return target;
}
