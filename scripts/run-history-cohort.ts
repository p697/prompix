import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { catalogSchema, type Prompt } from "../packages/schema/catalog.ts";
import { atomic, json, lockContent, repo, writeImmutableBytes } from "../ingest/publication.ts";
import { historyBaseline, historyCatalogSchema, historyBatchSchema, historyLeadSchema, historyLimits, chooseHistoryLeads, currentHistoryAcceptance, historyPublicationExclusions } from "../ingest/history-cohort.ts";
import { readQualityHolds } from "../ingest/quality-holds.ts";
import { readTranslationReviews } from "../ingest/translation-review.ts";
import { runHistoryBatch } from "../ingest/history-batch.ts";
import { searchPlanSchema, readXSearchPlan, runXSearchPlan } from "../ingest/x-search-plan.ts";
import { selectXSearchLeads, type XSearchLead } from "../ingest/x-search-admission.ts";
import { configuredXSpendBudget } from "../ingest/x-spend.ts";
import { TwitterAPIClient } from "../ingest/twitterapi.ts";

process.umask(0o077);
const directory = resolve(process.argv[2] ?? "");
if (!isAbsolute(process.argv[2] ?? "") || process.argv.slice(3).some(a => a !== "--execute" && a !== "--one-batch"))
  throw new Error("Usage: tsx scripts/run-history-cohort.ts /external/cohort [--execute] [--one-batch]");
const configSchema = z.object({ version: z.literal(1), target: z.literal(500), maximumSources: z.literal(1500), maximumSearches: z.literal(750),
  baseline: z.string(), sharedRoot: z.string(), searchPlans: z.array(z.string()).min(1).max(4), seedTranslations: z.string().optional(), extraLeads: z.string().optional() }).strict();
const config = configSchema.parse(await json(join(directory, "configuration.json"), null));
for (const path of [directory, config.baseline, config.sharedRoot, ...config.searchPlans, ...(config.seedTranslations ? [config.seedTranslations] : []), ...(config.extraLeads ? [config.extraLeads] : [])]) {
  const rel = relative(await realpath(repo), await realpath(path));
  if (!isAbsolute(path) || !rel || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("Historical data must remain outside Git");
}
// Preserve exact input configuration before any model call, network request or further assignment.
const unlock = await lockContent(directory);
try {
  await writeImmutableBytes(join(directory, "configuration.lock.json"), Buffer.from(JSON.stringify(config) + "\n"));
  const baseline = historyBaseline(JSON.parse(await readFile(config.baseline, "utf8")));
  const budget = configuredXSpendBudget();
  if (!budget || budget.monthlyUSD > 20) throw new Error("History must use the existing shared monthly budget, at most $20");
  const execute = process.argv.includes("--execute");
  const report: Record<string, unknown> = await json(join(directory, "progress.json"), { startedAt: new Date().toISOString(), staged: 0, published: 0 });
  if (execute && report.error) {
    report.priorErrors = [...(Array.isArray(report.priorErrors) ? report.priorErrors : []), { at: report.updatedAt, error: report.error }];
    delete report.error;
  }
  const save = async (status: string, extra: Record<string, unknown> = {}) => {
    Object.assign(report, extra, { status, updatedAt: new Date().toISOString() }); await atomic(join(directory, "progress.json"), report);
    console.log(JSON.stringify({ status, staged: report.staged, assigned: report.assigned, searches: report.searches, batch: report.batch }));
  };
  const client = execute ? new TwitterAPIClient(process.env.TWITTERAPI_IO_KEY ?? "", budget) : undefined;
  let processed = 0;
  try {
    for (;;) {
      const previous = await historyPublicationExclusions(config.sharedRoot, baseline.prompts);
      const folders = (await readdir(join(directory, "batches")).catch(e => { if (e.code === "ENOENT") return []; throw e; })).filter(n => /^batch-\d{4}$/.test(n)).sort();
      const batches = await Promise.all(folders.map(async name => ({ directory: join(directory, "batches", name),
        manifest: historyBatchSchema.parse(await json(join(directory, "batches", name, "manifest.json"), null)),
        catalog: await json<unknown>(join(directory, "batches", name, "complete.json"), null) })));
      if (batches.some(b => b.manifest.id !== b.directory.split("/").at(-1))) throw new Error("Batch identity does not match directory");
      const assigned = batches.flatMap(b => b.manifest.leads.map(l => l.id));
      if (new Set(assigned).size !== assigned.length || assigned.length > config.maximumSources) throw new Error("Historical source assignment budget or uniqueness violated");
      const holds = await readQualityHolds(config.sharedRoot);
      const moderation = await json<{ removedIDs: string[] }>(join(config.sharedRoot, "moderation.json"), { removedIDs: [] });
      const reviews = await readTranslationReviews(join(config.sharedRoot, "translations", "semantic-rejections.json"));
      const currentAcceptance = (prompts: Prompt[], previous: Prompt[] = []) => currentHistoryAcceptance(prompts, previous, holds, moderation.removedIDs, Date.now(), reviews);
      const staged = currentAcceptance(batches.flatMap(b => b.catalog ? historyCatalogSchema.parse(b.catalog).prompts : []), previous);
      if (staged.length > config.target) throw new Error("Acceptance target exceeded");
      await atomic(join(directory, "catalog.staged.json"), { schemaVersion: 1, version: "history-cohort500", prompts: staged, removedIDs: [] });
      await save(execute ? "running" : "dry-run", { staged: staged.length, assigned: assigned.length, published: 0,
        kinds: Object.fromEntries(["image", "video", "web", "text"].map(k => [k, staged.filter(p => p.kind === k).length])),
        presentations: Object.fromEntries(["general", "suggestive"].map(k => [k, staged.filter(p => p.presentation === k).length])) });
      if (!execute) break;
      if (staged.length >= config.target) { await save("awaiting-user-acceptance", { completedAt: new Date().toISOString() }); break; }
      if (processed && process.argv.includes("--one-batch")) { await save("batch-checkpoint"); break; }
      const pending = batches.find(b => !b.catalog || currentAcceptance(historyCatalogSchema.parse(b.catalog).prompts).length !== historyCatalogSchema.parse(b.catalog).prompts.length);
      if (pending) {
        await save("processing", { batch: pending.manifest.id });
        const ownIDs = new Set(pending.manifest.leads.map(lead => `x-post-${lead.id}`));
        await runHistoryBatch(pending.directory, pending.manifest, [...previous, ...staged.filter(p => !ownIDs.has(p.id))], config.sharedRoot, config.seedTranslations, Boolean(pending.catalog));
        processed++;
        continue;
      }
      if (assigned.length >= config.maximumSources) { await save("source-attempt-limit"); break; }
      const scans = await Promise.all(config.searchPlans.map(async path => {
        const plan = searchPlanSchema.parse(await json(join(path, "plan.json"), null));
        const run = await readXSearchPlan(path, plan), selected = await selectXSearchLeads(path, plan);
        return { path, plan, run, leads: selected.leads.map(l => ({ ...l, directory: path, planID: selected.report.planID })) };
      }));
      const searches = scans.reduce((n, s) => n + s.run.state.attempts.length, 0);
      const extras = config.extraLeads ? z.array(historyLeadSchema).parse(await json(config.extraLeads, [])) : [];
      const leads: XSearchLead[] = [...extras];
      for (let i = 0; scans.some(s => i < s.leads.length); i++) for (const scan of scans) if (scan.leads[i]) leads.push(scan.leads[i]);
      const used = new Set([...assigned, ...previous.flatMap(p => p.source.post ? [p.source.post.id] : [])]);
      const chosen = chooseHistoryLeads(leads, used, Math.min(historyLimits.batch, config.maximumSources - assigned.length, config.target - staged.length));
      await save("discovered", { searches, leads: leads.length });
      if (chosen.length) {
        const name = `batch-${String(batches.length + 1).padStart(4, "0")}`;
        const manifest = historyBatchSchema.parse({ version: 1, id: name, createdAt: new Date().toISOString(), leads: chosen });
        await writeImmutableBytes(join(directory, "batches", name, "manifest.json"), Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
        continue;
      }
      if (searches >= config.maximumSearches) { await save("search-attempt-limit"); break; }
      const next = scans.filter(s => !s.run.pending.size && s.run.report.queries.some(q => q.status === "pending"))
        .sort((a, b) => a.run.state.attempts.length - b.run.state.attempts.length)[0];
      if (!next) { await save("search-exhausted-or-needs-inspection"); break; }
      await save("searching", { searchPlan: next.path });
      const releaseSearch = await lockContent(next.path);
      let found;
      try { found = await runXSearchPlan(next.path, next.plan, { maxRequests: Math.min(10, config.maximumSearches - searches), search: client!.search.bind(client) }); }
      finally { await releaseSearch(); }
      // Stop the whole collector on a failed search. Trying every remaining plan during a
      // shared outage consumes their bounded retry allowances without adding coverage.
      if (["budget-limit", "unresolved", "failed"].includes(found.status) || found.requestsThisRun === 0) { await save(`search-${found.status}`); break; }
    }
  } catch (error) { await save("blocked", { error: error instanceof Error ? error.message : "Historical job failed" }); throw error; }
} finally { await unlock(); }
