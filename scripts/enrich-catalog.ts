/** Prompix 2.0 field backfill: sample, prepare verified media, review in batches, report.
 * Every model call goes through the provider layer on the `review` stage. All working
 * files (media, outcomes) live in an external --work directory, never in the repository. */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile, appendFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { catalogSchema, type Prompt } from "../packages/schema/catalog.ts";
import {
  applyEnrichment, packEnrichmentBatches, reviewEnrichmentBatch, type EnrichmentCandidate, type EnrichmentImage, type EnrichmentOutcome,
} from "../ingest/enrichment-review.ts";
import { prepareJPEG } from "../ingest/images.ts";
import { trustSystemCertificates } from "../ingest/models/http.ts";
import { createProvider, isProviderId, modelEnvironment } from "../ingest/models/registry.ts";
import { ModelProviderError, type Effort } from "../ingest/models/types.ts";
import { computePalette } from "../ingest/palette.ts";
import { appendEvent, pipelineRoot } from "../ingest/pipeline-control.ts";
import { recordExclusion, refusedIDs } from "../ingest/exclusion-log.ts";
import { prepareVisualMedia, VisualMediaPreparationError } from "../ingest/visual-media.ts";
import type { Palette } from "../packages/schema/enrichment.ts";
import { withDailyStatus } from "../ingest/daily-status.ts";
import { prepareDailyStaging, publishDailyCatalog, readPublicationHold } from "../ingest/daily-publication.ts";
import { atomic, contentRoot, json as readJSON, moderationSchema } from "../ingest/publication.ts";
import { languagePackEditionVersion } from "../ingest/release-publication.ts";
import { preservePublicationInput } from "../services/feed/publication.ts";
import { filterXAvailability, readXAvailability } from "../ingest/x-availability.ts";

process.umask(0o077);
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  catalog: { type: "string" }, work: { type: "string" }, ids: { type: "string" }, run: { type: "string" }, count: { type: "string" },
  provider: { type: "string" }, model: { type: "string" }, effort: { type: "string" }, batch: { type: "string" },
  concurrency: { type: "string" }, "full-media": { type: "boolean" }, "max-concurrency": { type: "string" }, budget: { type: "string" }, runs: { type: "string" }, by: { type: "string" },
} });
const [command] = positionals;
const work = values.work;
if (!work || !isAbsolute(work)) throw new Error("--work /absolute/external/directory is required");

type Prepared = { images: (EnrichmentImage & { sourceRole: string })[]; video?: { durationSeconds: number; hasAudio: boolean }; palette?: Palette; error?: string };

async function loadCatalog(): Promise<Prompt[]> {
  if (!values.catalog) throw new Error("--catalog is required");
  const raw = JSON.parse(await readFile(values.catalog, "utf8"));
  return raw.prompts.map((item: unknown) => catalogSchema.shape.prompts.element.parse(item));
}
async function selectedItems(): Promise<Prompt[]> {
  const items = await loadCatalog();
  if (!values.ids) return items;
  const ids: string[] = JSON.parse(await readFile(values.ids, "utf8"));
  const byID = new Map(items.map(item => [item.id, item]));
  return ids.map(id => { const item = byID.get(id); if (!item) throw new Error(`Unknown id ${id}`); return item; });
}
async function pool<T>(values: readonly T[], concurrency: number, work: (value: T, index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) { const index = next++; await work(values[index], index); }
  }));
}
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
/** The reviewed revision, in schema key order so a raw and a parsed copy agree; an item
 * edited since review is left for the next pass. */
const itemHash = (item: Prompt) => createHash("sha256").update(JSON.stringify(catalogSchema.shape.prompts.element.parse(item))).digest("hex");
const exists = (path: string) => readFile(path).then(() => true, () => false);

/** A fixed spread of kinds and scale labels. */
function sample(items: Prompt[], count: number): string[] {
  const groups: [string, (item: Prompt) => boolean, number][] = [
    ["image/general", item => item.kind === "image" && item.presentation === "general", 12],
    ["image/suggestive", item => item.kind === "image" && item.presentation === "suggestive", 6],
    ["image/unknown", item => item.kind === "image" && item.presentation === "unknown", 6],
    ["video/general", item => item.kind === "video" && item.presentation === "general", 6],
    ["video/suggestive", item => item.kind === "video" && item.presentation === "suggestive", 3],
    ["video/unknown", item => item.kind === "video" && item.presentation === "unknown", 4],
    ["text", item => item.kind === "text" && item.contentType !== "skill", 5],
    ["skill", item => item.contentType === "skill", 4],
    ["web", item => item.kind === "web", 4],
  ];
  const picked: string[] = [];
  // Even spacing through the catalog order keeps sources and eras mixed without randomness.
  for (const [, matches, wanted] of groups) {
    const pool = items.filter(matches), step = pool.length / Math.min(wanted, pool.length);
    for (let index = 0; index < Math.min(wanted, pool.length); index++) picked.push(pool[Math.floor(index * step)].id);
  }
  return picked;
}

/** Verified mirrored media only. Unknown labels get every image and all six frames, the
 * visual review's standard; settled labels get the cover (and two frames for video). */
async function prepare(item: Prompt): Promise<Prepared> {
  const directory = join(work!, "media", item.id), record = join(directory, "prepared.json");
  if (await exists(record)) return json(record);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  let prepared: Prepared;
  if (!item.media?.imageURL) prepared = { images: [] };
  else try {
    // Text and web items can carry a preview image; they are prepared like a still image.
    const media = await prepareVisualMedia(item.kind === "video" ? item : { ...item, kind: "image" }, directory);
    // New items are also judged for minors, so they always get the full gallery and frames.
    const full = values["full-media"] || item.presentation === "unknown" || !item.presentation;
    const posters = media.attachments.filter(attachment => attachment.role !== "video-frame");
    const frames = media.attachments.filter(attachment => attachment.role === "video-frame");
    const chosen = [...(full ? posters : posters.slice(0, 1)), ...(full ? frames : frames.filter((_, index) => index === 1 || index === 4))];
    const images: Prepared["images"] = [];
    for (const [index, attachment] of chosen.entries()) {
      const path = join(directory, `model-${index}.jpg`);
      await prepareJPEG(attachment.path, path, 768);
      images.push({ path, mediaType: "image/jpeg", role: attachment.role, sourceRole: attachment.id,
        ...(attachment.timeSeconds !== undefined ? { timeSeconds: attachment.timeSeconds } : {}) });
    }
    prepared = {
      images, palette: await computePalette(posters[0].path),
      ...(media.coverage.mode === "sampled-frames" ? { video: { durationSeconds: media.coverage.durationSeconds, hasAudio: media.coverage.hasAudio } } : {}),
    };
  } catch (error) {
    prepared = { images: [], error: error instanceof VisualMediaPreparationError ? error.code : (error as Error).message.slice(0, 200) };
  }
  // Keep only the downscaled model images; the verified originals and videos are not needed again.
  for (const name of await readdir(directory)) if (name.startsWith("visual-")) await rm(join(directory, name), { recursive: true, force: true });
  await writeFile(record, JSON.stringify(prepared, null, 2));
  return prepared;
}

/** Per-million-token list prices used to estimate spend; the console holds the real balance. */
const prices: Record<string, { input: number; output: number; cachedInput: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cachedInput: 0.2 }, "claude-opus-5-5": { input: 4, output: 20, cachedInput: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cachedInput: 0.01 },
};
const cost = (model: string, usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } = {}) => {
  const price = prices[model];
  return price ? ((usage.inputTokens ?? 0) * price.input + (usage.outputTokens ?? 0) * price.output + (usage.cachedInputTokens ?? 0) * price.cachedInput) / 1e6 : 0;
};

/** Media preparation (local CPU and disk) and model calls (network) run as one pipeline
 * with separate limits. Calls start at --concurrency, rise to --max-concurrency while no
 * rate limit is seen, and halve with a pause on each 429. A refusal excludes its batch for good. */
async function review(items: Prompt[]) {
  const providerID = values.provider ?? "anthropic-api", run = values.run, actor = values.by ?? "claude-code";
  if (!run || !/^[a-z0-9-]+$/.test(run)) throw new Error("--run <name> is required");
  if (!isProviderId(providerID)) throw new Error(`Unknown provider ${providerID}`);
  const { env } = await modelEnvironment();
  const provider = createProvider(providerID, values.model, env);
  const directory = join(work!, "runs", run), outcomes = join(directory, "outcomes");
  await mkdir(outcomes, { recursive: true });
  const done = new Set((await readdir(outcomes)).map(name => name.replace(/\.json$/, "")));
  const refused = await refusedIDs(join(directory, "exclusions.jsonl"));
  const pending = items.filter(item => !done.has(item.id) && !refused.has(item.id));
  const batchSize = Number(values.batch ?? 6), budget = Number(values.budget ?? Infinity), maximum = Number(values["max-concurrency"] ?? 32);
  let limit = Number(values.concurrency ?? 16), active = 0, spent = 0, cleanSince = Date.now(), pausedUntil = 0, stopped = "";
  for (const line of (await readFile(join(directory, "batches.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean)) {
    const batch = JSON.parse(line); spent += cost(batch.model, batch.usage);
  }
  const root = pipelineRoot(), ready: EnrichmentCandidate[] = [], queue: { batch: EnrichmentCandidate[]; attempts: number }[] = [];
  let prepared = 0, deferred = 0, completed = 0, producing = true;
  console.log(`${run}: ${pending.length} items on ${provider.id} ${provider.model}, ${limit}→${maximum} calls, media ×4, spent so far $${spent.toFixed(2)}`);
  const producer = pool(pending, 4, async item => {
    const media = await prepare(item);
    prepared++;
    if (media.error) { deferred++; await recordExclusion(join(directory, "exclusions.jsonl"), { id: item.id, stage: "media", reason: `Media could not be prepared: ${media.error}` }); return; }
    ready.push({ item, images: media.images.map(({ sourceRole: _, ...image }) => image), ...(media.video ? { video: media.video } : {}) });
  }).finally(() => { producing = false; });
  const call = async (entry: { batch: EnrichmentCandidate[]; attempts: number }) => {
    const { batch } = entry, started = Date.now();
    const line: Record<string, unknown> = { ids: batch.map(candidate => candidate.item.id), images: batch.flatMap(candidate => candidate.images).length, provider: provider.id, model: provider.model, attempt: entry.attempts + 1 };
    try {
      const result = await reviewEnrichmentBatch(provider, batch, { effort: (values.effort ?? "low") as Effort,
        record: summary => appendEvent(root, actor, "model.call", { ...summary, task: `enrichment:${run}` }).then(() => undefined) });
      for (const [position, outcome] of result.outcomes.entries())
        await writeFile(join(outcomes, `${outcome.id}.json`), JSON.stringify({ ...outcome, itemHash: itemHash(batch[position].item), provider: result.provider, model: result.model }, null, 2));
      Object.assign(line, { ok: true, usage: result.usage, durationMs: result.durationMs, failedItems: result.outcomes.filter(outcome => !outcome.ok).length });
      spent += cost(provider.model, result.usage); completed += batch.length;
      if (limit < maximum && Date.now() - cleanSince > 60_000) { limit = Math.min(maximum, limit * 2); cleanSince = Date.now(); console.log(`  no rate limits for a minute: ${limit} calls`); }
    } catch (error) {
      const code = error instanceof ModelProviderError ? error.code : "failed";
      Object.assign(line, { ok: false, error: code, message: (error as Error).message.slice(0, 300), durationMs: Date.now() - started });
      if (code === "rate_limited") {
        limit = Math.max(2, Math.floor(limit / 2)); cleanSince = pausedUntil = Date.now() + 30_000;
        console.log(`  rate limited: ${limit} calls after a 30 s pause`);
      }
      // A refusal is final for these items: excluded and never sent to another model.
      if (code === "refused") for (const candidate of batch)
        await recordExclusion(join(directory, "exclusions.jsonl"), { id: candidate.item.id, stage: "review", reason: "The model declined to review this content", refused: true, provider: provider.id, model: provider.model });
      else if (error instanceof ModelProviderError && error.retryable && entry.attempts < 4) queue.push({ batch, attempts: entry.attempts + 1 });
      else if (code === "invalid_output" && batch.length > 1 && entry.attempts < 1)
        // A malformed envelope loses the whole call; retry the same model one item at a time.
        for (const candidate of batch) queue.push({ batch: [candidate], attempts: 1 });
    }
    await appendFile(join(directory, "batches.jsonl"), JSON.stringify(line) + "\n");
    if (!line.ok) console.log(`  ${line.error} (${batch.length} items): ${line.message}`);
  };
  const running = new Set<Promise<void>>();
  let lastReport = Date.now();
  while (true) {
    if (!stopped && spent >= budget) { stopped = `budget $${budget} reached`; console.log(`  stopping: ${stopped}`); }
    while (!stopped && ready.length >= (producing ? batchSize : 1)) queue.push(...packEnrichmentBatches(ready.splice(0, producing ? batchSize : ready.length), batchSize).map(batch => ({ batch, attempts: 0 })));
    while (!stopped && active < limit && queue.length && Date.now() >= pausedUntil) {
      const entry = queue.shift()!; active++;
      const task = call(entry).finally(() => { active--; running.delete(task); });
      running.add(task);
    }
    if (!producing && !ready.length && (!queue.length || stopped) && !active) break;
    if (Date.now() - lastReport > 60_000) { lastReport = Date.now(); console.log(`  prepared ${prepared}/${pending.length} (deferred ${deferred}), reviewed ${completed}, calls ${active}/${limit}, ~$${spent.toFixed(2)}`); }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await producer;
  console.log(`${run}: reviewed ${completed}, deferred ${deferred}, unsent ${queue.reduce((sum, entry) => sum + entry.batch.length, 0)}, estimated $${spent.toFixed(2)}${stopped ? ` (${stopped})` : ""}`);
}

async function report(items: Prompt[]) {
  const byID = new Map(items.map(item => [item.id, item]));
  const rows: Record<string, unknown>[] = [];
  for (const run of (values.runs ?? "").split(",").filter(Boolean)) {
    const directory = join(work!, "runs", run);
    const batches = (await readFile(join(directory, "batches.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
    const outcomes: EnrichmentOutcome[] = await Promise.all((await readdir(join(directory, "outcomes"))).map(name => json(join(directory, "outcomes", name))));
    const ok = outcomes.filter(outcome => outcome.ok);
    const sum = (key: "inputTokens" | "outputTokens" | "cachedInputTokens") => batches.reduce((total, batch) => total + (batch.usage?.[key] ?? 0), 0);
    const changes = ok.map(outcome => ({ id: outcome.id, from: byID.get(outcome.id)?.presentation, to: outcome.evidence.presentation }))
      .filter(change => change.from !== change.to);
    rows.push({ run, batches: batches.length, failedBatches: batches.filter(batch => !batch.ok).length, items: outcomes.length, okItems: ok.length,
      failedItems: outcomes.filter(outcome => !outcome.ok).map(outcome => ({ id: outcome.id, error: !outcome.ok && outcome.error })),
      inputTokens: sum("inputTokens"), cachedInputTokens: sum("cachedInputTokens"), outputTokens: sum("outputTokens"),
      estimatedUSD: Number(batches.reduce((total, batch) => total + cost(batch.model, batch.usage), 0).toFixed(3)),
      seconds: Math.round(batches.reduce((total, batch) => total + (batch.durationMs ?? 0), 0) / 1000),
      presentationDisagreements: changes, gaps: ok.flatMap(outcome => outcome.evidence.vocabularyGaps) });
  }
  console.log(JSON.stringify(rows, null, 2));
}

/** Enriches the current authoritative edition under the publisher lock. Only fields are
 * added; unknown labels take the re-judged label, settled labels only tighten, and explicit findings must already be
 * staged for removal (npm run remove) so they leave in this same edition. X sources must have
 * a current recheck; withheld ones sit out the edition. */
async function publish(dryRun: boolean) {
  const run = values.run;
  if (!run) throw new Error("--run <name> is required");
  const outcomes = join(work!, "runs", run, "outcomes");
  const report = { startedAt: new Date().toISOString(), published: false, enriched: 0, unchanged: 0, stale: 0, failed: 0, relabelled: {} as Record<string, number>, removed: [] as string[], withheld: [] as string[], total: 0, version: "" };
  await withDailyStatus(contentRoot, report, async () => {
    if (await readPublicationHold(contentRoot)) throw new Error("Publication is held");
    const prepared = await prepareDailyStaging(contentRoot);
    if (!prepared.previous?.database) throw new Error("Initialized database required");
    const previous = prepared.previous.authoritative;
    const moderation = moderationSchema.parse(await readJSON(join(contentRoot, "moderation.json"), { removedIDs: [] }));
    const removed = new Set([...(previous.removedIDs ?? []), ...moderation.removedIDs]);
    const prompts: Prompt[] = [];
    for (const item of previous.prompts) {
      if (removed.has(item.id)) { report.removed.push(item.id); continue; }
      const path = join(outcomes, `${item.id}.json`);
      const outcome = await exists(path) ? await json(path) : undefined;
      if (!outcome || item.facets) { report.unchanged++; prompts.push(item); continue; }
      if (!outcome.ok) { report.failed++; prompts.push(item); continue; }
      if (outcome.itemHash !== itemHash(item)) { report.stale++; prompts.push(item); continue; }
      const media: Prepared = await json(join(work!, "media", item.id, "prepared.json"));
      const enriched = applyEnrichment(item, outcome, { palette: media.palette, video: media.video, policy: "stricter-only" });
      if (enriched.presentation === "explicit") throw new Error(`Explicit finding must be staged for removal first: ${item.id}`);
      if (enriched.presentation !== item.presentation) report.relabelled[`${item.presentation}->${enriched.presentation}`] = (report.relabelled[`${item.presentation}->${enriched.presentation}`] ?? 0) + 1;
      report.enriched++;
      prompts.push(enriched);
    }
    // Like the daily publisher: an X source that is gone or changed sits out this edition
    // without entering the removal list, and returns once a recheck finds it again.
    const available = filterXAvailability(prompts, await readXAvailability(contentRoot));
    report.withheld = available.withheldIDs;
    prompts.splice(0, prompts.length, ...available.prompts);
    report.total = prompts.length;
    const removedIDs = [...removed].sort();
    const catalog = preservePublicationInput({ ...previous, prompts, removedIDs, publishedAt: new Date().toISOString(),
      version: languagePackEditionVersion(prompts, removedIDs) });
    await atomic(join(work!, "runs", run, `publication-${dryRun ? "dry-run" : "input"}.json`), catalog);
    if (!dryRun && (report.enriched || report.removed.length || report.withheld.length)) {
      const result = await publishDailyCatalog(contentRoot, catalog, prepared);
      report.published = true; report.version = result.authoritative.version;
    }
    await atomic(join(work!, "runs", run, `publication-report${dryRun ? "-dry-run" : ""}.json`), report);
  });
  console.log(JSON.stringify(report, null, 2));
}

trustSystemCertificates();
switch (command) {
  case "sample": {
    const ids = sample(await loadCatalog(), Number(values.count ?? 50));
    await mkdir(work, { recursive: true });
    await writeFile(join(work, "sample.json"), JSON.stringify(ids, null, 2));
    console.log(`${ids.length} ids → ${join(work, "sample.json")}`);
    break;
  }
  case "prepare": {
    const items = await selectedItems();
    let failed = 0;
    await pool(items, Number(values.concurrency ?? 3), async item => { if ((await prepare(item)).error) failed++; });
    console.log(`prepared ${items.length}, deferred ${failed}`);
    break;
  }
  case "review": await review(await selectedItems()); break;
  case "report": await report(await loadCatalog()); break;
  case "publish": await publish(false); break;
  case "dry-run": await publish(true); break;
  default: throw new Error("Usage: enrich-catalog sample|prepare|review|report --work /external/dir --catalog file [--ids file]");
}
