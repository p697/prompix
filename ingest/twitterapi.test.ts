import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTwitterAPI, TwitterAPIClient, twitterAPIQuery } from "./twitterapi.ts";
import { XSpendBudget } from "./x-spend.ts";
import { json } from "./publication.ts";
import { fullXText } from "./x-intake.ts";
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
