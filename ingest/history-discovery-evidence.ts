import { join } from "node:path";
import { lockContent } from "./publication.ts";
import { readXIntake } from "./x-intake.ts";
import { adoptFreshXDiscoveries } from "./x-availability.ts";
import { readHistoryAvailability } from "./history-freshness.ts";

/** Reuse exact retained third-party acquisitions, without renewing time or calling a provider. */
export async function adoptHistoryDiscoveries(directory: string, root: string, shared: string, now = Date.now()) {
  const evidenceRoot = join(root, "source-discovery-evidence");
  const unlock = await lockContent(evidenceRoot);
  try {
    const intake = await readXIntake(directory);
    const candidates = intake.candidates.filter(item => ["twitterapi", "rapidapi"].includes(item.source.acquiredVia ?? ""));
    return await adoptFreshXDiscoveries(evidenceRoot, candidates, await readHistoryAvailability(root, shared), now);
  } finally { await unlock(); }
}
