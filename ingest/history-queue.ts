import { join } from "node:path";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { Prompt } from "../packages/schema/catalog.ts";
import { atomic, json, lockContent, writeImmutableBytes } from "./publication.ts";
import { StageQueue, queueIdentity, type QueueJob } from "./stage-queue.ts";
import { historyBatchSchema, historyCatalogSchema, type HistoryBatch, completeHistoryItem, uniqueHistoryItems } from "./history-cohort.ts";
import { runHistoryBatch } from "./history-batch.ts";
import { verifyReviewedHistory } from "./history-stage-verification.ts";
import { requiredIngestLocales, ingestLanguagePolicy, hasRequiredTranslations } from "./ingest-language-policy.ts";
import { applyQualityHolds, readQualityHolds } from "./quality-holds.ts";
import { readTranslationReviews } from "./translation-review.ts";
import { reviewTranslationSemantics } from "./translation-semantic.ts";
const runName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const payloadSchema = z.object({ batch: z.string().regex(/^batch-\d{4}$/), manifestSHA: z.string().regex(/^[a-f0-9]{64}$/), policy: z.literal(ingestLanguagePolicy), start: z.number().int().min(0).max(49).optional() }).strict();

/** Input originals, paid attempts and stage evidence remain in a durable external workspace. */
export async function enqueueHistoryPipeline(queue: StageQueue, root: string, runInput: string, raw: HistoryBatch, baseline: readonly Prompt[]) {
  const run = runName.parse(runInput), batch = historyBatchSchema.parse(raw), directory = join(root, run, batch.id);
  const exclusionPath = join(root, run, "exclusions.json");
  const existingExclusions = await json<Prompt[] | null>(exclusionPath, null);
  // A schema round trip may reorder object keys without changing the frozen
  // baseline. Preserve its original bytes, while rejecting any value/order change.
  if (existingExclusions !== null) {
    if (!isDeepStrictEqual(existingExclusions, baseline)) throw new Error("Immutable queue exclusions changed");
  } else await writeImmutableBytes(exclusionPath, Buffer.from(JSON.stringify(baseline) + "\n"));
  const unlock = await lockContent(directory);
  try { await writeImmutableBytes(join(directory, "manifest.json"), Buffer.from(JSON.stringify(batch) + "\n")); }
  finally { await unlock(); }
  const payload = { batch: batch.id, manifestSHA: queueIdentity(batch), policy: ingestLanguagePolicy };
  const prefix = `${run}:${batch.id}`;
  await queue.enqueue({ id: `${prefix}:collect`, run, stage: "collect", payload });
  await queue.enqueue({ id: `${prefix}:review`, run, stage: "review", dependency: `${prefix}:collect`, payload });
  await queue.enqueue({ id: `${prefix}:translate`, run, stage: "translate", dependency: `${prefix}:review`, payload });
  // Fixed slots are idempotent even if enqueue crashes midway. Empty slots make no model call.
  for (let start = 0; start < batch.leads.length; start += 4) await queue.enqueue({ id: `${prefix}:semantic:${start}`, run, stage: "semantic", dependency: `${prefix}:translate`, payload: { ...payload, start } });
}

export async function processHistoryStage(queue: StageQueue, root: string, shared: string, job: QueueJob, options: { beforeRequest?: () => Promise<void> } = {}) {
  const run = runName.parse(job.run_id), payload = payloadSchema.parse(job.payload), directory = join(root, run, payload.batch);
  const batch = historyBatchSchema.parse(await json(join(directory, "manifest.json"), null));
  if (queueIdentity(batch) !== payload.manifestSHA || batch.id !== payload.batch) throw new Error("Queue batch identity changed");
  const unlock = job.stage === "semantic" ? async () => {} : await lockContent(directory);
  try {
    const prior = await json<Prompt[]>(join(root, run, "exclusions.json"), []);
    if (job.stage === "collect" || job.stage === "review" || job.stage === "translate") {
      if (job.stage === "translate") {
        const predecessor = (await queue.db.query<{ output: { sourceSHA?: string } }>("select output from prompix.queue_jobs where id=$1 and state='succeeded'", [job.dependency])).rows[0];
        const source = await json(join(directory, "source-catalog.json"), null);
        if (!source || predecessor?.output.sourceSHA !== queueIdentity(source)) throw new Error("Reviewed stage artifact changed");
      }
      const items = await runHistoryBatch(directory, batch, prior, shared, undefined, false, {
        stage: job.stage === "collect" ? "source" : job.stage === "review" ? "review" : "translation", chineseOnly: true, translationConcurrency: 1, checkLease: async () => { await options.beforeRequest?.(); await queue.renew(job); } });
      const source = await json(join(directory, "source-catalog.json"), null);
      const complete = await json(join(directory, "complete.json"), null);
      return { count: items.length, sourceSHA: source ? queueIdentity(source) : null, translatedSHA: complete ? queueIdentity(complete) : null, published: 0 };
    }
    if (job.stage !== "semantic" || payload.start === undefined) throw new Error("Unsupported history queue stage");
    const rawComplete = await json(join(directory, "complete.json"), null);
    const predecessor = (await queue.db.query<{ output: { translatedSHA?: string } }>("select output from prompix.queue_jobs where id=$1 and state='succeeded'", [job.dependency])).rows[0];
    // Match the producer's persisted representation before parsing can reorder keys
    // or strip extra fields. Schema validation remains mandatory afterwards.
    if (predecessor?.output.translatedSHA !== queueIdentity(rawComplete)) throw new Error("Translated stage artifact changed");
    const complete = historyCatalogSchema.parse(rawComplete);
    const items = complete.prompts.slice(payload.start, payload.start + 4);
    if (!items.length) return { pass: 0, held: 0, published: 0 };
    await verifyReviewedHistory(directory, shared, items);
    if (!items.every(item => completeHistoryItem(item, Date.now(), requiredIngestLocales))) throw new Error("Required history quality changed");
    const reviewDirectory = join(directory, "semantic", `${payload.start}-${job.attempts}`);
    await options.beforeRequest?.();
    await queue.renew(job);
    const review = await reviewTranslationSemantics(items, "zh-Hans", reviewDirectory, process.env.PROMPIX_CODEX ?? "codex");
    await atomic(join(reviewDirectory, "result.json"), review);
    const approved = new Set(review.reviews.filter(r => r.verdict === "pass").map(r => r.id));
    const ready = items.filter(item => approved.has(item.id));
    await atomic(join(directory, `ready-${payload.start}.json`), ready);
    return { pass: ready.length, held: items.length - ready.length, identity: review.identity, readySHA: queueIdentity(ready), usage: review.usage, published: 0 };
  } finally { await unlock(); }
}

/** Campaign owner holds use its own lock so an ongoing public operation cannot delay exclusion.
 * Shared holds remain authoritative too; neither file clears the other scope. */
export async function readHistoryQualityHolds(root: string, shared: string) {
  const [global, local] = await Promise.all([readQualityHolds(shared), readQualityHolds(root)]);
  return { schemaVersion: 1 as const, holds: { ...global.holds, ...local.holds } };
}

/** Export is an acceptance input only. Existing publication limits/holds still apply. */
export async function exportQueueReady(queue: StageQueue, root: string, shared: string, runInput: string) {
  const run = runName.parse(runInput);
  const rows = (await queue.db.query<{ payload: unknown; output: { pass: number; readySHA?: string } }>(
    "select payload,output from prompix.queue_jobs where run_id=$1 and stage='semantic' and state='succeeded' order by id", [run])).rows;
  const items: Prompt[] = [];
  const holds = await readHistoryQualityHolds(root, shared);
  for (const row of rows) {
    if (!row.output.pass) continue;
    const payload = payloadSchema.parse(row.payload), directory = join(root, run, payload.batch);
    const ready = JSON.parse(await readFile(join(directory, `ready-${payload.start}.json`), "utf8")) as Prompt[];
    if (queueIdentity(ready) !== row.output.readySHA || ready.length !== row.output.pass) throw new Error("Ready evidence changed");
    // Verify the immutable output before excluding later owner holds. A hold must
    // remove only its item, without making unrelated approved batches unusable.
    const eligible = applyQualityHolds(ready, holds).prompts;
    await verifyReviewedHistory(directory, shared, eligible);
    const rejections = await readTranslationReviews(join(shared, "translations", "semantic-rejections.json"));
    if (!eligible.every(item => completeHistoryItem(item, Date.now(), requiredIngestLocales) && hasRequiredTranslations(item, rejections))) throw new Error("Ready quality expired");
    items.push(...eligible);
  }
  if (new Set(items.map(p => p.id)).size !== items.length) throw new Error("Duplicate queue output");
  return uniqueHistoryItems(items, await json<Prompt[]>(join(root, run, "exclusions.json"), []));
}
