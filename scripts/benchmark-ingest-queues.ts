/** Existing-data benchmark only. Never discovers, acquires, publishes or updates the input cohort. */
import { readFile, readdir, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { catalogSchema, type Prompt } from "../packages/schema/catalog.ts";
import { StageQueue, queueIdentity, queueStages, workStage, type QueueJob } from "../ingest/stage-queue.ts";
import { atomic, json, lockContent, writeImmutableBytes } from "../ingest/publication.ts";
import { verifyReviewedHistory } from "../ingest/history-stage-verification.ts";
import { originalAndChinese, hasRequiredTranslations, seedApprovedChineseMetadata } from "../ingest/ingest-language-policy.ts";
import { emptyTranslationCache } from "../ingest/translation.ts";
import { readTranslationCache } from "../ingest/translation-cache.ts";
import { readTranslationReviews } from "../ingest/translation-review.ts";
import { runHistoryTranslations } from "../ingest/history-batch.ts";
import { codexTranslationProvider } from "../ingest/translation-provider.ts";
import { reviewTranslationSemantics } from "../ingest/translation-semantic.ts";
import type { TranslationRunReport } from "../ingest/translation-runner.ts";
import type { TransactionalDatabase, Database } from "../services/feed/database.ts";

const [inputPath, outputPath, sharedPath, executable, limitArg = "323"] = process.argv.slice(2);
if (!inputPath || !outputPath || !sharedPath || !executable) throw new Error("Usage: benchmark-ingest-queues INPUT_COHORT OUTPUT SHARED CODEX [LIMIT]");
const input = resolve(inputPath), output = resolve(outputPath), shared = resolve(sharedPath), limit = Number(limitArg);
if (output === input || output.startsWith(input + "/") || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid independent benchmark output or bound");
await mkdir(output, { recursive: true });
const unlock = await lockContent(output);
const pg = new PGlite(join(output, "database"), { extensions: { pg_trgm } });
try {
  if (!(await pg.query("select 1 from information_schema.tables where table_schema='prompix' and table_name='queue_jobs'")).rows.length) {
    const migrations = new URL("../supabase/migrations/", import.meta.url);
    for (const name of (await readdir(migrations)).filter(n => n.endsWith(".sql")).sort()) await pg.exec(await readFile(new URL(name, migrations), "utf8"));
  }
  const db: TransactionalDatabase = { query: (sql, parameters) => pg.query(sql, parameters), transaction: op => pg.transaction(tx => op({ query: (sql, parameters) => tx.query(sql, parameters) } as Database)) };
  const queue = new StageQueue(db), run = "existing-zh-cold-v1";
  const source = catalogSchema.parse(await json(join(input, "catalog.reviewable.json"), null));
  const selected = source.prompts.slice(0, limit), selectedIDs = new Set(selected.map(p => p.id));
  await writeImmutableBytes(join(output, "input.json"), Buffer.from(JSON.stringify({ items: selected, inputSHA256: queueIdentity(source), coldLocales: ["zh-Hans"], sourceCalls: 0, maxModelCalls: 200 }) + "\n"));
  const mapping = new Map<string, string>();
  for (const name of (await readdir(join(input, "batches"))).filter(n => /^batch-\d{4}$/.test(n)).sort()) {
    const complete = await json<{ prompts: Prompt[] } | null>(join(input, "batches", name, "complete.json"), null);
    for (const item of complete?.prompts ?? []) if (selectedIDs.has(item.id)) {
      if (mapping.has(item.id)) throw new Error("Duplicate batch ownership"); mapping.set(item.id, join(input, "batches", name));
    }
  }
  if (mapping.size !== selected.length) throw new Error("Missing original review evidence");
  let group = 0;
  for (let offset = 0; offset < selected.length; offset += 8) {
    const items = selected.slice(offset, offset + 8), id = String(++group).padStart(3, "0"), directory = join(output, id);
    await mkdir(directory, { recursive: true });
    // A cold body cache; metadata can be reused only after the review stage passes.
    const original = items.map(({ localization: _, ...item }) => item);
    await writeImmutableBytes(join(directory, "source.json"), Buffer.from(JSON.stringify(original) + "\n"));
    await queue.enqueue({ id: `${run}:${id}:collect`, run, stage: "collect", payload: { id, sha: queueIdentity(original), reused: true } });
    await queue.enqueue({ id: `${run}:${id}:review`, run, stage: "review", dependency: `${run}:${id}:collect`, payload: { id, sha: queueIdentity(original) } });
    await queue.enqueue({ id: `${run}:${id}:translate`, run, stage: "translate", dependency: `${run}:${id}:review`, payload: { id, sha: queueIdentity(original) } });
    for (let start = 0; start < items.length; start += 4) await queue.enqueue({ id: `${run}:${id}:semantic:${start}`, run, stage: "semantic", priority: 1,
      dependency: `${run}:${id}:translate`, payload: { id, start, sha: queueIdentity(original) } });
  }
  const measurement = await json<any>(join(output, "measurement.json"), { startedAt: new Date().toISOString(), inputItems: selected.length, sourceCalls: 0,
    newSourceCostUSD: 0, modelApiCostUSD: 0, subscriptionModel: "gpt-6-luna", stages: [], modelCalls: [], note: "Source/editorial/visual use exact existing approvals; Chinese and independent semantic checks are cold. Not full cold end-to-end throughput." });
  let persistQueue = Promise.resolve();
  const persist = () => { persistQueue = persistQueue.then(() => atomic(join(output, "measurement.json"), measurement)); return persistQueue; };
  const reserve = async (kind: string, id: string) => {
    if (measurement.modelCalls.length >= 200) throw new Error("Benchmark model request cap reached");
    const attempt = { sequence: measurement.modelCalls.length + 1, kind, id, state: "reserved", at: new Date().toISOString() } as Record<string, unknown>;
    measurement.modelCalls.push(attempt); await persist(); return attempt;
  };
  const provider = codexTranslationProvider(executable, 24000, "gpt-6-luna");
  const reviews = await readTranslationReviews(join(shared, "translations", "semantic-rejections.json"));
  const handler = async (job: QueueJob) => {
    const directory = join(output, String(job.payload.id)), items = await json<Prompt[]>(join(directory, "source.json"), []), started = Date.now();
    if (queueIdentity(items) !== job.payload.sha) throw new Error("Immutable benchmark source changed");
    let result: Record<string, unknown> = {};
    if (job.stage === "collect") result = { count: items.length, sourceCalls: 0, mode: "retained-originals" };
    if (job.stage === "review") {
      for (const path of new Set(items.map(p => mapping.get(p.id)!))) await verifyReviewedHistory(path, shared, items.filter(p => mapping.get(p.id) === path));
      result = { count: items.length, requests: 0, mode: "exact-source-and-full-media-cache-revalidated" };
    }
    if (job.stage === "translate") {
      const cache = await readTranslationCache(join(directory, "cache.json"));
      const seeded = seedApprovedChineseMetadata(items, cache);
      const prior = await json<TranslationRunReport | undefined>(join(directory, "translation-report.json"), undefined);
      if (prior && (prior.failed || prior.attempted > 0)) throw new Error("Previous model attempt needs reconciliation before rerun");
      const report = await runHistoryTranslations({ items, cache, reviews, locales: ["zh-Hans"], concurrency: 1, maxAttempts: 1, maxRequests: 12, maxUSD: 0,
        providerName: "codex", model: "gpt-6-luna", prior,
        provider: async (locale, segments) => {
          const attempt = await reserve("translation", job.id);
          try {
            const response = await provider(locale, segments);
            await writeImmutableBytes(join(directory, `translation-${attempt.sequence}.json`), Buffer.from(JSON.stringify({ locale, segments, response }) + "\n"));
            Object.assign(attempt, { state: "completed", inputTokens: response.inputTokens, outputTokens: response.outputTokens, completedAt: new Date().toISOString() }); await persist(); return response;
          } catch (e) { Object.assign(attempt, { state: "uncertain" }); await persist(); throw e; }
        }, persist: async (state, status) => { await atomic(join(directory, "cache.json"), state); await atomic(join(directory, "translation-report.json"), status); } });
      if (report.failed) throw new Error("Translation provider failure retained");
      const localized = originalAndChinese(items, cache, reviews);
      const eligible = localized.filter(p => hasRequiredTranslations(p, reviews));
      await atomic(join(directory, "translated.json"), eligible);
      await atomic(join(directory, "translation-deferred.json"), localized.filter(p => !hasRequiredTranslations(p, reviews)).map(p => p.id));
      result = { count: eligible.length, deferred: items.length - eligible.length, seeded, report };
    }
    if (job.stage === "semantic") {
      const targets = new Set(items.slice(Number(job.payload.start), Number(job.payload.start) + 4).map(p => p.id));
      const translated = (await json<Prompt[]>(join(directory, "translated.json"), [])).filter(p => targets.has(p.id));
      if (translated.length) {
        const attempt = await reserve("semantic", job.id);
        try {
          const review = await reviewTranslationSemantics(translated, "zh-Hans", join(directory, `semantic-${job.payload.start}-${attempt.sequence}`), executable);
          Object.assign(attempt, { state: "completed", inputTokens: review.usage.input_tokens, outputTokens: review.usage.output_tokens, completedAt: new Date().toISOString() }); await persist();
          const passed = new Set(review.reviews.filter(r => r.verdict === "pass").map(r => r.id));
          await atomic(join(directory, `ready-${job.payload.start}.json`), translated.filter(p => passed.has(p.id)));
          await atomic(join(directory, `semantic-${job.payload.start}.json`), review);
          result = { pass: passed.size, held: translated.length - passed.size, identity: review.identity };
        } catch (e) { Object.assign(attempt, { state: "uncertain" }); await persist(); throw e; }
      }
    }
    measurement.stages.push({ id: job.id, stage: job.stage, elapsedMs: Date.now() - started, result }); await persist();
    console.log(JSON.stringify({ stage: job.stage, id: job.payload.id, elapsedMs: Date.now() - started, count: result.count, pass: result.pass, held: result.held }));
    return result;
  };
  const worker = async () => {
    while (true) {
      try { if (!await workStage(queue, run, [...queueStages], handler)) break; }
      catch (e) { console.log(JSON.stringify({ isolated: true, error: e instanceof Error ? e.message : String(e) })); }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  measurement.finishedAt = new Date().toISOString(); measurement.queues = await queue.counts(run);
  measurement.ready = measurement.stages.filter((s: any) => s.stage === "semantic").reduce((n: number, s: any) => n + (s.result.pass ?? 0), 0);
  measurement.held = measurement.stages.filter((s: any) => s.stage === "semantic").reduce((n: number, s: any) => n + (s.result.held ?? 0), 0);
  measurement.elapsedSeconds = (Date.parse(measurement.finishedAt) - Date.parse(measurement.startedAt)) / 1000;
  await persist(); console.log(JSON.stringify({ ready: measurement.ready, held: measurement.held, seconds: measurement.elapsedSeconds, queues: measurement.queues }));
} finally { await pg.close(); await unlock(); }
