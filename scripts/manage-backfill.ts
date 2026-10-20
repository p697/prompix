/** Operator entrypoint: pause/status or authorize a fresh bounded stage; never starts workers. */
import { resolve, join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { atomic, json, lockContent, writeImmutableBytes } from "../ingest/publication.ts";
import { StageQueue } from "../ingest/stage-queue.ts";
import { queueDatabase } from "../ingest/queue-database.ts";
import { historyBaseline } from "../ingest/history-cohort.ts";
import { campaignInventory } from "../ingest/campaign-inventory.ts";
import { activateCampaignStage, boundedStageTarget, readCampaignStage } from "../ingest/campaign-stage.ts";
import { assertSubscriptionSnapshot } from "../ingest/backfill-campaign.ts";
import type { Prompt } from "../packages/schema/catalog.ts";
process.umask(0o077);
const [command, path, id, amount] = process.argv.slice(2);
if (!path || !isAbsolute(path) || !["status", "pause", "authorize-stage"].includes(command))
  throw Error("Usage: manage-backfill status|pause /absolute/campaign OR authorize-stage /absolute/campaign stage-id additional-count");
const root = resolve(path), now = new Date().toISOString();
if (command === "status") {
  const progress = await json<Record<string, unknown>>(join(root, "progress.json"), {});
  const owner = await json<{ pid?: number }>(join(root, "daily.lock", "owner.json"), {});
  let alive = false;
  if (owner.pid) { try { process.kill(owner.pid, 0); alive = true; } catch {} }
  console.log(JSON.stringify({ progress, pause: await json(join(root, "pause.json"), null), lockOwnerPID: owner.pid ?? null, alive,
    activeStage: await readCampaignStage(root) }));
} else if (command === "pause") {
  await atomic(join(root, "pause.json"), { at: now, reason: "Operator requested drain; explicit future resume required" });
  console.log(JSON.stringify({ requested: "pause", note: "Wait for controller exit and zero leases; in-flight calls are not cancelled." }));
} else {
  if (!id || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id) || !/^[1-9][0-9]*$/.test(amount ?? "") || Number(amount) > 10000)
    throw Error("A new stage ID and integer increment1..10000 are required");
  const unlock = await lockContent(root);
  try {
    if (!await json(join(root, "pause.json"), null)) throw Error("Pause and drain the campaign before freezing a new stage");
    const config = await json<any>(join(root, "configuration.json"), null);
    assertSubscriptionSnapshot(await json(join(root, "subscription-quota.json"), null), Date.now(), {
      grant: await json(join(root, "subscription-grants", id + ".json"), null), run: config.run, stageID: id,
    });
    const queue = new StageQueue(queueDatabase());
    if ((await queue.counts(config.run)).some(c => c.state === "leased" && Number(c.count) > 0)) throw Error("Active leases must drain before freezing a stage");
    const baseline = historyBaseline(await json(config.baseline, null));
    const originalSeed = await json<Prompt[]>(config.seed, []);
    if (baseline.prompts.length !== config.baselineCount || originalSeed.length !== config.seedCount) throw Error("Frozen campaign baseline changed");
    const inventory = await campaignInventory(queue, root, config.sharedRoot, config.run, baseline.prompts, originalSeed);
    if (inventory.unresolvedSeeds.length) throw Error("Seed freshness or quality requires inspection");
    const evidencePath = join(root, "stage-evidence", id + ".json");
    const bytes = Buffer.from(JSON.stringify({ at: now, run: config.run, baselineCount: config.baselineCount,
      seedIDs: inventory.seed.map(p => p.id), readyIDs: inventory.ready.map(p => p.id),
      countsExcludeLiveHoldsAndRemovals: true }) + "\n");
    const stage = { version: 1 as const, id, run: config.run, authorizedAt: now, baselineCount: config.baselineCount,
      seedReadyAtStart: inventory.seed.length, newReadyAtStart: inventory.ready.length, additionalQualified: Number(amount),
      evidencePath, evidenceSHA256: createHash("sha256").update(bytes).digest("hex") };
    const target = boundedStageTarget(stage, config.run, config.baselineCount, config.createdAt);
    await writeImmutableBytes(evidencePath, bytes);
    await activateCampaignStage(root, stage);
    console.log(JSON.stringify({ stage, target, paused: true, note: "No collection started. Inspect budget, isolation and quota, then explicitly remove pause.json and launch the durable runtime." }));
  } finally { await unlock(); }
}
