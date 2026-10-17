import { join } from "node:path";
import { z } from "zod";
import { atomic, json } from "./publication.ts";
import type { Candidate } from "./sources.ts";
import { convertXDiscovery } from "./x-intake.ts";
import type { XExcerptReviews } from "./x-excerpts.ts";
import { nativeXSourceDigest, nativeXSourceIssue } from "./x-source.ts";
import { canonicalTwitterVideoURL, type TwitterAPIResult } from "./twitterapi.ts";
import { XBudgetExceeded, type XSpendPurpose } from "./x-spend.ts";

const attemptSchema = (limit: number) => z.object({ ids: z.array(z.string().regex(/^\d{1,19}$/)).min(1).max(limit),
  at: z.iso.datetime(), state: z.enum(["reserved", "completed", "failed"]) }).strict();
export type XRecheckProvider = "twitterapi" | "rapidapi";
export type XRecheckOptions = {
  provider?: XRecheckProvider;
  lookup: (ids: readonly string[], capture: (raw: unknown) => Promise<void>, purpose?: XSpendPurpose) => Promise<{
    raw: unknown; result: Pick<TwitterAPIResult, "posts" | "creators" | "media"> & { provider: XRecheckProvider };
  }>;
  maxRequests: number;
  protectedIDs?: ReadonlySet<string>;
  sleep?: (ms: number) => Promise<void> };

/** Compare the exact publishable revision and current attribution, not only text or a subset of media.
 * This is a verification signal for an already acquired official source, never a new acquisition.
 * Reply chains deliberately stay on joint official lookups.
 */
export function unchangedXStandalone(item: Candidate, result: Pick<TwitterAPIResult, "posts" | "creators" | "media">, capturedAt: string, excerpts: XExcerptReviews = {}) {
  if (item.source.context || !item.source.post || item.source.post.parentID || item.source.mediaPostID) return false;
  const post = result.posts.find(post => post.id === item.source.post!.id);
  if (!post || post.referenced_tweets?.length) return false;
  // The acquisition parser accepts at most 100 posts/snapshot. Verify just this
  // complete source, so a 200-ID maintenance batch cannot be rejected or truncated.
  const source = { posts: [post], creators: result.creators.filter(c => c.externalID === post.author_id),
    media: result.media.filter(m => post.attachments?.media_keys?.includes(m.media_key)), capturedAt };
  const next = convertXDiscovery([{ name: "third-party-verification", data: source }], {}, excerpts)
    .candidates.find(candidate => candidate.id === item.id);
  if (!next || nativeXSourceIssue(next, Date.parse(capturedAt)) || next.source.post?.authorID !== item.source.post.authorID) return false;
  const attribution = (value: Candidate) => [value.creator?.externalID, value.creator?.username, value.creator?.displayName,
    value.creator?.profileURL, value.creator?.avatarURL];
  if (JSON.stringify(attribution(next)) !== JSON.stringify(attribution(item))) return false;
  const digest = (value: Candidate) => nativeXSourceDigest({ ...value, media: value.media && { ...value.media,
    ...(value.media.videoURL ? { videoURL: canonicalTwitterVideoURL(value.media.videoURL) } : {}) } });
  return digest(item) === digest(next);
}

/** Caller holds daily.lock. Durable reservations survive restarts; uncertain requests are never repeated.
 * Only standalone posts with no thread dependencies may be passed here. Unknowns require official checks.
 */
export async function recheckXStandalone(root: string, candidates: readonly Candidate[], options: XRecheckOptions & {
  now: string; excerpts: XExcerptReviews;
  apply: (matched: readonly Candidate[], unresolved: readonly Candidate[]) => Promise<void>;
}) {
  if (!Number.isInteger(options.maxRequests) || options.maxRequests < 0 || options.maxRequests > 40) throw new Error("Invalid third-party recheck budget");
  if (!Number.isFinite(Date.parse(options.now))) throw new Error("Invalid third-party recheck time");
  if (candidates.some(item => !item.source.post || item.source.context || item.source.post.parentID)) throw new Error("Third-party recheck requires standalone sources");
  const provider = options.provider ?? "twitterapi";
  if (!["twitterapi", "rapidapi"].includes(provider)) throw new Error("Invalid recheck provider");
  const batchSize = provider === "rapidapi" ? 200 : 50;
  const attemptSchemaForProvider = attemptSchema(batchSize), ledgerSchema = z.array(attemptSchemaForProvider).max(40);
  // Keep old TwitterAPI.io files at their original paths; candidate attempts and
  // raw captures are never reinterpreted as another provider during rollback.
  const directory = provider === "rapidapi" ? join(root, "x-rechecks", provider) : join(root, "x-rechecks");
  const day = options.now.slice(0, 10), path = join(directory, `${day}.json`);
  const ledger = ledgerSchema.parse(await json(path, []));
  const report = { status: "cached", requests: 0, checked: 0, verified: 0, unresolved: 0 };
  if (ledger.some(attempt => attempt.state !== "completed") || ledger.length >= options.maxRequests)
    return { ...report, status: "daily-limit" };
  for (let offset = 0; offset < candidates.length && ledger.length < options.maxRequests;) {
    const protectedBatch = options.protectedIDs?.has(candidates[offset].id) ?? false;
    const batch: Candidate[] = [];
    while (offset < candidates.length && batch.length < batchSize && (options.protectedIDs?.has(candidates[offset].id) ?? false) === protectedBatch)
      batch.push(candidates[offset++]);
    const ids = batch.map(item => item.source.post!.id);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate recheck identities");
    // Retain conservative 0.2 QPS pacing for both providers, including the first
    // call of a new invocation, so consecutive processes cannot burst.
    await (options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(6500);
    const attempt: z.infer<typeof attemptSchemaForProvider> = { ids, at: options.now, state: "reserved" };
    ledger.push(attempt); await atomic(path, ledger); report.requests++;
    try {
      const evidence = join(directory, "responses", `${day}-${String(ledger.length).padStart(3, "0")}.json`);
      const { result } = await options.lookup(ids, raw => atomic(evidence, { provider, capturedAt: options.now, ids, raw }),
        protectedBatch ? "maintenance" : "growth");
      if (result.provider !== provider) throw new Error("Recheck response provider mismatch");
      if (result.posts.some(post => !ids.includes(post.id)) || new Set(result.posts.map(post => post.id)).size !== result.posts.length)
        throw new Error("Unrequested recheck identity");
      const matched = batch.filter(item => unchangedXStandalone(item, result, options.now, options.excerpts));
      const verified = new Set(matched.map(item => item.id)), unresolved = batch.filter(item => !verified.has(item.id));
      // Persist verification before completing the request. A crash in between is
      // blocked on the next run rather than repeating a billable request.
      await options.apply(matched, unresolved);
      attempt.state = "completed"; await atomic(path, ledger);
      report.status = "checked"; report.checked += ids.length; report.verified += matched.length; report.unresolved += unresolved.length;
    } catch (error) {
      if (error instanceof XBudgetExceeded) {
        // The spend guard rejected before HTTP. No paid/uncertain attempt is reset.
        ledger.pop(); await atomic(path, ledger); report.requests--; report.status = "budget-limited"; break;
      }
      attempt.state = "failed"; await atomic(path, ledger); report.status = "failed"; break;
    }
  }
  return report;
}
