import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { xExcerptSelectionSchema, xExcerptSourceSHA256, readXExcerptReviews, selectXExcerpt, type XExcerptReview } from "./x-excerpts.ts";
import { convertXDiscovery, extractMarkedXPrompt, readXIntake } from "./x-intake.ts";
import { prepareXAvailability, filterXAvailability } from "./x-availability.ts";
import { applyEditorialReviews } from "./editorial.ts";

const now = new Date().toISOString();
const body = "Ask for my preferred story setting. Write a short story in three scenes, with a coherent ending and no invented quotations.";
const post = { id: "123", author_id: "456", created_at: now, text: `An original fixture.\nThe prompt I use:\n“${body}”\n\nSubscribe for more examples.` };
const creator = { id: "x-fixture", externalID: "456", platform: "x" as const, username: "fixture", displayName: "Fixture", profileURL: "https://x.com/fixture" };
const snapshot = { capturedAt: now, posts: [post], creators: [creator], media: [] };
const review = (text = post.text): XExcerptReview => ({ sourceSHA256: xExcerptSourceSHA256(post, text),
  start: text.indexOf(body), end: text.indexOf(body) + body.length, kind: "text", includeMedia: false, reviewedAt: now });

test("reviewed source ranges recover exact instructions without copying surrounding promotion", () => {
  assert.deepEqual(extractMarkedXPrompt(post), { reason: "missing-prompt-boundary" });
  const { candidates } = convertXDiscovery([{ name: "fixture", data: snapshot }], {}, { "123": review() });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].prompt, body);
  assert.equal(candidates[0].source.post?.text, post.text);
  assert.equal(candidates[0].creator?.externalID, post.author_id);
  assert.equal(candidates[0].reviewStatus, "draft");
  assert.ok(candidates[0].source.revision);
  assert.equal(filterXAvailability(candidates, {}).prompts.length, 0, "Excerpt approval cannot bypass a paid source recheck");
  assert.equal(applyEditorialReviews(candidates, {})[0].reviewStatus, "draft");
});

test("source text, identity and creation changes invalidate the saved range without falling back to automatic extraction", () => {
  for (const changed of [{ ...post, text: post.text + " Revised." }, { ...post, author_id: "789" }, { ...post, id: "789" },
    { ...post, created_at: "2020-01-01T00:00:00Z" }]) {
    assert.deepEqual(extractMarkedXPrompt(changed, [], undefined, review()), { reason: "excerpt-review-source-changed" });
  }
  const marked = { ...post, text: `Text prompt:\n${body}` };
  assert.deepEqual(extractMarkedXPrompt(marked, [], undefined, review()), { reason: "excerpt-review-source-changed" });
});

test("review ranges reject surrogate splits, whitespace, inverted bounds and unavailable ends", () => {
  const text = "😀 " + body, base = { ...review(text), sourceSHA256: xExcerptSourceSHA256(post, text) };
  assert.deepEqual(selectXExcerpt(post, text, { ...base, start: 1 }), { reason: "invalid-excerpt-range" });
  assert.deepEqual(selectXExcerpt(post, text, { ...base, start: 0, end: 1 }), { reason: "invalid-excerpt-range" });
  assert.deepEqual(selectXExcerpt(post, text, { ...base, end: text.length + 1 }), { reason: "invalid-excerpt-range" });
  assert.deepEqual(selectXExcerpt(post, text, { ...base, start: 2 }), { reason: "excerpt-range-includes-whitespace" });
  const { reviewedAt: _, ...selection } = base;
  for (const value of [{ ...selection, start: -1 }, { ...selection, end: selection.start }, { ...selection, start: 1.5 },
    { ...selection, includeMedia: "false" }, { ...selection, extra: true }]) assert.equal(xExcerptSelectionSchema.safeParse(value).success, false);
});

test("excerpt selection uses complete long-form text and cannot bypass truncation or thread provenance", () => {
  const long = { ...post, text: "Display…", truncated: true, note_tweet: { text: post.text } };
  const extracted = extractMarkedXPrompt(long, [], undefined, review());
  assert.ok("body" in extracted); assert.equal(extracted.body, body);
  for (const changed of [{ ...post, truncated: true }, { ...long, note_tweet: { text: post.text, truncated: true } }])
    assert.deepEqual(extractMarkedXPrompt(changed, [], undefined, review()), { reason: "api-truncated" });
  for (const changed of [{ ...post, in_reply_to_user_id: "456" }, { ...post, conversation_id: "100" },
    { ...post, referenced_tweets: [{ id: "100", type: "quoted" as const }] }])
    assert.deepEqual(extractMarkedXPrompt(changed, [], undefined, review()), { reason: "excerpt-requires-standalone-post" });
});

test("edited selections do not rewrite sources or carry over approval for another excerpt", () => {
  const text = `${post.text}\nAnother option:\nWrite a concise poem about a quiet garden, using concrete details and a gentle rhythm.`;
  const first = review(text), second = { ...first, start: text.indexOf("Write a concise"), end: text.length };
  const input = [{ name: "fixture", data: { ...snapshot, posts: [{ ...post, text }] } }];
  const a = convertXDiscovery(input, {}, { "123": first }).candidates[0];
  const b = convertXDiscovery(input, {}, { "123": second }).candidates[0];
  assert.notEqual(a.fingerprint, b.fingerprint); assert.notEqual(a.source.revision, b.source.revision);
  assert.equal(a.source.post?.text, b.source.post?.text);
  const approval = { [a.id]: { fingerprint: a.fingerprint, sourceRevision: a.source.revision, reviewedAt: now,
    metadata: { title: "Fixture", summary: "Fixture summary", example: "Use a subject.", tags: ["Writing"], previewLabel: "Prompt topic" } } };
  assert.equal(applyEditorialReviews([b], approval)[0].reviewStatus, "draft");
});

test("text excerpts may omit unrelated attachments while retaining explicit opt-in media", () => {
  const media = { media_key: "3_a", type: "photo" as const, url: "https://pbs.twimg.com/media/fixture.jpg" };
  const input = [{ name: "fixture", data: { ...snapshot, posts: [{ ...post, attachments: { media_keys: [media.media_key] } }], media: [media] } }];
  const omitted = convertXDiscovery(input, {}, { "123": review() }).candidates[0];
  const included = convertXDiscovery(input, {}, { "123": { ...review(), includeMedia: true } }).candidates[0];
  assert.equal(omitted.media, null); assert.equal(included.media?.imageURL, media.url);
  assert.notEqual(omitted.source.revision, included.source.revision);
});

test("manual selections retain body completeness and short-link checks", () => {
  for (const [text, reason] of [["https://example.com/only-a-link", "insufficient-instructions"],
    [body + "…", "truncated-ending"], [body + " https://t.co/unresolved", "unresolved-short-link"]]) {
    const source = { ...post, text: `${text}\n\nSource context.` };
    const selection = { ...review(), sourceSHA256: xExcerptSourceSHA256(source, source.text), start: 0, end: text.length };
    assert.deepEqual(extractMarkedXPrompt(source, [], undefined, selection), { reason });
  }
  const withheld = { ...post, withheld: { country_codes: ["ZZ"] } };
  assert.equal(convertXDiscovery([{ name: "fixture", data: { ...snapshot, posts: [withheld] } }], {}, { "123": review() }).candidates.length, 0);
});

test("source rechecks keep unchanged excerpts available and withhold edited originals", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-excerpt-"));
  try {
    await mkdir(join(root, "x-discovery"));
    await writeFile(join(root, "x-discovery", now.slice(0, 10) + ".json"), JSON.stringify(snapshot));
    await writeFile(join(root, "x-excerpt-reviews.json"), JSON.stringify({ "123": review() }));
    const original = (await readXIntake(root)).candidates[0];
    const first = await prepareXAvailability(root, { enabled: true, bearer: "fixture", now, lookup: async () => ({ ...snapshot, unavailable: [] }) });
    assert.equal(first.report.requests, 0);
    assert.equal(first.report.reusedDiscovery, 1);
    assert.equal(filterXAvailability([original], first.state).prompts.length, 1);
    const later = new Date(Date.parse(now) + 13 * 3600_000).toISOString();
    const second = await prepareXAvailability(root, { enabled: true, bearer: "fixture", now: later,
      lookup: async () => ({ ...snapshot, posts: [{ ...post, text: post.text + " Changed context." }], unavailable: [] }) });
    assert.equal(second.state[original.id].status, "withheld");
    assert.equal(filterXAvailability([original], second.state).prompts.length, 0);
    assert.equal((await readXIntake(root)).candidates.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("manual CLI previews, saves atomically and leaves existing review intact when the source differs", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-excerpt-cli-"));
  try {
    await mkdir(join(root, "x-discovery"));
    await writeFile(join(root, "x-discovery", now.slice(0, 10) + ".json"), JSON.stringify(snapshot));
    const { reviewedAt: _, ...selection } = review();
    const path = join(root, "selection.json"); await writeFile(path, JSON.stringify(selection));
    const run = (...args: string[]) => promisify(execFile)(process.execPath, ["--import", "tsx", "ingest/x-excerpt-cli.ts", "123", path, ...args],
      { env: { ...process.env, PROMPIX_CONTENT_DIR: root } });
    assert.equal(JSON.parse((await run()).stdout).saved, false);
    assert.deepEqual(await readXExcerptReviews(root), {});
    assert.equal(JSON.parse((await run("--save")).stdout).saved, true);
    const saved = await readFile(join(root, "x-excerpt-reviews.json"));
    await writeFile(path, JSON.stringify({ ...selection, sourceSHA256: "0".repeat(64) }));
    await assert.rejects(run("--save"), /excerpt-review-source-changed/);
    assert.deepEqual(await readFile(join(root, "x-excerpt-reviews.json")), saved);
    await writeFile(join(root, "x-excerpt-reviews.json"), "invalid");
    await assert.rejects(readXIntake(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});
