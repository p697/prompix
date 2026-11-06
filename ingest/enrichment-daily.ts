import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Prompt } from "../packages/schema/catalog.ts";
import { prepareEnrichmentMedia, type PreparedEnrichmentMedia } from "./enrichment-media.ts";
import { applyEnrichment, packEnrichmentBatches, publicationBlocker, reviewEnrichmentBatch,
  type EnrichmentCandidate, type EnrichmentOutcome, type EnrichmentRecord } from "./enrichment-review.ts";
import { recordExclusion, refusedIDs } from "./exclusion-log.ts";
import { ModelProviderError, type Effort, type ModelProvider } from "./models/types.ts";

export type DailyEnrichmentOptions = { provider?: ModelProvider; effort?: Effort; record?: EnrichmentRecord;
  maxItems?: number; batchSize?: number; concurrency?: number; prepare?: typeof prepareEnrichmentMedia };
export type DailyEnrichmentReport = { status: "reviewed" | "cached" | "stopped"; provider?: string; model?: string; additions: number;
  reviewed: number; requests: number; failedRequests: number; enriched: number; excluded: number; deferred: number; stopped?: string };

/** An outcome stays valid only for the content it judged. */
export const reviewedContentHash = (item: Prompt) => createHash("sha256").update(JSON.stringify({ id: item.id, kind: item.kind, title: item.title,
  summary: item.summary, prompt: item.prompt, model: item.model, media: item.media, revision: item.source.revision })).digest("hex");
const storedSchema = z.object({ hash: z.string(), attempts: z.number().int().min(1), provider: z.string(), model: z.string(),
  outcome: z.custom<EnrichmentOutcome>(value => !!value && typeof value === "object") });
type Stored = z.infer<typeof storedSchema>;
/** A failed item judgment is retried once on a later run, then waits for its content to change. */
const maxItemAttempts = 2;

const enrichmentKeys = ["inputs", "generation", "variables", "facets", "palette", "shots", "rights"] as const;
const restrictiveness: Record<string, number> = { general: 0, suggestive: 1, unknown: 2, explicit: 3 };
/** Unchanged live content keeps what its 2.0 review decided. A rebuild from the source loses
 * the 2.0 fields, and the visual review's own label store may disagree with the 2.0 label:
 * the stricter label wins, except that "unknown" never replaces a label the review settled. */
function withLiveEnrichment(item: Prompt, live: Prompt): Prompt {
  const presentation = !item.presentation || (item.presentation === "unknown" && live.presentation && live.presentation !== "unknown") ? live.presentation
    : !live.presentation ? item.presentation
    : restrictiveness[item.presentation] >= restrictiveness[live.presentation] ? item.presentation : live.presentation;
  const inherited: Prompt = { ...item, ...(presentation ? { presentation } : {}) };
  if (item.facets) return inherited;
  for (const key of enrichmentKeys) if (live[key] !== undefined) Object.assign(inherited, { [key]: live[key] });
  const en = live.localization?.en;
  if (en) inherited.localization = item.localization ? { ...item.localization, en } : live.localization;
  return inherited;
}

/** The 2.0 gate for each edition. A new item is published only with a valid review of its
 * current content and a settled, publishable label (minors, explicit and unknown block it);
 * otherwise it leaves this edition, with one exclusion line when judged or deferred to a later
 * run when not. A live item keeps its 2.0 fields while its content is unchanged; edited
 * content is reviewed like a new item and, until it passes, the live version stays.
 * Without a provider (dry run) only stored outcomes are used. Caller holds daily.lock. */
export async function enrichNewItems(items: readonly Prompt[], live: ReadonlyMap<string, Prompt>, root: string, options: DailyEnrichmentOptions = {}) {
  const directory = join(root, "enrichment"), exclusions = join(directory, "exclusions.jsonl");
  const outcomePath = (id: string) => join(directory, "outcomes", `${id}.json`);
  const mediaPath = (id: string) => join(directory, "media", id);
  // Edited live content needs a review of its own, like a new item.
  const additions = items.filter(item => !item.facets && (!live.has(item.id) || reviewedContentHash(item) !== reviewedContentHash(live.get(item.id)!)));
  const report: DailyEnrichmentReport = { status: options.provider ? "reviewed" : "cached", additions: additions.length, reviewed: 0, requests: 0,
    failedRequests: 0, enriched: 0, excluded: 0, deferred: 0, ...(options.provider ? { provider: options.provider.id, model: options.provider.model } : {}) };
  const refused = await refusedIDs(exclusions);
  const stored = new Map<string, Stored>();
  for (const item of additions) {
    const value = await readFile(outcomePath(item.id), "utf8").then(text => storedSchema.parse(JSON.parse(text)), () => undefined);
    if (value?.hash === reviewedContentHash(item)) stored.set(item.id, value);
  }
  const fresh = new Set<string>(), media = new Map<string, PreparedEnrichmentMedia>();
  // New items first, so re-reviews of edited live content never crowd out today's additions.
  const pending = [...additions].sort((a, b) => Number(live.has(a.id)) - Number(live.has(b.id))).filter(item => !refused.has(item.id) &&
    (!stored.has(item.id) || (!stored.get(item.id)!.outcome.ok && stored.get(item.id)!.attempts < maxItemAttempts))).slice(0, options.maxItems ?? 120);
  if (options.provider && pending.length) {
    const provider = options.provider;
    // Media downloads and frame sampling, four at a time; batches keep the queue's order.
    const prepared = new Array<PreparedEnrichmentMedia>(pending.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      // New items are also judged for minors, so they always get the full gallery and frames.
      while (next < pending.length) { const index = next++; prepared[index] = await (options.prepare ?? prepareEnrichmentMedia)(pending[index], mediaPath(pending[index].id), true); }
    }));
    const candidates: EnrichmentCandidate[] = [];
    for (const [index, item] of pending.entries()) {
      const value = prepared[index];
      if (value.error) {
        await rm(mediaPath(item.id), { recursive: true, force: true });
        await recordExclusion(exclusions, { id: item.id, stage: "media", reason: `Media could not be prepared: ${value.error}` });
        continue;
      }
      media.set(item.id, value);
      candidates.push({ item, images: value.images.map(({ sourceRole: _, ...image }) => image), ...(value.video ? { video: value.video } : {}) });
    }
    const queue = packEnrichmentBatches(candidates, options.batchSize ?? 6).map(batch => ({ batch, split: false }));
    const call = async ({ batch, split }: { batch: EnrichmentCandidate[]; split: boolean }) => {
      report.requests++;
      try {
        const result = await reviewEnrichmentBatch(provider, batch, { effort: options.effort ?? "low", record: options.record });
        for (const [index, outcome] of result.outcomes.entries()) {
          const item = batch[index].item;
          const entry: Stored = { hash: reviewedContentHash(item), attempts: (stored.get(item.id)?.attempts ?? 0) + 1, provider: result.provider, model: result.model, outcome };
          await mkdir(join(directory, "outcomes"), { recursive: true });
          await writeFile(outcomePath(item.id), JSON.stringify(entry, null, 2));
          stored.set(item.id, entry);
          fresh.add(item.id); report.reviewed++;
        }
      } catch (error) {
        report.failedRequests++;
        const code = error instanceof ModelProviderError ? error.code : "failed";
        // A refusal is final for this content: excluded and never sent to another model.
        if (code === "refused") for (const { item } of batch) {
          refused.add(item.id);
          await recordExclusion(exclusions, { id: item.id, stage: "review", reason: "The model declined to review this content", refused: true, provider: provider.id, model: provider.model });
        }
        // A malformed envelope loses the whole call; retry the same model one item at a time.
        else if (code === "invalid_output" && batch.length > 1 && !split) queue.push(...batch.map(candidate => ({ batch: [candidate], split: true })));
        // Anything else defers the rest of the run's work; nothing is published unreviewed.
        else if (code === "unavailable" || code === "rate_limited") { report.status = "stopped"; report.stopped = `${code}: ${(error as Error).message.slice(0, 200)}`; queue.length = 0; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, queue.length) }, async () => {
      while (queue.length) await call(queue.shift()!);
    }));
  }
  /** The judged item, the reason it may not be published, or undefined while it waits. */
  const judge = async (item: Prompt): Promise<{ prompt: Prompt } | { reason: string; model?: string; logged?: boolean } | undefined> => {
    if (refused.has(item.id)) return { reason: "refused", logged: true };
    const value = stored.get(item.id);
    if (!value) return;
    const { outcome } = value;
    if (!outcome.ok) return { reason: `2.0 review invalid: ${outcome.error}`, model: value.model };
    // Only media prepared for the review; a dry run never downloads.
    const prepared = media.get(item.id) ?? await readFile(join(mediaPath(item.id), "prepared.json"), "utf8")
      .then(text => JSON.parse(text) as PreparedEnrichmentMedia, () => undefined);
    if (!prepared || prepared.error) return;
    let enriched: Prompt;
    // The visual review's label stands unless the new review is stricter.
    try { enriched = applyEnrichment(item, outcome, { palette: prepared.palette, video: prepared.video, policy: "stricter-only" }); }
    catch (error) { return { reason: (error as Error).message, model: value.model }; }
    const blocker = publicationBlocker(outcome.evidence, enriched.presentation);
    return blocker ? { reason: blocker, model: value.model } : { prompt: enriched };
  };
  const pendingIDs = new Set(additions.map(item => item.id)), prompts: Prompt[] = [];
  for (const item of items) {
    const current = live.get(item.id);
    if (!pendingIDs.has(item.id)) { prompts.push(current ? withLiveEnrichment(item, current) : item); continue; }
    const verdict = await judge(item);
    if (verdict && "prompt" in verdict) { report.enriched++; prompts.push(verdict.prompt); continue; }
    if (verdict && !verdict.logged && fresh.has(item.id))
      // Judgments are logged once, when they are made; later runs only count them.
      await recordExclusion(exclusions, { id: item.id, stage: "review", reason: verdict.reason, ...(verdict.model ? { model: verdict.model } : {}) });
    // Until edited live content passes its own review, the live version stays as it is.
    if (current) { prompts.push(current); continue; }
    if (verdict) report.excluded++; else report.deferred++;
  }
  return { prompts, report };
}
