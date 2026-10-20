import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Prompt } from '../packages/schema/catalog.ts';
import { readXAvailability, filterXAvailability, type XAvailabilityState } from './x-availability.ts';

/** Apply separately retained exact-source rechecks; never mutate frozen originals. */
export function checkedHistorySeeds(items: readonly Prompt[], state: XAvailabilityState, now = Date.now()): Prompt[] {
  return items.flatMap(item => {
    const check = state[item.id];
    if (!check) return [item];
    if (check.checkedBy !== 'twitterapi' && check.checkedBy !== 'rapidapi') return [];
    return filterXAvailability([item], state, now).prompts;
  });
}

/** Explicit holds/removals and failed source rechecks reduce the count, not the target.
 * Unknown expiry or malformed content must still stop for inspection. */
export function unresolvedHistorySeeds(originals: readonly Prompt[], eligible: readonly Prompt[], state: XAvailabilityState, excludedIDs: ReadonlySet<string>): string[] {
  const accepted = new Set(eligible.map(item => item.id));
  return originals.filter(item => !accepted.has(item.id) && !excludedIDs.has(item.id) && state[item.id]?.status !== 'withheld').map(item => item.id);
}

/** Preserve the newest authoritative decision; equal-time contradictions fail closed. */
export function mergeHistoryAvailability(...states: XAvailabilityState[]): XAvailabilityState {
  const merged: XAvailabilityState = {};
  for (const state of states) for (const [id, check] of Object.entries(state)) {
    const previous = merged[id];
    if (previous && previous.checkedAt === check.checkedAt && !isDeepStrictEqual(previous, check))
      throw new Error("Conflicting history source checks");
    if (!previous || Date.parse(check.checkedAt) > Date.parse(previous.checkedAt)) merged[id] = check;
  }
  return merged;
}
export async function readHistoryAvailability(root: string, shared: string) {
  return mergeHistoryAvailability(...await Promise.all([readXAvailability(shared),
    readXAvailability(join(root, 'seed-revalidation')), readXAvailability(join(root, 'source-revalidation')),
    readXAvailability(join(root, 'source-discovery-evidence'))]));
}
/** Do not silently count an unexplained stale/mismatched ready record as a removal. */
export function refreshHistoryItems(items: readonly Prompt[], state: XAvailabilityState, now = Date.now()): Prompt[] {
  return items.flatMap(item => {
    const record = state[item.id];
    if (!record) return [item];
    if (record.status === 'withheld') return [];
    const fresh = checkedHistorySeeds([item], state, now);
    if (!fresh.length) throw new Error("History source recheck is stale or does not match retained evidence");
    return fresh;
  });
}
