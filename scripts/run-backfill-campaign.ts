/** Bounded historical campaign. Resumes durable stages; never activates a public release. */
import { join, resolve, isAbsolute } from "node:path";
import { readdir, appendFile } from "node:fs/promises";
import { z } from "zod";
import { atomic, json, lockContent, writeImmutableBytes } from "../ingest/publication.ts";
import { StageQueue, workStage } from "../ingest/stage-queue.ts";
import { queueDatabase } from "../ingest/queue-database.ts";
import { enqueueHistoryPipeline, exportQueueReady, processHistoryStage } from "../ingest/history-queue.ts";
import { historyBaseline, historyBatchSchema, historyLeadSchema, chooseHistoryLeads, uniqueHistoryItems, completeHistoryItem } from "../ingest/history-cohort.ts";
import { readQualityHolds, applyQualityHolds } from "../ingest/quality-holds.ts";
import { readTranslationReviews } from "../ingest/translation-review.ts";
import { hasRequiredTranslations, requiredIngestLocales } from "../ingest/ingest-language-policy.ts";
import { readXSearchPlan, runXSearchPlan, searchPlanSchema, searchPlanReadiness } from "../ingest/x-search-plan.ts";
import { selectXSearchLeads } from "../ingest/x-search-admission.ts";
import { TwitterAPIClient } from "../ingest/twitterapi.ts";
import { configuredXSpendBudget } from "../ingest/x-spend.ts";
import type { Prompt } from "../packages/schema/catalog.ts";

import { campaignTarget, continuationTarget, assertSubscriptionSnapshot } from "../ingest/backfill-campaign.ts";

const configSchema = z.object({ version: z.literal(1), run: z.string().regex(/^[a-z0-9-]{1,80}$/),
  targetTotal: z.literal(2000), maxTotal: z.literal(10000), sharedRoot: z.string(), baseline: z.string(), seed: z.string(), exclusions: z.string(),
  priorAssignments: z.string(), searchPlans: z.array(z.string()).min(1).max(12), extraLeads: z.string(), baselineCount: z.number().int().positive(),
  seedCount: z.number().int().nonnegative(), maximumSources: z.number().int().min(1).max(30000), maximumSearches: z.number().int().min(1).max(20000),
  maxInflightBatches: z.number().int().min(1).max(3), createdAt: z.iso.datetime(), budgetUSD: z.literal(100), priorSharedAccountedUSD: z.number().nonnegative() }).strict();
process.umask(0o077);
const root = resolve(process.argv[2] ?? "");
if (!isAbsolute(process.argv[2] ?? "")) throw new Error("Usage: run-backfill-campaign /external/campaign");
const config = configSchema.parse(await json(join(root, "configuration.json"), null));
const unlock = await lockContent(root), queue = new StageQueue(queueDatabase());
let stopping = false, failure: unknown, claimed = 0;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const stop = () => { stopping = true; };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
const workers: Promise<void>[] = [];
try {
  await writeImmutableBytes(join(root, "configuration.lock.json"), Buffer.from(JSON.stringify(config) + "\n"));
  const budget = configuredXSpendBudget();
  if (!budget || !budget.campaign || budget.campaign.totalUSD > config.budgetUSD || process.env.PROMPIX_X_OFFICIAL_ENABLED !== "0")
    throw new Error("Explicit bounded campaign budget and disabled official X are required");
  const baseline = historyBaseline(await json(config.baseline, null));
  const exclusions = historyBaseline(await json(config.exclusions, null));
  if (baseline.prompts.length !== config.baselineCount) throw new Error("Frozen baseline count changed");
  const originalSeed = await json<Prompt[]>(config.seed, []);
  if (originalSeed.length !== config.seedCount) throw new Error("Seed count changed");
  const previous = await json<Record<string, unknown>>(join(root, "progress.json"), {});
  const report: Record<string, unknown> = { ...previous, error: null, resumedAt: new Date().toISOString(), runtime: process.cwd(), pid: process.pid, publishedByCampaign: 0 };
  let lastSignature = "", ready: Prompt[] = [], seed: Prompt[] = [];
  const save = async (status: string, extra: Record<string, unknown> = {}) => {
    Object.assign(report, extra, { status, updatedAt: new Date().toISOString() }); await atomic(join(root, "progress.json"), report);
    const metric = { at: report.updatedAt, status, qualifiedTotal: report.qualifiedTotal, newReady: report.newReady, assigned: report.assigned, searches: report.searches, accountedUSD: report.sharedMonthAccountedUSD, incrementalUSD: report.incrementalAccountedUSD, elapsedSeconds: (Date.now() - Date.parse(config.createdAt)) / 1000 };
    await appendFile(join(root, "measurements.jsonl"), JSON.stringify(metric) + "\n");
    console.log(JSON.stringify(metric));
  };
  // A provider failure stops new work across all workers; healthy in-flight calls finish and retain evidence.
  const worker = async () => {
    while (!stopping && claimed < 3000) {
      try {
        assertSubscriptionSnapshot(await json(join(root, "subscription-quota.json"), null));
        const did = await workStage(queue, config.run, ["collect", "review", "translate", "semantic"], job => processHistoryStage(queue, root, config.sharedRoot, job, { beforeRequest: async () => assertSubscriptionSnapshot(await json(join(root, "subscription-quota.json"), null)) }));
        if (did) claimed++; else await sleep(5000);
      } catch (error) { failure = error; stopping = true; }
    }
  };
  const current = await queue.counts(config.run);
  if (current.some(row => row.state === "reconcile")) throw new Error("Existing uncertain jobs require evidence reconciliation before campaign resume");
  workers.push(worker(), worker(), worker());
  const started = Date.now();
  while (!stopping && Date.now() - started < 6 * 3600_000 && claimed < 3000) {
    if (await json(join(root, "pause.json"), null)) { await save("operator-paused"); break; }
    assertSubscriptionSnapshot(await json(join(root, "subscription-quota.json"), null));
    const counts = await queue.counts(config.run);
    const signature = JSON.stringify(counts);
    if (signature !== lastSignature) {
      const holds = await readQualityHolds(config.sharedRoot), moderation = await json<{ removedIDs: string[] }>(join(config.sharedRoot, "moderation.json"), { removedIDs: [] });
      const reviews = await readTranslationReviews(join(config.sharedRoot, "translations", "semantic-rejections.json"));
      seed = applyQualityHolds(originalSeed, holds).prompts.filter(p => !moderation.removedIDs.includes(p.id) && completeHistoryItem(p, Date.now(), requiredIngestLocales) && hasRequiredTranslations(p, reviews));
      ready = await exportQueueReady(queue, root, config.sharedRoot, config.run);
      ready = uniqueHistoryItems(ready, [...baseline.prompts, ...seed]);
      await atomic(join(root, "qualified-new.json"), [...seed, ...ready]);
      lastSignature = signature;
    }
    const names = (await readdir(join(root, config.run))).filter(n => /^batch-\d{4}$/.test(n)).sort();
    const manifests = await Promise.all(names.map(n => json(join(root, config.run, n, "manifest.json"), null).then(historyBatchSchema.parse)));
    const assigned = manifests.flatMap(m => m.leads.map(l => l.id));
    if (new Set(assigned).size !== assigned.length) throw new Error("Duplicate campaign source assignments");
    const prior = z.array(z.string()).parse(await json(config.priorAssignments, null));
    if (assigned.some(id => prior.includes(id))) throw new Error("Previously attempted source reassigned");
    const qualifiedTotal = baseline.prompts.length + seed.length + ready.length;
    const continuation = await json(join(root, "continuation.json"), null);
    const continuedTarget = continuationTarget(continuation, config.run, config.baselineCount, config.seedCount, config.createdAt);
    if (continuedTarget !== null) await writeImmutableBytes(join(root, "continuation.lock.json"), Buffer.from(JSON.stringify(continuation) + "\n"));
    const target = continuedTarget ?? campaignTarget(await json(join(root, "expansion-10000.json"), null), config.createdAt);
    const sourceLimit = Math.min(30000, config.maximumSources * Math.ceil(target / 2000));
    const searchLimit = Math.min(20000, config.maximumSearches * Math.ceil(target / 2000));
    const month = new Date().toISOString().slice(0, 7), spend = await json<any>(join(budget.root, month + ".json"), null);
    const accountedUSD = spend ? (spend.opening + spend.entries.reduce((n: number, e: any) => n + e.accounted, 0)) / 1e6 : null;
    await save("running", { target, baselineAtStart: baseline.prompts.length, seedReady: seed.length, newReady: ready.length, qualifiedTotal, assigned: assigned.length, queues: counts, sharedMonthAccountedUSD: accountedUSD,
      incrementalAccountedUSD: accountedUSD === null ? null : accountedUSD - config.priorSharedAccountedUSD, elapsedSecondsThisRun: (Date.now() - started) / 1000 });
    if (seed.length !== originalSeed.length) throw new Error("Seed quality or freshness changed; revalidate original evidence before counting it");
    if (qualifiedTotal >= target) { await save(continuedTarget !== null ? "milestone-continuation-owner-audit" : target === 2000 ? "milestone-2000-owner-audit" : "milestone-10000-final-audit", { milestoneAt: new Date().toISOString() }); break; }
    const pendingBatches = await queue.db.query<{ count: number }>("select count(distinct payload->>'batch')::int as count from prompix.queue_jobs where run_id=$1 and state in ('queued','leased','retry')", [config.run]);
    if (pendingBatches.rows[0].count >= config.maxInflightBatches) { await sleep(15000); continue; }
    if (assigned.length >= sourceLimit) throw new Error("Campaign source bound reached; inspect yield before authorizing more assignments");
    const scans = await Promise.all(config.searchPlans.map(async directory => {
      const plan = searchPlanSchema.parse(await json(join(directory, "plan.json"), null)), state = await readXSearchPlan(directory, plan), found = await selectXSearchLeads(directory, plan);
      return { directory, plan, state, leads: found.leads.map(l => ({ ...l, directory, planID: found.report.planID })) };
    }));
    const searches = scans.reduce((n, s) => n + s.state.state.attempts.length, 0);
    report.searches = searches;
    const leads = z.array(historyLeadSchema).parse(await json(config.extraLeads, []));
    for (let i = 0; scans.some(s => i < s.leads.length); i++) for (const scan of scans) if (scan.leads[i]) leads.push(scan.leads[i]);
    const used = new Set([...prior, ...assigned]);
    const chosen = chooseHistoryLeads(leads, used, Math.min(50, sourceLimit - assigned.length));
    if (chosen.length) {
      const manifest = historyBatchSchema.parse({ version: 1, id: `batch-${String(names.length + 1).padStart(4, "0")}`, createdAt: new Date().toISOString(), leads: chosen });
      await enqueueHistoryPipeline(queue, root, config.run, manifest, exclusions.prompts);
      continue;
    }
    if (searches >= searchLimit) throw new Error("Campaign search bound reached");
    const next = scans.filter(s => searchPlanReadiness(s.state) === "ready").sort((a, b) => a.state.state.attempts.length - b.state.state.attempts.length)[0];
    if (!next) {
      if (scans.some(s => searchPlanReadiness(s.state) === "backoff")) { await sleep(15000); continue; }
      throw new Error("No resumable search windows; retained failures require inspection");
    }
    const release = await lockContent(next.directory);
    let found;
    try { const client = new TwitterAPIClient(process.env.TWITTERAPI_IO_KEY ?? "", budget); found = await runXSearchPlan(next.directory, next.plan, { maxRequests: Math.min(10, searchLimit - searches), search: client.search.bind(client) }); }
    finally { await release(); }
    if (["failed", "unresolved", "budget-limit"].includes(found.status)) {
      const readiness = searchPlanReadiness(await readXSearchPlan(next.directory, next.plan));
      // A request at the invocation boundary can fail transiently after using its final slot.
      // Re-read captures before admitting a later invocation; never reset the three-attempt bound.
      if (found.status === "budget-limit" || !["ready", "backoff", "complete"].includes(readiness))
        throw new Error(`Campaign search ${found.status}; retained response must be inspected`);
    }
  }
  stopping = true; await Promise.all(workers);
  if (failure) throw failure;
  if (report.status === "running") await save("bounded-checkpoint");
} catch (error) {
  stopping = true; await Promise.all(workers);
  const prior = await json<Record<string, unknown>>(join(root, "progress.json"), {});
  await atomic(join(root, "progress.json"), { ...prior, status: "blocked", updatedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "Campaign failed" });
  throw error;
} finally { stopping = true; await unlock(); }
