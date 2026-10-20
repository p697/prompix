import { join } from "node:path";
import { lockContent } from "./publication.ts";
import { readXIntake } from "./x-intake.ts";
import { adoptFreshXDiscoveries } from "./x-availability.ts";
import { readHistoryAvailability } from "./history-freshness.ts";

const pending = new Map<string, Promise<unknown>>();
/** Reuse exact retained third-party acquisitions, without renewing time or calling a provider. */
export function adoptHistoryDiscoveries(directory: string, root: string, shared: string, now = Date.now()) {
  // Three queue workers share a controller. Serialize their short local writes;
  // the filesystem lock still rejects a competing process/operator.
  const operation = (pending.get(root) ?? Promise.resolve()).then(() => adopt(directory, root, shared, now));
  const settled = operation.then(() => {}, () => {});
  pending.set(root, settled);
  void settled.then(() => { if (pending.get(root) === settled) pending.delete(root); });
  return operation;
}
async function adopt(directory: string, root: string, shared: string, now: number) {
  const evidenceRoot = join(root, "source-discovery-evidence");
  const unlock = await lockContent(evidenceRoot);
  try {
    const intake = await readXIntake(directory);
    const candidates = intake.candidates.filter(item => ["twitterapi", "rapidapi"].includes(item.source.acquiredVia ?? ""));
    return await adoptFreshXDiscoveries(evidenceRoot, candidates, await readHistoryAvailability(root, shared), now);
  } finally { await unlock(); }
}
