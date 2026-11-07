import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Prompt } from "../packages/schema/catalog.ts";
import { prepareEnrichmentMedia } from "./enrichment-media.ts";
import { packEnrichmentBatches, type EnrichmentCandidate } from "./enrichment-review.ts";
import { mirrorPromptMediaBatch } from "./mirror-media.ts";
import type { ModelCallSummary } from "./models/call.ts";
import { ModelProviderError, type Effort, type ModelProvider } from "./models/types.ts";
import { atomic, json } from "./publication.ts";
import { applyReview, reviewBatch, reviewBlocker, type ReviewOutcome } from "./review-pass.ts";
import type { Candidate } from "./sources.ts";
import { portraitShare } from "./x-search-rules.ts";

/** The judged source: an outcome stays valid while the post and its media are unchanged. */
export const reviewPassHash = (item: Candidate) => createHash("sha256").update(JSON.stringify([item.id, item.fingerprint, item.source.revision ?? null])).digest("hex");
const storedSchema = z.object({ hash: z.string(), attempts: z.number().int().min(1), provider: z.string(), model: z.string(),
  at: z.iso.datetime().optional(), creator: z.string().optional(),
  outcome: z.custom<ReviewOutcome>(value => !!value && typeof value === "object") });
type Stored = z.infer<typeof storedSchema>;
/** A failed judgment is retried once on a later night, then waits for the post to change. */
const maxAttempts = 2;
/** Rejected posts, by id and judged hash, so source maintenance stops spending rechecks on them. */
export const reviewPassRejectionsPath = (root: string) => join(root, "review-pass", "rejected.json");
export async function reviewPassRejections(root: string): Promise<Record<string, string>> {
  return json<Record<string, string>>(reviewPassRejectionsPath(root), {});
}

const postID = (item: Candidate) => BigInt(item.source.post?.id ?? "0");
const newestFirst = (a: Candidate, b: Candidate) => postID(a) > postID(b) ? -1 : postID(a) < postID(b) ? 1 : 0;

export type DailyReviewReport = { pending: number; reviewed: number; requests: number; failedRequests: number; approved: number;
  rejected: number; deferredPortraits: number; waiting: number; stopped?: string; reasons: Record<string, number> };
export type DailyReviewOptions = { provider?: ModelProvider; effort?: Effort; record?: (summary: ModelCallSummary) => Promise<void>;
  maxItems?: number; mirror?: typeof mirrorPromptMediaBatch; prepare?: typeof prepareEnrichmentMedia };

/** The single review for new X posts (owner, 2026-11-07), replacing the editorial, visual and
 * 2.0 reviews for them. Newest posts first, at most `maxItems` a night. Approved posts come back
 * as candidates carrying the review's cards, labels and tags; the rest stay out. Portraits and
 * people fill at most half of the night's approvals; the others wait for a later night. Without
 * a provider (dry run) only stored outcomes are used. Caller holds daily.lock. */
export async function reviewDailyX(items: readonly Candidate[], root: string, options: DailyReviewOptions = {}) {
  const directory = join(root, "review-pass"), outcomePath = (id: string) => join(directory, "outcomes", `${id}.json`);
  const report: DailyReviewReport = { pending: 0, reviewed: 0, requests: 0, failedRequests: 0, approved: 0, rejected: 0, deferredPortraits: 0, waiting: 0, reasons: {} };
  const stored = new Map<string, Stored>();
  for (const item of items) {
    const value = await readFile(outcomePath(item.id), "utf8").then(text => storedSchema.parse(JSON.parse(text)), () => undefined);
    if (value?.hash === reviewPassHash(item)) stored.set(item.id, value);
  }
  const pending = items.filter(item => !stored.has(item.id) || (!stored.get(item.id)!.outcome.ok && stored.get(item.id)!.attempts < maxAttempts))
    .sort(newestFirst).slice(0, options.maxItems ?? 240);
  report.pending = pending.length;
  if (options.provider && pending.length) {
    const provider = options.provider, mediaRoot = join(directory, "media");
    // The review sees the mirrored media; publication mirrors the same URLs again from the media map.
    const mirrored = await (options.mirror ?? mirrorPromptMediaBatch)(pending, root, 3);
    const save = async (item: Candidate, outcome: ReviewOutcome, served: { provider: string; model: string }) => {
      const entry: Stored = { hash: reviewPassHash(item), attempts: (stored.get(item.id)?.attempts ?? 0) + 1, ...served,
        at: new Date().toISOString(), ...(item.creator?.platform === "x" && item.creator.username ? { creator: item.creator.username } : {}), outcome };
      await mkdir(join(directory, "outcomes"), { recursive: true });
      await writeFile(outcomePath(item.id), JSON.stringify(entry, null, 2));
      stored.set(item.id, entry);
    };
    const byID = new Map(pending.map(item => [item.id, item]));
    for (const failure of mirrored.errors) await save(byID.get(failure.id)!, { id: failure.id, ok: false, error: `media: ${failure.error}` }, { provider: "pipeline", model: "media" });
    const candidates: EnrichmentCandidate[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, mirrored.prompts.length) }, async () => {
      while (next < mirrored.prompts.length) {
        const item = mirrored.prompts[next++], prepared = await (options.prepare ?? prepareEnrichmentMedia)(item, join(mediaRoot, item.id), true);
        if (prepared.error) await save(byID.get(item.id)!, { id: item.id, ok: false, error: `media: ${prepared.error}` }, { provider: "pipeline", model: "media" });
        else candidates.push({ item, images: prepared.images.map(({ sourceRole: _, ...image }) => image), ...(prepared.video ? { video: prepared.video } : {}) });
      }
    }));
    candidates.sort((a, b) => pending.indexOf(byID.get(a.item.id)!) - pending.indexOf(byID.get(b.item.id)!));
    const queue = packEnrichmentBatches(candidates, 6).map(batch => ({ batch, split: false }));
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) {
        const { batch, split } = queue.shift()!;
        report.requests++;
        try {
          const result = await reviewBatch(provider, batch, { effort: options.effort, record: options.record });
          for (const outcome of result.outcomes) { await save(byID.get(outcome.id)!, outcome, result); report.reviewed++; }
        } catch (error) {
          report.failedRequests++;
          const code = error instanceof ModelProviderError ? error.code : "failed";
          // A malformed envelope loses the whole call; retry one item at a time.
          if (code === "invalid_output" && batch.length > 1 && !split) queue.push(...batch.map(candidate => ({ batch: [candidate], split: true })));
          // A refusal is final for that content; anything else defers the rest of tonight's reviews.
          else if (code === "refused") for (const { item } of batch) await save(byID.get(item.id)!, { id: item.id, ok: false, error: "refused" }, { provider: provider.id, model: provider.model });
          else if (code === "unavailable" || code === "rate_limited") { report.stopped = `${code}: ${(error as Error).message.slice(0, 200)}`; queue.length = 0; }
        }
      }
    }));
    await rm(mediaRoot, { recursive: true, force: true });
  }
  const approved: Candidate[] = [], rejections = await reviewPassRejections(root);
  // Newest first, so the portrait share keeps the freshest work.
  for (const item of [...items].sort(newestFirst)) {
    const value = stored.get(item.id);
    if (!value) { report.waiting++; continue; }
    const { outcome } = value;
    const blocker = outcome.ok ? reviewBlocker(outcome.fields) : outcome.error === "refused" || value.attempts >= maxAttempts ? "invalid" : undefined;
    if (!outcome.ok && !blocker) { report.waiting++; continue; }
    if (blocker || !outcome.ok) {
      report.rejected++; rejections[item.id] = value.hash;
      for (const reason of (blocker ?? "invalid").split(", ")) report.reasons[reason] = (report.reasons[reason] ?? 0) + 1;
      continue;
    }
    delete rejections[item.id];
    approved.push({ ...applyReview(item, outcome.fields), fingerprint: item.fingerprint, featured: false, reviewStatus: "candidate", editorialRank: 0 });
  }
  await mkdir(directory, { recursive: true });
  await atomic(reviewPassRejectionsPath(root), rejections);
  const person = (item: Prompt) => !!(item.facets?.useCase.includes("portraits") || item.facets?.subject.includes("person"));
  const portraitLimit = Math.ceil(approved.length * portraitShare);
  let portraits = 0;
  const kept = approved.filter(item => !person(item) || ++portraits <= portraitLimit);
  report.deferredPortraits = approved.length - kept.length;
  report.approved = kept.length;
  return { approved: kept, report };
}

/** Creators the single review approved at least twice in the last two weeks, at most half of
 * it portraits: the search then follows them like the curated list (research, 2026-11-07). */
export async function reviewedCreators(root: string, now = Date.now(), limit = 24): Promise<string[]> {
  const directory = join(root, "review-pass", "outcomes"), counts = new Map<string, { approved: number; portraits: number }>();
  const names = await readdir(directory).catch(() => [] as string[]);
  for (const name of names.filter(value => value.endsWith(".json"))) {
    const value = await readFile(join(directory, name), "utf8").then(text => storedSchema.safeParse(JSON.parse(text)), () => undefined);
    if (!value?.success || !value.data.creator || !value.data.at || now - Date.parse(value.data.at) > 14 * 86400_000) continue;
    const { outcome } = value.data;
    if (!outcome.ok || reviewBlocker(outcome.fields)) continue;
    const entry = counts.get(value.data.creator) ?? { approved: 0, portraits: 0 };
    entry.approved++;
    if (outcome.fields.facets.useCase.includes("portraits") || outcome.fields.facets.subject.includes("person")) entry.portraits++;
    counts.set(value.data.creator, entry);
  }
  return [...counts].filter(([username, { approved, portraits }]) => /^[A-Za-z0-9_]{1,15}$/.test(username) && approved >= 2 && portraits * 2 <= approved)
    .sort((a, b) => b[1].approved - a[1].approved || a[0].localeCompare(b[0])).slice(0, limit).map(([username]) => username);
}
