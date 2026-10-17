import { test } from "node:test";
import assert from "node:assert/strict";
import { convertXDiscovery } from "./x-intake.ts";
import { pilotSample, comparePilotSources, comparePilotExtraction, auditPilotSearch } from "./x-pilot.ts";
import type { TwitterAPIResult } from "./twitterapi.ts";

const now = new Date().toISOString();
const post = { id: "123", author_id: "42", created_at: now,
  text: "Text prompt:\nWrite an original story. Ask me about the intended audience before you begin, then present three possible story outlines with different endings." };
const creator = { id: "x-fixture", platform: "x" as const, externalID: "42", username: "fixture", displayName: "Fixture", profileURL: "https://x.com/fixture" };
const snapshot = { capturedAt: now, posts: [post], creators: [creator], media: [] };
const candidate = convertXDiscovery([{ name: "fixture", data: snapshot }]).candidates[0];
test("pilot comparisons fail on missing, truncated, wrong-author and changed source content", () => {
  const result: TwitterAPIResult = { ...snapshot, provider: "twitterapi", unknownIDs: [] };
  assert.equal(comparePilotSources([candidate], result)[0].matched, true);
  for (const posts of [[], [{ ...post, truncated: true }], [{ ...post, text: post.text.slice(0, 50) }], [{ ...post, author_id: "43" }]])
    assert.equal(comparePilotSources([candidate], { ...result, posts })[0].matched, false);
});
test("pilot sample keeps every selected dependency and stays within one lookup request", () => {
  const thread = { ...candidate, id: "x-post-124", source: { ...candidate.source,
    post: { ...candidate.source.post!, id: "124", parentID: "123" }, context: [candidate.source.post!] } };
  const result = pilotSample([candidate, thread], 2);
  assert.equal(result.ids.length, 2);
  assert.ok(result.candidates.some(c => c.source.context));
  assert.deepEqual(new Set(result.ids), new Set(["123", "124"]));
});

test("pilot exercises actual instruction extraction in addition to source-text parity", () => {
  const result: TwitterAPIResult = { ...snapshot, provider: "twitterapi", unknownIDs: [] };
  assert.equal(comparePilotExtraction([candidate], result, now)[0].matched, true);
  assert.equal(comparePilotExtraction([candidate], { ...result, posts: [{ ...post, text: post.text.replace("Text prompt:", "Tutorial:") }] }, now)[0].missing, true);
});

test("search audits reject out-of-window dates and missing media even when the API succeeds", () => {
  const result: TwitterAPIResult = { posts: [{ ...post, created_at: "2026-08-01T00:00:00Z", referenced_tweets: [{ type: "quoted", id: "122" }] }],
    media: [], creators: [creator], provider: "twitterapi", unknownIDs: [] };
  assert.deepEqual(auditPilotSearch("prompt has:images -is:quote since:2026-07-01 until:2026-08-01", result)[0].issues,
    ["after-window", "excluded-quote", "missing-image"]);
  const start = Date.parse("2026-08-01T00:00:00Z") / 1000;
  assert.deepEqual(auditPilotSearch(`prompt since_time:${start} until_time:${start + 1}`, result), []);
  assert.equal(auditPilotSearch(`prompt since_time:${start + 1}`, result)[0].issues[0], "before-window");
});


test("full-library extraction comparisons respect bounded snapshot sizes", () => {
  const posts = Array.from({ length: 201 }, (_, index) => ({ ...post, id: String(1000 + index) }));
  const candidates = posts.flatMap(post => convertXDiscovery([{ name: post.id, data: { ...snapshot, posts: [post] } }]).candidates);
  const result: TwitterAPIResult = { posts, media: [], creators: [creator], provider: "twitterapi", unknownIDs: [] };
  const checks = comparePilotExtraction(candidates, result, now);
  assert.equal(checks.length, 201);
  assert.ok(checks.every(check => check.matched));
});
