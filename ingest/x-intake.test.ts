import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { convertXDiscovery, extractMarkedXPrompt, nativeXPublicationBlocker, readXIntake } from "./x-intake.ts";
import { applyEditorialReviews } from "./editorial.ts";
import { automaticReviewEligibility, runEditorialReview } from "./editorial-runner.ts";
import { selectLibrary } from "./library.ts";
import { fingerprint } from "./sources.ts";
import { promptSchema } from "../packages/schema/catalog.ts";

const body = "Ask me for a subject, then write a short story with three scenes. In your reply include one surprising but coherent ending.";
const post = (id = "123", text = `Prompt:\n${body}`) => ({ id, author_id: "456", text, created_at: "2026-10-12T00:00:00.000Z" });
const snapshot = (posts: unknown[], name = "2026-10-12.json", extra = {}) => ({ name, data: { posts, ...extra } });
const metadata = { title: "A coherent short story", summary: "An original test fixture.", example: "使用建议：提供一个主题。",
  tags: ["Test"], previewLabel: "提示词主题" };

test("native X intake preserves complete marked body, post identity and truthful unspecified provenance", () => {
  const input = snapshot([post()]);
  const original = structuredClone(input);
  const { candidates, records, report } = convertXDiscovery([input]);
  assert.equal(candidates.length, 1);
  const item = candidates[0];
  assert.equal(item.id, "x-post-123"); assert.equal(item.prompt, body);
  assert.equal(item.source.url, "https://x.com/i/web/status/123");
  assert.equal(item.source.license, "Unspecified"); assert.equal(item.source.revision, undefined);
  assert.equal(item.creator?.externalID, "456"); assert.equal(item.creator?.username, undefined);
  assert.equal(item.creator?.displayName, "X account 456");
  assert.equal(item.fingerprint, fingerprint(body)); assert.equal(item.reviewStatus, "draft");
  assert.equal(promptSchema.safeParse(item).success, true);
  assert.equal(records[0].authorID, "456"); assert.equal(records[0].hasCreatorProfile, false);
  assert.equal(report.drafted, 1); assert.equal(report.publicationBlocked, 1); assert.equal(report.blocked, 0);
  assert.deepEqual(input, original);
});

test("full note text replaces truncated display text and preserves a verified creator's identity", () => {
  const creator = { id: "x-writer", externalID: "456", platform: "x" as const, displayName: "Fixture Writer",
    username: "writer", profileURL: "https://x.com/writer" };
  const input = snapshot([{ ...post("123", "A long post…"), truncated: true, note_tweet: { text: `完整提示词：\n${body}` } }], undefined, { creators: [creator] });
  const result = convertXDiscovery([input]);
  assert.equal(result.candidates[0].prompt, body); assert.equal(result.candidates[0].creator?.id, "x-id-456");
  assert.equal(result.candidates[0].source.author, creator.displayName);
  assert.equal(result.records[0].fullTextSource, "note_tweet");
});

test("renamed note_post payload retains the complete current text and source links", () => {
  const result = convertXDiscovery([snapshot([{ ...post("123", "Display text…"), truncated: true,
    note_post: { text: `Prompt:\n${body}`, entities: { urls: [{ url: "https://t.co/source", expanded_url: "https://example.com/source" }] } },
  }])]);
  assert.equal(result.candidates[0].prompt, body);
  assert.equal(result.records[0].fullTextSource, "note_post");
  assert.deepEqual(result.records[0].expandedLinks, ["https://example.com/source"]);
});

test("closed prompt fences separate the instructions from surrounding post metadata", () => {
  const result = extractMarkedXPrompt(post("123", `An original fixture\nImage prompt:\n\`\`\`text\n${body}\n\`\`\`\nA source link: https://t.co/source`));
  assert.deepEqual(result, { body, kind: "image" });
  assert.equal(convertXDiscovery([snapshot([post("123", `Prompt:\n${body}\nLicense: CC0`)])]).candidates[0].source.license, "Unspecified",
    "A phrase in an unverified post must not invent a verified publication grant");
});

test("incomplete, unmarked and link-only discoveries stay blocked with specific reasons", () => {
  const cases = [
    [post("1", "A new tool has launched today."), "missing-prompt-boundary"],
    [{ ...post("2"), truncated: true }, "api-truncated"],
    [post("3", `Prompt:\n${body}…`), "truncated-ending"],
    [post("4", `Prompt:\n\`\`\`text\n${body}`), "incomplete-code-fence"],
    [post("5", `Prompt:\n${body}\nhttps://t.co/source`), "unresolved-short-link"],
    [post("6", "Prompt:\nhttps://example.com/full-instructions"), "insufficient-instructions"],
    [post("7", `Prompt:\n${body}\nPrompt:\n${body}`), "multiple-prompt-boundaries"],
  ] as const;
  const result = convertXDiscovery([snapshot(cases.map(([input]) => input))]);
  assert.equal(result.candidates.length, 0); assert.equal(result.report.blocked, cases.length);
  assert.deepEqual(result.records.map(value => value.reason), cases.map(([, reason]) => reason));
});

test("newer snapshots replace the same post deterministically and invalidate older text review", () => {
  const before = snapshot([post()], "2026-10-11.json");
  const after = snapshot([post("123", `Prompt:\n${body} Ask about the intended audience too.`)], "2026-10-12.json");
  const result = convertXDiscovery([after, before]);
  assert.equal(result.report.discovered, 1); assert.equal(result.report.duplicatePosts, 1);
  assert.equal(result.candidates[0].id, "x-post-123");
  assert.notEqual(result.candidates[0].fingerprint, fingerprint(body));
  assert.equal(result.records[0].snapshot, after.name);
  assert.equal(applyEditorialReviews(result.candidates, { "x-post-123": { fingerprint: fingerprint(body), reviewedAt: "2026-10-11T00:00:00Z", metadata } })[0].title,
    "X prompt 123", "A previous metadata review cannot attach to edited source text");
});

test("only matching attached media and account IDs contribute source metadata", () => {
  const input = { ...post("123", `Video prompt:\n${body}`), attachments: { media_keys: ["video"] },
    entities: { urls: [{ url: "https://t.co/demo", expanded_url: "https://example.com/demo" }] } };
  const result = convertXDiscovery([snapshot([input], undefined, {
    creators: [{ id: "wrong", platform: "x", externalID: "999", displayName: "Unrelated", profileURL: "https://x.com/unrelated" }],
    media: [
      { media_key: "unrelated", type: "photo", url: "https://pbs.twimg.com/unrelated.jpg" },
      { media_key: "video", type: "video", preview_image_url: "https://pbs.twimg.com/preview.jpg",
        variants: [{ content_type: "video/mp4", url: "https://evil.example/video.mp4", bit_rate: 9000 },
          { content_type: "video/mp4", url: "https://video.twimg.com/example.mp4", bit_rate: 1000 }] },
    ],
  })]);
  assert.equal(result.candidates[0].creator?.externalID, "456");
  assert.equal(result.candidates[0].media?.imageURL, "https://pbs.twimg.com/preview.jpg");
  assert.equal(result.candidates[0].media?.videoURL, "https://video.twimg.com/example.mp4");
  assert.deepEqual(result.records[0].expandedLinks, ["https://example.com/demo"]);
});

test("native drafts cannot bypass publication gates through a model or manual metadata review", async () => {
  const { candidates } = convertXDiscovery([snapshot([post()])]);
  assert.equal(automaticReviewEligibility(candidates[0]), nativeXPublicationBlocker);
  let providerCalls = 0;
  const result = await runEditorialReview({ candidates, previous: [], reviews: {}, cache: { version: 1, decisions: {} }, day: "2026-10-12",
    provider: async () => { providerCalls++; throw new Error("Native X must not reach this provider"); },
    persistCache: async () => {}, persistReviews: async () => {}, persistLedger: async () => {},
  });
  assert.equal(providerCalls, 0); assert.equal(result.report.preflightDeferred, 1);
  const reviewed = applyEditorialReviews(candidates, { [candidates[0].id]: { fingerprint: candidates[0].fingerprint, reviewedAt: "2026-10-12T00:00:00Z", metadata } });
  assert.equal(reviewed[0].title, metadata.title); assert.equal(reviewed[0].reviewStatus, "draft");
  assert.deepEqual(reviewed[0].source, candidates[0].source); assert.equal(reviewed[0].prompt, body);
  assert.deepEqual(selectLibrary(reviewed, new Set()), []);
  assert.deepEqual(selectLibrary([{ ...reviewed[0], reviewStatus: "candidate" }], new Set()), []);
});

test("cached intake reports malformed snapshots and post IDs without fetching any source", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-x-intake-"));
  try {
    assert.equal((await readXIntake(root)).report.discovered, 0);
    await mkdir(join(root, "x-discovery"));
    await writeFile(join(root, "x-discovery", "2026-10-10.json"), "broken");
    await writeFile(join(root, "x-discovery", "2026-10-11.json"), JSON.stringify({ posts: [{ id: "789", text: body }] }));
    await writeFile(join(root, "x-discovery", "2026-10-12.json"), JSON.stringify(snapshot([post()]).data));
    await writeFile(join(root, "x-discovery", "ignore.json"), "broken");
    const result = await readXIntake(root);
    assert.equal(result.report.snapshots, 3); assert.equal(result.report.snapshotErrors.length, 1);
    assert.equal(result.report.drafted, 1); assert.equal(result.report.blocked, 1);
    assert.equal(result.records.find(item => item.reason === "invalid-post")?.sourceURL, "https://x.com/i/web/status/789");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("post identity deduplication replaces stale validation failures in either order", () => {
  const valid = snapshot([post()]);
  const invalid = snapshot([{ id: post().id, text: body }]);
  for (const recovered of [true, false]) {
    const result = convertXDiscovery([
      { ...(recovered ? invalid : valid), name: "2026-10-11.json" },
      { ...(recovered ? valid : invalid), name: "2026-10-12.json" },
    ]);
    assert.equal(result.report.discovered, 1);
    assert.equal(result.report.duplicatePosts, 1);
    assert.equal(result.report.drafted, recovered ? 1 : 0);
    assert.equal(result.report.blocked, recovered ? 0 : 1);
    assert.equal(result.records[0].snapshot, "2026-10-12.json");
    assert.equal(result.records[0].reason, recovered ? nativeXPublicationBlocker : "invalid-post");
  }
});

test("the review CLI accepts a native draft for metadata work but reports its unresolved source gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-x-review-"));
  try {
    const { candidates } = convertXDiscovery([snapshot([post()])]);
    await mkdir(join(root, "candidates"));
    await writeFile(join(root, "candidates", "x-native.json"), JSON.stringify(candidates));
    const file = join(root, "metadata.json"); await writeFile(file, JSON.stringify(metadata));
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "ingest/review.ts", candidates[0].id, file],
      { cwd: process.cwd(), env: { ...process.env, PROMPIX_CONTENT_DIR: root } });
    assert.equal(JSON.parse(result.stdout).status, "draft-awaiting-source-review");
    const reviews = JSON.parse(await readFile(join(root, "editorial.json"), "utf8"));
    assert.equal(reviews[candidates[0].id].fingerprint, candidates[0].fingerprint);
    assert.equal(applyEditorialReviews(candidates, reviews)[0].reviewStatus, "draft");
  } finally { await rm(root, { recursive: true, force: true }); }
});
