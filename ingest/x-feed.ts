import { readXIntake } from "./x-intake.ts";
import { readXReplyCursors, nextXReply, replyWindow, xReplyRequest, saveXReplyPage } from "./x-replies.ts";
import { join } from "node:path";
import { z } from "zod";
import { atomic, json } from "./publication.ts";
import { searchXFeed, xFeedRequest } from "./x.ts";
import { mergeCreatorCache, type CreatorCache } from "./creators.ts";

const exclude = "-is:retweet -is:reply -is:quote";
// Independent discovery: topics span creators and tools, rather than mirroring
// another curator's contributor list. Keep each stream's progress independent.
export const xFeeds = [
  { id: "image", query: `(prompt OR 提示词 OR プロンプト) ("nano banana" OR "gpt image" OR midjourney OR flux) has:images ${exclude}` },
  { id: "video", query: `(prompt OR 提示词 OR プロンプト) (seedance OR veo OR sora OR kling OR runway) has:videos ${exclude}` },
  { id: "text", query: `(prompt OR 提示词 OR プロンプト) (ChatGPT OR Claude) (writing OR story OR tarot OR productivity OR 写作 OR 塔罗) ${exclude}` },
  { id: "web", query: `(prompt OR 提示词) (website OR "landing page" OR "web app" OR 网页) (v0 OR lovable OR bolt OR Claude) ${exclude}` },
  { id: "skills", query: `("SKILL.md" OR "agent skill" OR "agent skills") (github OR clawhub OR "claude code" OR codex) ${exclude}` },
] as const;
const id = z.string().regex(/^\d{1,19}$/);
const cursorSchema = z.object({
  since: id.optional(), nextToken: z.string().min(1).max(2000).optional(),
  newest: id.optional(), startedAt: z.iso.datetime().optional(),
});
const stateSchema = z.object({
  nextFeed: z.number().int().nonnegative().default(0),
  cursors: z.record(z.string().regex(/^[a-f0-9]{64}$/), cursorSchema).default({}),
});
const attemptSchema = z.object({
  feed: z.string(), request: z.string(), reservedPosts: z.number().int().nonnegative(),
  state: z.enum(["reserved", "completed", "failed"]), count: z.number().int().nonnegative().optional(),
});
const ledgerSchema = z.object({
  legacyRequests: z.number().int().nonnegative(), legacyPosts: z.number().int().nonnegative(),
  attempts: z.array(attemptSchema).max(20),
});
const legacySchema = z.object({ day: z.string().optional() }).passthrough();
export function xFeedLimits(env: NodeJS.ProcessEnv = process.env) {
  const bounded = (name: string, fallback: number, max: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  return { requests: bounded("PROMPIX_X_MAX_REQUESTS", 4, 20), posts: bounded("PROMPIX_X_MAX_POSTS", 200, 1000) };
}
export type XFeedReport = {
  status: "dry-run" | "not-configured" | "ok" | "daily-limit" | "no-pending" | "failed";
  requests: number; count: number; creators: number; dailyRequests: number; reservedPosts: number;
  limits: ReturnType<typeof xFeedLimits>; feeds: { id: string; count: number; hasNextPage: boolean }[];
  message?: string;
};

/** Caller holds the content lock. Failed/uncertain paid attempts are never retried that day. */
export async function collectXFeeds(root: string, options: {
  enabled: boolean; bearer?: string; now?: () => Date;
  limits?: ReturnType<typeof xFeedLimits>; search?: typeof searchXFeed; replyOnly?: boolean;
}) {
  const now = options.now ?? (() => new Date()), day = now().toISOString().slice(0, 10);
  const limits = options.limits ?? xFeedLimits();
  if (!Number.isInteger(limits.requests) || limits.requests < 0 || limits.requests > 20 ||
      !Number.isInteger(limits.posts) || limits.posts < 0 || limits.posts > 1000) throw new Error("Invalid X collection limits");
  const report: XFeedReport = { status: "dry-run", requests: 0, count: 0, creators: 0,
    dailyRequests: 0, reservedPosts: 0, limits, feeds: [] };
  if (!options.enabled) return report;
  if (!options.bearer) return { ...report, status: "not-configured" as const };
  const path = join(root, "x-feed-state.json"), ledgerPath = join(root, "x-feed-attempts", `${day}.json`);
  const state = stateSchema.parse(await json(path, {}));
  const creatorsPath = join(root, "creators.json");
  let creators = await json<CreatorCache>(creatorsPath, {});
  const legacy = legacySchema.parse(await json(join(root, "x-state.json"), {}));
  // Migrating from the old one-request collector preserves what was spent today.
  const ledger = ledgerSchema.parse(await json(ledgerPath, {
    legacyRequests: legacy.day === day ? 1 : 0, legacyPosts: legacy.day === day ? 10 : 0, attempts: [],
  }));
  const refreshTotals = () => {
    report.dailyRequests = ledger.legacyRequests + ledger.attempts.length;
    report.reservedPosts = ledger.legacyPosts + ledger.attempts.reduce((sum, a) => sum + a.reservedPosts, 0);
  };
  refreshTotals();
  if (ledger.attempts.some(a => a.state !== "completed")) return { ...report, status: "daily-limit" as const };
  const leads = (await readXIntake(root, creators)).replyLeads;
  let replyCursors = await readXReplyCursors(root);
  while (report.dailyRequests < limits.requests && limits.posts - report.reservedPosts >= 10) {
    if (now().toISOString().slice(0, 10) !== day) break;
    const feed = xFeeds[state.nextFeed % xFeeds.length];
    const limit = Math.min(50, limits.posts - report.reservedPosts);
    const fingerprint = xFeedRequest(feed.query, { limit }).fingerprint;
    let cursor = state.cursors[fingerprint] ?? {};
    // Pagination cursors are ephemeral. Restart an old window from its committed
    // high-water mark; snapshot identity deduplication makes overlaps harmless.
    if (cursor.nextToken && (!cursor.startedAt || now().getTime() - Date.parse(cursor.startedAt) > 48 * 3600_000)) {
      cursor = { since: cursor.since };
    }
    // Alternate reply recovery and fresh topics. Repeated invocations preserve this
    // choice through the same daily ledger, rather than resetting an extra budget.
    const reply = options.replyOnly || ledger.attempts.length % 2 === 0 ? nextXReply(leads, replyCursors, now().toISOString()) : undefined;
    if (options.replyOnly && !reply) { report.status = "no-pending"; break; }
    const request = reply ? xReplyRequest(reply, replyWindow(reply, replyCursors, now().toISOString()).nextToken, limit)
      : xFeedRequest(feed.query, { limit, since: cursor.since, nextToken: cursor.nextToken });
    const feedID = reply ? `reply:${reply.post.id}` : feed.id;
    const attempt: z.infer<typeof attemptSchema> = { feed: feedID, request: request.requestFingerprint, reservedPosts: limit, state: "reserved" };
    ledger.attempts.push(attempt);
    await atomic(ledgerPath, ledger);
    // The old lookup command cannot claim a fresh daily slot after this collector.
    await atomic(join(root, "x-state.json"), { ...legacy, day });
    report.requests++; refreshTotals();
    try {
      const result = await (options.search ?? searchXFeed)(options.bearer, request);
      if (result.request.requestFingerprint !== request.requestFingerprint || result.posts.length > limit)
        throw new Error("X feed response does not match its request");
      creators = mergeCreatorCache(creators, result.creators);
      await atomic(creatorsPath, creators);
      if (reply) {
        const saved = await saveXReplyPage(root, reply, replyCursors, now().toISOString(), result);
        replyCursors = saved.cursors;
      } else {
        const snapshot = `${day}-feed-${String(ledger.attempts.length).padStart(3, "0")}.json`;
        await atomic(join(root, "x-discovery", snapshot), { ...result, capturedAt: now().toISOString(), feed: feed.id, reviewStatus: "draft" });
        const newest = [cursor.newest, result.newest].filter((v): v is string => !!v)
          .sort((a, b) => BigInt(a) > BigInt(b) ? -1 : 1)[0];
        // Commit the high-water mark only after the entire paginated window is read.
        // Otherwise a popular stream loses every page after its newest fifty posts.
        state.cursors[fingerprint] = result.nextToken
          ? { ...cursor, nextToken: result.nextToken, newest, startedAt: cursor.startedAt ?? now().toISOString() }
          : { since: newest ?? cursor.since };
        state.nextFeed = (state.nextFeed + 1) % xFeeds.length;
        await atomic(path, state);
      }
      attempt.state = "completed"; attempt.count = result.posts.length;
      await atomic(ledgerPath, ledger);
      report.count += result.posts.length; report.creators += result.creators.length;
      report.feeds.push({ id: feedID, count: result.posts.length, hasNextPage: !!result.nextToken });
    } catch (error) {
      attempt.state = "failed";
      await atomic(ledgerPath, ledger);
      report.status = "failed";
      report.message = (error instanceof Error ? error.message : "X feed failed").replaceAll(options.bearer, "[redacted]").slice(0, 300);
      return report;
    }
  }
  report.status = report.requests ? "ok" : report.status === "no-pending" ? "no-pending" : "daily-limit";
  return report;
}
