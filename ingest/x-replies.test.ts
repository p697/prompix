import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomic } from "./publication.ts";
import { convertXDiscovery, readXIntake, hasPublicReplyPrompt, type XPost } from "./x-intake.ts";
import { analyzeXReplyThread, xReplyRequest, replyWindow, nextXReply, readXReplyCursors, type XReplyLead } from "./x-replies.ts";
import { collectXFeeds } from "./x-feed.ts";
import { parseXSearchResponse, type xFeedRequest } from "./x.ts";

const now = "2026-10-13T21:00:00.000Z";
const root: XPost = { id: "100", author_id: "9", text: "A new image. Prompt in first reply.", created_at: "2026-10-13T01:00:00.000Z" };
const creator = { id: "x-fixture", platform: "x" as const, externalID: "9", username: "fixture", displayName: "Fixture", profileURL: "https://x.com/fixture" };
const lead: XReplyLead = { post: root, creator, capturedAt: now, snapshot: "fixture.json", media: [] };
const reply = (id = "102", parent = "100"): XPost => ({ id, author_id: "9", text: "Image prompt: Create a watercolor painting of a blue lantern in a quiet garden.",
  created_at: "2026-10-13T02:00:00.000Z", conversation_id: "100", in_reply_to_user_id: "9", referenced_tweets: [{ type: "replied_to", id: parent }] });
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "prompix-replies-"));
  try { await atomic(join(directory, "x-discovery/2026-10-13-feed-001.json"), { capturedAt: now, posts: [root], creators: [creator] }); await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
function result(request: ReturnType<typeof xFeedRequest>, posts: XPost[], nextToken?: string) {
  const ids = posts.map(p => p.id).sort((a, b) => Number(b) - Number(a));
  return { ...parseXSearchResponse({ data: posts, includes: { users: [{ id: "9", username: "fixture", name: "Fixture" }] },
    meta: { result_count: posts.length, ...(posts.length ? { newest_id: ids[0], oldest_id: ids.at(-1) } : {}), ...(nextToken ? { next_token: nextToken } : {}) } }, undefined, request.limit), request };
}
const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));

test("reply queries request full relationship fields without altering ordinary discovery streams", () => {
  const request = xReplyRequest(lead), url = new URL(request.url);
  assert.equal(url.searchParams.get("query"), "conversation_id:100 from:fixture -is:retweet -is:quote");
  for (const field of ["note_tweet", "conversation_id", "in_reply_to_user_id", "referenced_tweets", "withheld"])
    assert.ok(url.searchParams.get("tweet.fields")!.split(",").includes(field));
  assert.equal(xReplyRequest(lead, "next", 10).fingerprint, request.fingerprint);
  assert.notEqual(xReplyRequest(lead, "next").requestFingerprint, request.requestFingerprint);
  assert.throws(() => xReplyRequest({ ...lead, creator: { ...creator, username: "a) OR all" } }));
  assert.throws(() => xReplyRequest({ ...lead, creator: { ...creator, externalID: "10" } }));
});

test("only explicit public reply locations become leads, never private giveaways or known replies", () => {
  for (const text of ["Prompt in first reply", "Prompt in the comments", "提示词在评论里", "プロンプトは返信にあります"]) assert.ok(hasPublicReplyPrompt(text), text);
  for (const text of ["Comment EARN and I'll DM the prompt", "DM for prompt", "Great replies!", "Prompt in replies; DM me for access"]) assert.equal(hasPublicReplyPrompt(text), false);
  const snapshot = { capturedAt: now, posts: [root], creators: [creator] };
  assert.equal(convertXDiscovery([{ name: "fixture", data: snapshot }]).replyLeads.length, 1);
  for (const changed of [{ ...root, withheld: {} }, { ...root, conversation_id: "50" }, { ...root, referenced_tweets: [{ type: "replied_to", id: "50" }] }])
    assert.equal(convertXDiscovery([{ name: "fixture", data: { ...snapshot, posts: [changed] } }]).replyLeads.length, 0);
  assert.equal(convertXDiscovery([{ name: "fixture", data: { ...snapshot, creators: [] } }]).replyLeads.length, 0);
});

test("same-author parent chains are chronological and preserve individual source texts", () => {
  const posts = [reply("103", "102"), reply()];
  const before = structuredClone(posts);
  const analysis = analyzeXReplyThread(root, posts, true);
  assert.equal(analysis.linked.length, 2);
  assert.deepEqual(analysis.linked.find(p => p.postID === "103")?.chain, ["100", "102", "103"]);
  assert.deepEqual(posts, before);
});

test("a shared conversation alone never proves author, parent, freshness or complete pagination", () => {
  const bad = [ { ...reply(), author_id: "8" }, { ...reply(), conversation_id: "200" },
    { ...reply(), in_reply_to_user_id: "8" }, { ...reply(), referenced_tweets: [] }, reply("102", "101"),
    { ...reply(), withheld: {} }, { ...reply(), created_at: "2026-10-12T01:00:00.000Z" },
    { ...reply(), referenced_tweets: [{ type: "replied_to", id: "100" }, { type: "quoted", id: "200" }] } ];
  for (const post of bad) assert.equal(analyzeXReplyThread(root, [post], true).linked.length, 0);
  assert.equal(analyzeXReplyThread(root, [reply()], false).blocked[0].reason, "incomplete-pagination");
  assert.equal(analyzeXReplyThread(root, [reply("102", "103"), reply("103", "102")], true).linked.length, 0);
  assert.equal(analyzeXReplyThread(root, [reply(), { ...root, author_id: "8" }], true).linked.length, 0);
  assert.equal(analyzeXReplyThread(root, [reply(), reply()], true).linked.length, 0);
});

test("reply pages spend the existing daily budget, resume after restart, and remain outside publication intake", () => fixture(async directory => {
  const options = { enabled: true, bearer: "fixture-secret", now: () => new Date(now), replyOnly: true };
  let calls = 0;
  const search = async (_: string, request: ReturnType<typeof xFeedRequest>) => {
    calls++;
    const ledger = await read(join(directory, "x-feed-attempts/2026-10-13.json"));
    assert.equal(ledger.attempts.at(-1).state, "reserved");
    assert.equal(ledger.attempts.at(-1).feed, "reply:100");
    if (calls === 1) { assert.equal(request.nextToken, undefined); return result(request, [reply("103", "102")], "older"); }
    assert.equal(request.nextToken, "older"); return result(request, [reply(), { ...root, conversation_id: "100" }]);
  };
  const first = await collectXFeeds(directory, { ...options, search, limits: { requests: 1, posts: 50 } });
  assert.equal(first.dailyRequests, 1);
  let cursor = (await readXReplyCursors(directory))[root.id];
  const path = join(directory, "x-replies", root.id, cursor.startedAt.replace(/[:.]/g, "-"), "analysis.json");
  assert.equal((await read(path)).linked.length, 0);
  const second = await collectXFeeds(directory, { ...options, search, limits: { requests: 2, posts: 100 } });
  assert.equal(second.dailyRequests, 2); assert.equal(second.reservedPosts, 100); assert.equal(calls, 2);
  cursor = (await readXReplyCursors(directory))[root.id]; assert.equal(cursor.completedAt, now);
  const analysis = await read(path); assert.equal(analysis.linked.length, 2); assert.equal(analysis.complete, true);
  const intake = await readXIntake(directory); assert.equal(intake.report.discovered, 1); assert.equal(intake.candidates.length, 0);
  const third = await collectXFeeds(directory, { ...options, search, limits: { requests: 4, posts: 200 } });
  assert.equal(third.requests, 0); assert.equal(calls, 2);
}));

test("failed reply requests stop all paid discovery that day and never leak the bearer", () => fixture(async directory => {
  let calls = 0;
  const options = { enabled: true, bearer: "secret-fixture", now: () => new Date(now), replyOnly: true,
    search: async () => { calls++; throw new Error("transport secret-fixture"); } };
  assert.equal((await collectXFeeds(directory, options)).message?.includes("secret-fixture"), false);
  assert.equal((await collectXFeeds(directory, { ...options, replyOnly: false })).status, "daily-limit");
  assert.equal(calls, 1); assert.deepEqual(await readXReplyCursors(directory), {});
}));

test("reply windows expire safely, keep separate query identities, and periodically discover later replies", () => {
  const requestIdentity = xReplyRequest(lead).fingerprint;
  const cursor = { startedAt: now, pages: 1, requestIdentity, nextToken: "page2" };
  assert.equal(replyWindow(lead, { "100": cursor }, now).nextToken, "page2");
  assert.equal(replyWindow(lead, { "100": cursor }, "2026-10-16T03:00:00Z").nextToken, undefined);
  assert.equal(replyWindow({ ...lead, creator: { ...creator, username: "renamed" } }, { "100": cursor }, now).nextToken, undefined);
  assert.equal(nextXReply([lead], { "100": { ...cursor, completedAt: now } }, now), undefined);
  assert.equal(nextXReply([lead], { "100": { ...cursor, completedAt: now } }, "2026-10-14T21:00:00Z")?.post.id, "100");
  assert.equal(nextXReply([lead], {}, "2026-10-20T03:00:00Z"), undefined);
});

test("ordinary runs reserve one in six calls for reply recovery under one budget", () => fixture(async directory => {
  const queries: string[] = [];
  const collected = await collectXFeeds(directory, { enabled: true, bearer: "fixture", now: () => new Date(now),
    limits: { requests: 6, posts: 300 }, search: async (_, request) => {
      queries.push(request.query); return result(request, request.conversation ? [reply()] : [{ ...root, id: "200", text: "A topic result." }]);
    } });
  assert.equal(collected.requests, 6);
  assert.match(queries[5], /^conversation_id:100/);
  assert.match(queries[0], /has:images/);
  assert.equal((await readXIntake(directory)).report.discovered, 2);
  assert.equal((await readXReplyCursors(directory))["100"].pages, 1);
}));

test("overlapping pages preserve raw snapshots while checking stable post fields for conflicts", () => fixture(async directory => {
  let page = 0;
  await collectXFeeds(directory, { enabled: true, replyOnly: true, bearer: "fixture", now: () => new Date(now),
    limits: { requests: 2, posts: 100 }, search: async (_, request) => {
      page++; return result(request, [{ ...reply(), ...({ public_metrics: { like_count: page } } as object) }], page === 1 ? "next" : undefined);
    } });
  const cursor = (await readXReplyCursors(directory))["100"];
  const dir = join(directory, "x-replies/100", cursor.startedAt.replace(/[:.]/g, "-"));
  const analysis = await read(join(dir, "analysis.json"));
  assert.equal(analysis.complete, true); assert.equal(analysis.linked.length, 1);
  assert.notEqual((await read(join(dir, "001.json"))).posts[0].public_metrics.like_count,
    (await read(join(dir, "002.json"))).posts[0].public_metrics.like_count);
}));

test("conflicting source text across pages cannot become a complete thread", () => fixture(async directory => {
  let page = 0;
  await collectXFeeds(directory, { enabled: true, replyOnly: true, bearer: "fixture", now: () => new Date(now),
    limits: { requests: 2, posts: 100 }, search: async (_, request) => {
      page++; return result(request, [{ ...reply(), text: reply().text + page }], page === 1 ? "next" : undefined);
    } });
  const cursor = (await readXReplyCursors(directory))["100"];
  const analysis = await read(join(directory, "x-replies/100", cursor.startedAt.replace(/[:.]/g, "-"), "analysis.json"));
  assert.equal(analysis.conflicting, true); assert.equal(analysis.linked.length, 0);
}));

test("a repeated reply page token stops the day's search budget without looping", () => fixture(async directory => {
  let calls = 0;
  const report = await collectXFeeds(directory, { enabled: true, replyOnly: true, bearer: "fixture", now: () => new Date(now),
    limits: { requests: 4, posts: 200 }, search: async (_, request) => { calls++; return result(request, [reply()], "unchanged"); } });
  assert.equal(report.status, "failed"); assert.equal(calls, 2);
  assert.equal((await readXReplyCursors(directory))["100"].pages, 1);
  assert.equal((await read(join(directory, "x-feed-attempts/2026-10-13.json"))).attempts[1].state, "failed");
}));
