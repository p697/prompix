import { z } from "zod";

const day = 86_400_000;
/** Explicit receipt bounds. Never infer a renewal from a new UTC month. */
export const rapidAPICycleTermsSchema = z.object({
  provider: z.literal("twitter241"), feeReservationID: z.string().uuid(),
  feeMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  startsAt: z.iso.datetime(), endsAt: z.iso.datetime(), stopAt: z.iso.datetime(),
  requestLimit: z.literal(1000),
}).strict().refine(t => {
  const start = Date.parse(t.startsAt), end = Date.parse(t.endsAt), stop = Date.parse(t.stopAt);
  return end > start && end - start <= 32 * day && stop > start && stop <= end;
}, "Invalid RapidAPI subscription interval");
export type RapidAPICycleTerms = z.infer<typeof rapidAPICycleTermsSchema>;

export const rapidAPICycleSchema = z.object({
  version: z.literal(1), terms: rapidAPICycleTermsSchema,
  observedAt: z.iso.datetime(),
  // This high-water mark includes all uncertain/reserved local attempts, even if
  // the dashboard reports fewer. An observation can never return spent credits.
  usedFloor: z.number().int().min(0).max(100_000),
  anchoredAttemptIDs: z.array(z.string().uuid()).max(100_000),
}).strict().refine(s => new Set(s.anchoredAttemptIDs).size === s.anchoredAttemptIDs.length &&
  s.usedFloor >= s.anchoredAttemptIDs.length && Date.parse(s.observedAt) >= Date.parse(s.terms.startsAt) &&
  Date.parse(s.observedAt) < Date.parse(s.terms.stopAt), "Invalid RapidAPI quota observation");
export type RapidAPICycle = z.infer<typeof rapidAPICycleSchema>;

/** Calendar ledgers may span three months for a 32-day interval near month end. */
export function rapidAPICycleMonths(terms: RapidAPICycleTerms) {
  const months = new Set([terms.feeMonth]);
  const cursor = new Date(terms.startsAt);
  cursor.setUTCDate(1); cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() < Date.parse(terms.endsAt)) {
    months.add(cursor.toISOString().slice(0, 7)); cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return [...months].sort();
}

export function rapidAPICycleUsage(cycle: RapidAPICycle, attemptIDs: readonly string[], now: Date) {
  const ids = new Set(attemptIDs);
  if (ids.size !== attemptIDs.length || cycle.anchoredAttemptIDs.some(id => !ids.has(id)))
    throw new Error("RapidAPI cycle attempts disappeared or conflict; no request sent");
  if (now.getTime() < Date.parse(cycle.observedAt)) throw new Error("RapidAPI cycle clock moved backwards; no request sent");
  const used = cycle.usedFloor + ids.size - cycle.anchoredAttemptIDs.length;
  return { used, remaining: Math.max(0, cycle.terms.requestLimit - used) };
}

/** Protect two complete 200-ID scans/day through the explicitly authorized end.
 * This is request headroom only; official dependencies retain their cash guard. */
export function rapidAPIRequestRunway(standalone: number, stopAt: string, now: Date) {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.max(0, Math.ceil((Date.parse(stopAt) - midnight) / day));
  return 2 * Math.ceil(standalone / 200) * days;
}
