import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTwitterAPI, TwitterAPIClient, twitterAPIQuery, canonicalTwitterVideoURL } from "./twitterapi.ts";
import { XSpendBudget, XBudgetExceeded } from "./x-spend.ts";
import { json, atomic } from "./publication.ts";
import { fullXText, extractMarkedXPrompt } from "./x-intake.ts";
import { TransientXReadError } from "./x.ts";
const tweet = { id: "101", text: "Original instructions", createdAt: "Fri Oct 16 10:00:00 +0000 2026", isReply: false,
  author: { id: "42", userName: "fixture", name: "Fixture" } };
const photo = { id_str: "501", type: "photo", media_url_https: "https://pbs.twimg.com/media/fixture.jpg" };
const page = (tweets: unknown[]) => ({ tweets, has_next_page: false, next_cursor: "" });
test("normalization preserves complete long text, media identity, video variants and author reply links", () => {
  const long = "Complete source. ".repeat(100);
  const result = parseTwitterAPI(page([{ ...tweet, text: "Display…", note_tweet: { text: long },
    isReply: true, inReplyToId: "100", inReplyToUserId: "42", conversationId: "100",
    extendedEntities: { media: [photo, { ...photo, id_str: "502", type: "video", video_info: { variants: [
      { content_type: "video/mp4", url: "https://video.twimg.com/fixture.mp4", bitrate: 256000 } ] } }] } }]), { search: true });
  assert.equal(fullXText(result.posts[0]).text, long);
  assert.deepEqual(result.posts[0].referenced_tweets, [{ type: "replied_to", id: "100" }]);
  assert.equal(result.posts[0].in_reply_to_user_id, "42");
  assert.deepEqual(result.posts[0].attachments?.media_keys, ["501", "502"]);
  assert.equal(result.media[1].variants?.[0].bit_rate, 256000);
  assert.equal(result.creators[0].externalID, "42");
});
test("missing, private, unavailable and empty placeholders remain unknown rather than deleted", () => {
  const result = parseTwitterAPI({ tweets: [tweet, { id: "" }, { ...tweet, id: "102", author: { ...tweet.author, unavailable: true } }] }, { ids: ["101", "102", "103"] });
  assert.deepEqual(result.unknownIDs, ["102", "103"]);
  assert.equal("unavailable" in result, false);
});
test("invalid attribution, partial replies, duplicate IDs and ambiguous cursors fail closed", () => {
  for (const body of [page([tweet, tweet]), page([{ ...tweet, author: { ...tweet.author, userName: "invalid name" } }]),
    page([{ ...tweet, isReply: true }]), { tweets: [], has_next_page: true, next_cursor: "" }, { tweets: [], error: "failed" }])
    assert.throws(() => parseTwitterAPI(body, { search: true }));
  assert.throws(() => parseTwitterAPI(page([tweet]), { ids: ["999"] }), /identities/);
  assert.throws(() => parseTwitterAPI(page([{ ...tweet, extendedEntities: { media: [{ ...photo, id_str: undefined }] } }])), /identity/);
});
test("existing visual and reply queries retain their scope with provider-specific operators", () => {
  assert.equal(twitterAPIQuery('(prompt OR 提示词) has:images -is:reply -is:quote -is:retweet'),
    '(prompt OR 提示词) filter:images -filter:replies -filter:quote -filter:retweets');
  assert.equal(twitterAPIQuery('conversation_id:123 from:fixture -is:retweet'), 'conversation_id:123 from:fixture -filter:retweets');
});
test("client reserves before network, refuses redirects and retains ambiguous spend without leaking keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-twitterapi-"));
  try {
    const budget = new XSpendBudget(root, 20, 0.003, () => new Date("2026-10-17T00:00:00Z"));
    let calls = 0;
    const client = new TwitterAPIClient("secret-fixture", budget, (async (_url, options) => {
      calls++;
      const ledger = await json<any>(join(root, "2026-10.json"), null);
      assert.equal(ledger.entries[0].state, "reserved");
      assert.equal(options?.redirect, "manual");
      throw new Error("secret-fixture");
    }) as typeof fetch);
    await assert.rejects(client.search("prompt"), e => e instanceof Error && !e.message.includes("secret-fixture"));
    await assert.rejects(client.search("prompt"), /budget/);
    assert.equal(calls, 1);
    const ledger = await json<any>(join(root, "2026-10.json"), null);
    assert.equal(ledger.entries[0].accounted, 3000);
    assert.equal(ledger.entries[0].state, "uncertain");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("HTTP redirects, rate limits, server errors and invalid JSON do not trigger retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-twitterapi-http-"));
  try {
    for (const status of [302, 429, 500, 200]) {
      let calls = 0;
      const budget = new XSpendBudget(join(root, String(status)), 20, 1, () => new Date("2026-10-17T00:00:00Z"));
      const client = new TwitterAPIClient("fixture-secret", budget, (async () => {
        calls++; return new Response("not-json", { status, headers: { location: "https://example.com" } });
      }) as typeof fetch);
      await assert.rejects(client.search("prompt"), status === 200 ? /invalid or oversized JSON/ : new RegExp(`HTTP ${status}`));
      assert.equal(calls, 1);
      const ledger = await json<any>(join(root, String(status), "2026-10.json"), null);
      assert.equal(ledger.entries[0].state, "uncertain");
      assert.equal(ledger.entries[0].accounted, 3000);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("captures malformed source evidence for offline repair and charges every returned tweet", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-twitterapi-evidence-"));
  try {
    const raw = page([{ ...tweet, author: undefined }]);
    let captured: unknown;
    const client = new TwitterAPIClient("fixture-secret", new XSpendBudget(root, 20, 1, () => new Date("2026-10-17T00:00:00Z")),
      (async () => Response.json(raw)) as typeof fetch);
    await assert.rejects(client.search("prompt", undefined, async value => { captured = value; }));
    assert.deepEqual(captured, JSON.parse(JSON.stringify(raw)));
    const ledger = await json<any>(join(root, "2026-10.json"), null);
    assert.equal(ledger.entries[0].accounted, 150);
    assert.equal(ledger.entries[0].state, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("empty results charge the minimum; a repeated cursor is not followed", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-twitterapi-empty-"));
  try {
    const budget = new XSpendBudget(root, 20, 1, () => new Date("2026-10-17T00:00:00Z"));
    const client = new TwitterAPIClient("fixture-secret", budget, (async () => Response.json(page([]))) as typeof fetch);
    assert.equal((await client.search("prompt")).result.posts.length, 0);
    const cycling = new TwitterAPIClient("fixture-secret", budget,
      (async () => Response.json({ tweets: [tweet], has_next_page: true, next_cursor: "same" })) as typeof fetch);
    await assert.rejects(cycling.search("prompt", "same"), /did not advance/);
    const ledger = await json<any>(join(root, "2026-10.json"), null);
    assert.deepEqual(ledger.entries.map((e: any) => e.accounted), [150, 150]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("live-shape empty reply IDs and media-link entities preserve complete extraction", () => {
  const result = parseTwitterAPI(page([{ ...tweet, inReplyToId: "", inReplyToUserId: "",
    text: "Image prompt:\nCreate an original watercolor garden with warm morning light and delicate green leaves.\nhttps://t.co/fixture",
    extendedEntities: { media: [{ ...photo, url: "https://t.co/fixture", expanded_url: "https://x.com/fixture/status/101/photo/1" }] } }]));
  const extracted = extractMarkedXPrompt(result.posts[0], result.media);
  assert.ok("body" in extracted);
  assert.equal(extracted.body, "Create an original watercolor garden with warm morning light and delicate green leaves.");
  assert.equal(extracted.kind, "image");
  assert.throws(() => parseTwitterAPI(page([{ ...tweet, isReply: true, inReplyToId: "", inReplyToUserId: "" }])), /incomplete reply/);
});

test("video canonicalization preserves file identity and never rewrites an untrusted host", () => {
  assert.equal(canonicalTwitterVideoURL("https://video-s.twimg.com/amplify_video/123/vid/example.mp4?tag=29"),
    "https://video.twimg.com/amplify_video/123/vid/example.mp4");
  assert.equal(canonicalTwitterVideoURL("https://example.com/example.mp4?tag=29"), "https://example.com/example.mp4?tag=29");
  assert.equal(canonicalTwitterVideoURL("https://video.twimg.com/example.mp4?token=keep&tag=29"), "https://video.twimg.com/example.mp4?token=keep");
});

test("ambiguous quote and retweet relationships are never silently converted to originals", () => {
  for (const flag of ["isQuote", "isRetweet"])
    assert.throws(() => parseTwitterAPI(page([{ ...tweet, [flag]: true }])), /incomplete reference/);
  assert.deepEqual(parseTwitterAPI(page([{ ...tweet, isQuote: true, quoted_tweet: { id: "99" } }])).posts[0].referenced_tweets,
    [{ type: "quoted", id: "99" }]);
});

test("rate limits preserve long Retry-After periods and capture errors without retrying", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-twitterapi-retry-"));
  try {
    for (const [index, retry] of ["3600", new Date(Date.now() + 3600_000).toUTCString()].entries()) {
      let captured: any, calls = 0;
      const account = join(root, String(index)), budget = new XSpendBudget(account);
      const client = new TwitterAPIClient("fixture-secret", budget, (async () => {
        calls++; return new Response("rate limited", { status: 429, headers: { "retry-after": retry } });
      }) as typeof fetch);
      await assert.rejects(client.search("prompt", undefined, async raw => { captured = raw; }), error =>
        error instanceof TransientXReadError && error.retryAfterMS > 3500_000 && error.retryAfterMS <= 3600_000);
      assert.equal(calls, 1);
      assert.equal(captured.httpError.status, 429);
      assert.equal(captured.httpError.retryAfter, retry);
      const ledgerPath = join(account, `${budget.now().toISOString().slice(0, 7)}.json`);
      const before = await json(ledgerPath, null);
      await assert.rejects(client.search("another prompt"), /cooldown/);
      assert.equal(calls, 1);
      assert.deepEqual(await json(ledgerPath, null), before);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("historical search uses exact UTC boundaries instead of vendor date-only windows", () => {
  assert.equal(twitterAPIQuery("prompt since:2026-07-01 until:2026-08-01"),
    `prompt since_time:${Date.parse("2026-07-01T00:00:00Z") / 1000} until_time:${Date.parse("2026-08-01T00:00:00Z") / 1000}`);
  assert.throws(() => twitterAPIQuery("prompt since:2026-02-30"), /Invalid.*boundary/);
});


test("terminal search pages accept null cursors without hiding ambiguous continuation", () => {
  for (const tweets of [[], [tweet]]) {
    const result = parseTwitterAPI({ tweets, has_next_page: false, next_cursor: null }, { search: true });
    assert.equal(result.posts.length, tweets.length);
    assert.equal(result.nextToken, undefined);
  }
  for (const next_cursor of [null, undefined, ""])
    assert.throws(() => parseTwitterAPI({ tweets: [], has_next_page: true, next_cursor }, { search: true }), /ambiguous pagination/);
});


test("shared video media compares supported MP4 variants without unused HLS CDN aliases", () => {
  const video = (host: string, file = "same.mp4") => ({ ...photo, type: "video", video_info: { variants: [
    { content_type: "application/x-mpegURL", url: `https://${host}/playlist.m3u8` },
    { content_type: "video/mp4", url: `https://video.twimg.com/${file}`, bitrate: 256000 },
  ] } });
  const result = parseTwitterAPI(page([
    { ...tweet, extendedEntities: { media: [video("video.twimg.com")] } },
    { ...tweet, id: "102", extendedEntities: { media: [video("video-s.twimg.com")] } },
  ]));
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].variants?.length, 1);
  assert.throws(() => parseTwitterAPI(page([
    { ...tweet, extendedEntities: { media: [video("video.twimg.com")] } },
    { ...tweet, id: "102", extendedEntities: { media: [video("video-s.twimg.com", "different.mp4")] } },
  ])), /conflicting media/);
});


test("client respects reserve for discovery and passes published maintenance purpose before HTTP", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-twitterapi-reserve-"));
  try {
    const now = new Date("2026-10-17T01:00:00Z");
    await atomic(join(root, "maintenance-reserve.json"), { version: 1, checkedAt: now.toISOString(), complete: true,
      standalone: 10000, officialPosts: 0, sourceSetSHA256: "a".repeat(64) });
    const budget = new XSpendBudget(root, 20, 1, () => now, true);
    let calls = 0;
    const client = new TwitterAPIClient("secret-fixture", budget, (async () => { calls++; return Response.json(page([tweet])); }) as typeof fetch);
    await assert.rejects(client.search("prompt"), XBudgetExceeded);
    await assert.rejects(client.lookup(["101"]), XBudgetExceeded);
    assert.equal(calls, 0);
    const result = await client.lookup(["101"], undefined, "maintenance");
    assert.equal(result.result.posts.length, 1); assert.equal(calls, 1);
    assert.deepEqual((await json<any>(join(root, "2026-10.json"), null)).entries.map((e: any) => e.accounted), [150]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
