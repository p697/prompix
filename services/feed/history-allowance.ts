import { z } from "zod";

/** Explicit, expiring operator authorization for a frozen historical inventory.
 * Never accepted from the public feed API. Ordinary publication keeps its daily cap. */
export const historyAllowanceSchema = z.object({
  version: z.literal(1), id: z.string().regex(/^[a-z0-9-]{1,100}$/),
  approvedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  contentIDs: z.array(z.string().regex(/^x-post-\d{1,19}$/)).min(1).max(10000),
}).strict().refine(v => new Set(v.contentIDs).size === v.contentIDs.length &&
  Date.parse(v.expiresAt) > Date.parse(v.approvedAt) && Date.parse(v.expiresAt) - Date.parse(v.approvedAt) <= 48 * 3600_000);
export type HistoryAllowance = z.infer<typeof historyAllowanceSchema>;
export function historyAllowanceIDs(input?: HistoryAllowance, now = Date.now()): string[] {
  if (!input) return [];
  const value = historyAllowanceSchema.parse(input);
  if (Date.parse(value.approvedAt) > now || Date.parse(value.expiresAt) <= now) throw new Error("Historical publication authorization expired or not yet valid");
  return value.contentIDs;
}
