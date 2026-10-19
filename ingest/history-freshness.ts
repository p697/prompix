import type { Prompt } from '../packages/schema/catalog.ts';
import { filterXAvailability, type XAvailabilityState } from './x-availability.ts';

/** Apply separately retained exact-source rechecks; never mutate frozen originals. */
export function checkedHistorySeeds(items: readonly Prompt[], state: XAvailabilityState, now = Date.now()): Prompt[] {
  return items.flatMap(item => {
    const check = state[item.id];
    if (!check) return [item];
    if (check.checkedBy !== 'twitterapi' && check.checkedBy !== 'rapidapi') return [];
    return filterXAvailability([item], state, now).prompts;
  });
}
