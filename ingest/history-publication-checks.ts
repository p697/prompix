import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Prompt } from "../packages/schema/catalog.ts";
import { atomic } from "./publication.ts";
import { readHistoryAvailability } from "./history-freshness.ts";
import { readXAvailability, filterXAvailability } from "./x-availability.ts";
import { nativeXSourceDigest } from "./x-source.ts";

/** Caller holds the shared publication lock and supplies exact raw intake sources.
 * Transfer only current matching third-party evidence; never renew its timestamp. */
export async function adoptHistoryPublicationChecks(campaign: string, shared: string, sources: readonly Prompt[], now = Date.now()) {
  const current = await readXAvailability(shared);
  const merged = await readHistoryAvailability(campaign, shared);
  const next = { ...current };
  let adopted = 0;
  for (const item of sources) {
    const check = merged[item.id];
    if (current[item.id]?.removed || !check
      || Date.parse(check.checkedAt) > now
      || !["twitterapi", "rapidapi"].includes(check.checkedBy ?? "")
      || nativeXSourceDigest(item) !== item.source.revision
      || (check.status !== "withheld" && !check.removed && !filterXAvailability([item], merged, now).prompts.length)) continue;
    if (!isDeepStrictEqual(next[item.id], check)) {
      next[item.id] = check;
      adopted++;
    }
  }
  if (adopted) await atomic(join(shared, "x-availability/state.json"), next);
  return { state: next, adopted };
}
