/** Four cumulative UTC windows align with the existing 02/08/14/20 JST schedule.
 * Unused capacity carries forward; retries share the persisted daily ledger. */
export function windowBudget(dailyLimit: number, now: Date): number {
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 0 || !Number.isFinite(now.getTime())) throw new Error("Invalid discovery budget");
  return Math.floor(dailyLimit * (Math.floor(now.getUTCHours() / 6) + 1) / 4);
}
