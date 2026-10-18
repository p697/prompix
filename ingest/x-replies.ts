import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { atomic, json } from "./publication.ts";
import { readXIntake, xPostSchema, fullXText, type XPost } from "./x-intake.ts";
import { xFeedRequest } from "./x.ts";

import type { XFeedSearchResult } from "./x-feed.ts";
export type XReplyDirectory = "x-replies" | "x-replies-twitterapi";
export type XReplyLead = Awaited<ReturnType<typeof readXIntake>>["replyLeads"][number];
const cursorSchema = z.object({ nextToken: z.string().min(1).max(2000).optional(),
  startedAt: z.iso.datetime(), completedAt: z.iso.datetime().optional(), pages: z.number().int().min(0).max(20),
  exhausted: z.boolean().optional(), requestIdentity: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const cursorsSchema = z.record(z.string().regex(/^\d{1,19}$/), cursorSchema);
export type XReplyCursors = z.infer<typeof cursorsSchema>;
export async function readXReplyCursors(root: string, namespace: XReplyDirectory = "x-replies") {
  return cursorsSchema.parse(await json(join(root, namespace, "cursors.json"), {}));
}
export function xReplyRequest(lead: XReplyLead, nextToken?: string, limit = 50) {
  if (!/^\d{1,19}$/.test(lead.post.id) || !/^\d{1,19}$/.test(lead.post.author_id) ||
      lead.creator.externalID !== lead.post.author_id || !/^[a-z0-9_]{1,15}$/i.test(lead.creator.username ?? ""))
    throw new Error("Invalid X reply source identity");
  return xFeedRequest(`conversation_id:${lead.post.id} from:${lead.creator.username} -is:retweet -is:quote`,
    { nextToken, limit, conversation: true });
}
/** Replay the two known capture contracts only. Never send the older request or
 * grant it a new check time; live reads always use current author restrictions. */
export function recordedXReplyRequests(lead: XReplyLead, nextToken?: string, limit = 50) {
  const current = xReplyRequest(lead, nextToken, limit), url = new URL(current.url);
  const olderUserFields = "id,name,username,profile_image_url,description,url";
  if (url.searchParams.get("user.fields") !== `${olderUserFields},protected,withheld`) return [current];
  url.searchParams.set("user.fields", olderUserFields);
  const fields = Object.fromEntries(["tweet.fields", "expansions", "user.fields", "media.fields"].map(key => [key, url.searchParams.get(key)]));
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  return [current, { ...current, url: url.toString(), requestFingerprint: digest(url.toString()),
    fingerprint: digest(JSON.stringify([`${url.origin}${url.pathname}`, current.query, fields])) }];
}
/** Oldest unchecked roots first. Completed roots may gain replies; rescan after 24 hours. */
export function nextXReply(roots: readonly XReplyLead[], cursors: XReplyCursors, now: string) {
  const time = Date.parse(now);
  if (!Number.isFinite(time)) throw new Error("Invalid reply collection time");
  return roots.filter(lead => {
    const age = time - Date.parse(lead.post.created_at!);
    if (age < -60_000 || age > 6 * 86400_000) return false;
    const cursor = cursors[lead.post.id];
    return !cursor || cursor.requestIdentity !== xReplyRequest(lead).fingerprint ||
      (!cursor.completedAt && !cursor.exhausted) || time - Date.parse(cursor.completedAt ?? cursor.startedAt) >= 86400_000;
  }).sort((a, b) => Date.parse(cursors[a.post.id]?.completedAt ?? cursors[a.post.id]?.startedAt ?? "1970-01-01") -
    Date.parse(cursors[b.post.id]?.completedAt ?? cursors[b.post.id]?.startedAt ?? "1970-01-01") || a.post.id.localeCompare(b.post.id))[0];
}
export function replyWindow(lead: XReplyLead, cursors: XReplyCursors, now: string) {
  const prior = cursors[lead.post.id], requestIdentity = xReplyRequest(lead).fingerprint;
  return prior && prior.requestIdentity === requestIdentity && !prior.completedAt && !prior.exhausted &&
    Date.parse(now) - Date.parse(prior.startedAt) < 48 * 3600_000
    ? prior : { startedAt: now, pages: 0, requestIdentity };
}

/** Relationship evidence only. Never merge source prose or inherit root media into replies. */
export function analyzeXReplyThread(root: XPost, values: readonly unknown[], complete: boolean) {
  const posts = new Map<string, XPost>();
  const invalid: string[] = [];
  for (const value of values) {
    const parsed = xPostSchema.safeParse(value);
    if (!parsed.success) { invalid.push("invalid-post"); continue; }
    const post = parsed.data;
    if (posts.has(post.id)) { invalid.push(`duplicate:${post.id}`); continue; }
    posts.set(post.id, post);
  }
  const source = posts.get(root.id) ?? root;
  const rootValid = source.author_id === root.author_id && source.withheld === undefined &&
    (!source.conversation_id || source.conversation_id === root.id) && !source.referenced_tweets?.some(ref => ref.type === "replied_to" || ref.type === "retweeted" || ref.type === "quoted");
  const linked: { postID: string; chain: string[]; textSource: string }[] = [], blocked: { postID: string; reason: string }[] = [];
  for (const post of posts.values()) {
    if (post.id === root.id) continue;
    let current = post;
    const chain: string[] = [], seen = new Set<string>();
    let reason: string | undefined;
    while (current.id !== root.id) {
      if (seen.has(current.id)) { reason = "cyclic-parent-chain"; break; }
      if (chain.length >= 8) { reason = "parent-chain-too-deep"; break; }
      seen.add(current.id); chain.unshift(current.id);
      if (current.withheld !== undefined || current.author_id !== root.author_id || current.conversation_id !== root.id ||
          !current.created_at || Date.parse(current.created_at) < Date.parse(root.created_at ?? "")) { reason = "unverified-author-or-conversation"; break; }
      const parents = current.referenced_tweets?.filter(ref => ref.type === "replied_to") ?? [];
      if (parents.length !== 1 || current.referenced_tweets?.some(ref => ref.type === "quoted" || ref.type === "retweeted") ||
          current.in_reply_to_user_id !== root.author_id) { reason = "unverified-parent"; break; }
      const parent = parents[0].id === root.id ? source : posts.get(parents[0].id);
      if (!parent) { reason = "missing-parent"; break; }
      if (!parent.created_at || Date.parse(parent.created_at) > Date.parse(current.created_at)) { reason = "invalid-parent-time"; break; }
      current = parent;
    }
    if (!rootValid) reason = "invalid-root";
    if (!complete) reason = "incomplete-pagination";
    if (invalid.length) reason = "invalid-thread-snapshot";
    if (reason) blocked.push({ postID: post.id, reason });
    else linked.push({ postID: post.id, chain: [root.id, ...chain], textSource: fullXText(post).source });
  }
  return { rootID: root.id, complete, linked, blocked, invalid };
}

/** Caller owns content and shared paid-search locks/budget. Files here never enter ordinary intake. */
export async function saveXReplyPage(root: string, lead: XReplyLead, cursors: XReplyCursors, now: string,
  result: XFeedSearchResult, namespace: XReplyDirectory = "x-replies") {
  const window = replyWindow(lead, cursors, now);
  if (result.rootCheck && !window.pages) {
    const checkedAt = Date.parse(result.rootCheck.capturedAt), capturedAt = Date.parse(now);
    if (!Number.isFinite(checkedAt) || checkedAt > capturedAt || capturedAt - checkedAt > 120_000)
      throw new Error("Invalid reply root check time");
    window.startedAt = new Date(Math.min(Date.parse(window.startedAt), checkedAt)).toISOString();
  }
  const expected = xReplyRequest(lead, window.nextToken, result.request.limit);
  if (result.request.requestFingerprint !== expected.requestFingerprint) throw new Error("Reply page request mismatch");
  const directory = join(root, namespace, lead.post.id, window.startedAt.replace(/[:.]/g, "-"));
  const page = window.pages + 1;
  // Preserve each exact API snapshot separately, including unrelated/rejected returned posts.
  await atomic(join(directory, `${String(page).padStart(3, "0")}.json`), { ...result, capturedAt: now, root: lead });
  if (result.nextToken && result.nextToken === result.request.nextToken) throw new Error("X reply pagination token did not advance");
  const all: unknown[] = [];
  for (let index = 1; index <= page; index++) {
    const path = join(directory, `${String(index).padStart(3, "0")}.json`);
    if ((await stat(path)).size > 9_000_000) throw new Error("Oversized reply snapshot");
    const snapshot = JSON.parse(await readFile(path, "utf8")) as { posts: unknown[] };
    all.push(...snapshot.posts);
  }
  // Repeated IDs across overlapping pages are valid only when the exact source is unchanged.
  const deduplicated = new Map<string, unknown>(); let conflicting = false;
  for (const post of all) {
    const parsed = xPostSchema.parse(post), previous = deduplicated.get(parsed.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(parsed)) conflicting = true;
    deduplicated.set(parsed.id, parsed);
  }
  const analysis = analyzeXReplyThread(lead.post, [...deduplicated.values()], !result.nextToken && !conflicting);
  const exhausted = !!result.nextToken && page >= 20;
  await atomic(join(directory, "analysis.json"), { ...analysis, conflicting, exhausted, capturedAt: now, reviewStatus: "draft" });
  const next = { ...cursors, [lead.post.id]: { ...window, pages: page, nextToken: result.nextToken,
    ...(!result.nextToken ? { completedAt: now } : {}), ...(exhausted ? { exhausted: true } : {}) } };
  await atomic(join(root, namespace, "cursors.json"), cursorsSchema.parse(next));
  return { cursors: next, analysis, directory };
}
