/** One fresh visual source, no old request replay. Hold the same root lock as the controller. */
import { isAbsolute, join } from "node:path";
import { json, lockContent } from "../ingest/publication.ts";
import { StageQueue, workStage } from "../ingest/stage-queue.ts";
import { queueDatabase } from "../ingest/queue-database.ts";
import { processHistoryStage } from "../ingest/history-queue.ts";
import { inspectReviewFailure } from "../ingest/history-isolation.ts";
import { reserveReviewProbe, completeReviewProbe } from "../ingest/review-recovery.ts";
import { readCampaignStage } from "../ingest/campaign-stage.ts";
import { assertSubscriptionSnapshot } from "../ingest/backfill-campaign.ts";
import { configuredXSpendBudget } from "../ingest/x-spend.ts";
import { verifyReviewedHistory } from "../ingest/history-stage-verification.ts";
const [root, batch, mode] = process.argv.slice(2);
if (mode && mode !== "--finalize-retained") throw Error("Unknown recovery mode");
if (!root || !isAbsolute(root) || !/^batch-\d{4}$/.test(batch ?? "")) throw Error("Usage: probe-review-recovery /absolute/campaign batch-NNNN");
process.umask(0o077);
const unlock = await lockContent(root);
try {
  const config = await json<any>(join(root, "configuration.json"), null), stage = await readCampaignStage(root);
  const budget = configuredXSpendBudget();
  if (!config || !stage || stage.run !== config.run || !budget?.campaign || budget.campaign.totalUSD > 100 || process.env.PROMPIX_X_OFFICIAL_ENABLED !== "0") throw Error("Matching campaign budget and stage required");
  const campaign = budget.campaign;
  const check = async () => {
    if (await json(join(root, "pause.json"), null)) throw Error("Campaign paused");
    assertSubscriptionSnapshot(await json(join(root, "subscription-quota.json"), null), Date.now(), {
      grant: await json(join(root, "subscription-grants", stage.id + ".json"), null), run: config.run, stageID: stage.id });
    if (Date.now() >= Date.parse(campaign.expiresAt)) throw Error("Campaign budget expired");
  };
  await check();
  const manifest = await json<any>(join(root, config.run, batch, "manifest.json"), null);
  const prior = await json<string[]>(config.priorAssignments, []);
  if (!manifest || manifest.leads.some((lead: { id: string }) => prior.includes(lead.id))) throw Error("Probe source was previously attempted");
  const queue = new StageQueue(queueDatabase());
  const rows = (await queue.db.query("select id,stage,attempts,payload,output from prompix.queue_jobs where run_id=$1 and state='reconcile' order by id", [config.run])).rows;
  const proofs = await Promise.all(rows.map(row => inspectReviewFailure(root, config.run, row)));
  if (mode === "--finalize-retained") {
    const pointer = await json<any>(join(root, "review-recovery/active.json"), null);
    if (!pointer || pointer.stageID !== stage.id || !Number.isInteger(pointer.sequence) || pointer.sequence < 1 || pointer.sequence > 3) throw Error("No matching probe reservation");
    const retained = await json<any>(join(root, "review-recovery", stage.id, `attempt-${pointer.sequence}.json`), null);
    if (!retained || retained.batch !== batch || retained.run !== config.run) throw Error("Probe identity mismatch");
    await verifyReviewedHistory(join(root, config.run, batch), config.sharedRoot);
    console.log(JSON.stringify({ status: "probe-finalized-without-replay", receipt: await completeReviewProbe(queue, root, retained) }));
  } else {
    const probe = await reserveReviewProbe(queue, root, config.run, batch, proofs);
    console.log(JSON.stringify({ status: "probe-reserved", batch, sequence: probe.sequence }));
    for (const kind of ["collect", "review"] as const) {
      await check();
      if (!await workStage(queue, config.run, [kind], job => processHistoryStage(queue, root, config.sharedRoot, job, { beforeRequest: check }), `${config.run}:${batch}:${kind}`)) throw Error("Probe claim unavailable; reservation remains consumed");
    }
    await verifyReviewedHistory(join(root, config.run, batch), config.sharedRoot);
    console.log(JSON.stringify({ status: "probe-succeeded", receipt: await completeReviewProbe(queue, root, probe) }));
  }
} finally { await unlock(); }
