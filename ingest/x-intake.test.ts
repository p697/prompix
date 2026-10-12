import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { convertXDiscovery, extractMarkedXPrompt, nativeXPublicationBlocker, nativeXSourceDigest, readXIntake } from "./x-intake.ts";
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

const photo = { media_key: "photo-1", type: "photo" as const, url: "https://pbs.twimg.com/media/fixture.jpg" };
const movie = { media_key: "video-1", type: "video" as const, preview_image_url: "https://pbs.twimg.com/media/preview.jpg",
  variants: [{ content_type: "video/mp4", url: "https://video.twimg.com/fixture.mp4", bit_rate: 1000 }] };
const mediaLink = { url: "https://t.co/fixture", media_key: photo.media_key, expanded_url: "https://x.com/fixture/status/123/photo/1" };
const visualBody = "A clockwork city floating between clouds, with glowing windows, copper roofs and drifting islands.";

test("emoji and Markdown prefixes retain explicit boundaries and exact instruction whitespace", () => {
  const exact = body + "\r\nKeep  two spaces and a second line.";
  for (const marker of ["✨ Prompt:", "🧑‍🎨 **Image prompt:**", "### **Prompt**:", "> 🎬 __Video prompt__:", "- **Text prompt:**", "• 提示词："]) {
    const result = extractMarkedXPrompt(post("123", `${marker}\r\n${exact}`));
    assert.ok("body" in result, marker);
    assert.equal(result.body, exact);
  }
  assert.deepEqual(extractMarkedXPrompt(post("123", `I found this Prompt: ${body}`)), { reason: "missing-prompt-boundary" });
  assert.deepEqual(extractMarkedXPrompt(post("123", `✨ Prompt:\n${body}\n### **Prompt:**\n${body}`)), { reason: "multiple-prompt-boundaries" });
});

test("standalone colon-free headings preserve complete instructions with LF and CRLF", () => {
  for (const newline of ["\n", "\r\n"]) {
    const exact = body + newline + "Keep  two spaces and the original punctuation!";
    for (const marker of ["Prompt", "**PROMPT**", "__Full prompt__", "### **Text prompt**", "> 🎬 __Video prompt__",
      "- Image prompt", "1. Website prompt", "✨ 提示词", "**完整提示词**", "画像プロンプト", "__テキストプロンプト__"]) {
      const result = extractMarkedXPrompt(post("123", `Fixture context.${newline}${marker} \t${newline}${exact}`));
      assert.ok("body" in result, marker);
      assert.equal(result.body, exact, marker);
    }
  }
});

test("colon-free heading acceptance does not include inline prose or unmatched formatting", () => {
  for (const heading of ["I found this Prompt", "Prompt below", "Prompt — source notes", "Prompt " + body,
    "**Prompt** extra text", "**Prompt", "Prompt**", "__Prompt", "Prompt__", "**Prompt__", "__Prompt**",
    "***Prompt***", "*Prompt*", "`Prompt`", "### **Prompt", "- **Prompt__"]) {
    assert.deepEqual(extractMarkedXPrompt(post("123", `${heading}\n${body}`)), { reason: "missing-prompt-boundary" }, heading);
  }
  for (const text of ["**Prompt**", `Prompt\r${body}`, `Prompt\u2028${body}`, `Prompt\u2029${body}`]) {
    assert.deepEqual(extractMarkedXPrompt(post("123", text)), { reason: "missing-prompt-boundary" });
  }
});

test("colon and colon-free headings share the same single-boundary requirement", () => {
  for (const [first, second] of [["**Prompt**", "Prompt:"], ["Prompt:", "__Prompt__"],
    ["Prompt", "### **Prompt**"], ["**Prompt**", "提示词："], ["提示词", "プロンプト"]]) {
    for (const separator of ["\n", `\r\n${body}\r\n`]) {
      assert.deepEqual(extractMarkedXPrompt(post("123", `${first}${separator}${second}\n${body}`)),
        { reason: "multiple-prompt-boundaries" });
    }
  }
});

test("colon-free headings preserve all incomplete-body and modality blockers", () => {
  const marked = (instructions: string) => post("123", `**Prompt**\n${instructions}`);
  const cases = [
    { input: { ...marked(body), truncated: true }, reason: "api-truncated" },
    { input: marked(body + "…"), reason: "truncated-ending" },
    { input: marked(body + "...\nhttps://t.co/source"), reason: "truncated-ending" },
    { input: marked("```text\n" + body), reason: "incomplete-code-fence" },
    { input: marked("```text\n" + body + "…\n```"), reason: "truncated-ending" },
    { input: marked(body + "\nhttps://t.co/source"), reason: "unresolved-short-link" },
    { input: marked("https://example.com/full-instructions"), reason: "insufficient-instructions" },
    { input: marked(body + "x".repeat(30000)), reason: "instructions-too-long" },
    { input: marked(visualBody), reason: "ambiguous-modality" },
    { input: post("123", `Nano Banana Pro and Seedance 2.0\n**Prompt**\n${visualBody}`), reason: "conflicting-modality-evidence" },
  ];
  for (const { input, reason } of cases) assert.deepEqual(extractMarkedXPrompt(input), { reason });
  const result = convertXDiscovery([snapshot(cases.map(({ input }, index) => ({ ...input, id: String(index + 1) })))]);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.report.blocked, cases.length);
});

test("colon-free fenced instructions exclude surrounding prose and remain unpublished drafts", () => {
  const input = post("123", `An original fixture announcement.\n**Text prompt**\n\`\`\`text\n${body}\n\`\`\`\nSource notes: https://t.co/source`);
  const { candidates, report } = convertXDiscovery([snapshot([input])]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].prompt, body);
  assert.equal(candidates[0].source.license, "Unspecified");
  assert.equal(report.publicationBlocked, 1);
  assert.equal(automaticReviewEligibility(candidates[0]), nativeXPublicationBlocker);
  const reviewed = applyEditorialReviews(candidates, { [candidates[0].id]: {
    fingerprint: candidates[0].fingerprint, reviewedAt: "2026-10-12T00:00:00Z", metadata,
  } });
  assert.equal(reviewed[0].reviewStatus, "draft");
  assert.deepEqual(selectLibrary(reviewed, new Set()), []);
});

test("Japanese explicit prompt labels retain their stated modality without guessing generic labels", () => {
  for (const [label, kind] of [["画像プロンプト", "image"], ["🎬 動画 プロンプト", "video"],
    ["**テキストプロンプト**", "text"], ["### Web プロンプト", "web"], ["ウェブサイトプロンプト", "web"]] as const) {
    assert.deepEqual(extractMarkedXPrompt(post("123", `${label}：\n${visualBody}`)), { body: visualBody, kind });
  }
  assert.deepEqual(extractMarkedXPrompt(post("123", `プロンプト：\n${visualBody}`)), { reason: "ambiguous-modality" });
  assert.deepEqual(extractMarkedXPrompt(post("123", `Nano Banana Pro\nプロンプト：\n${visualBody}`)), { body: visualBody, kind: "image", model: "Nano Banana Pro" });
});

test("complete notes outrank incomplete aliases and use only their own link entities", () => {
  const input = { ...post("123", "Display text…"), truncated: true,
    entities: { urls: [{ url: "https://t.co/reference", expanded_url: "https://wrong.example/display" }] },
    note_post: { text: `Prompt:\n${body}…` },
    note_tweet: { text: `Prompt:\n${body}\nRead https://t.co/reference for the source terminology.`,
      entities: { urls: [{ url: "https://t.co/reference", expanded_url: "https://example.com/glossary" }] } },
  };
  const result = convertXDiscovery([snapshot([input])]);
  assert.equal(result.records[0].fullTextSource, "note_tweet");
  assert.equal(result.candidates[0].prompt, `${body}\nRead https://example.com/glossary for the source terminology.`);
  assert.deepEqual(extractMarkedXPrompt({ ...input, note_tweet: { ...input.note_tweet, truncated: true } }), { reason: "truncated-ending" });
});

test("only proven attached media placeholders on trailing URL-only lines are removed", () => {
  const exact = visualBody + "\r\nPreserve  the original punctuation and spacing.";
  const input = { ...post("123", `Image prompt:\r\n${exact}\r\n${mediaLink.url}`),
    attachments: { media_keys: [photo.media_key] }, entities: { urls: [mediaLink] } };
  const original = structuredClone(input);
  const result = convertXDiscovery([snapshot([input], undefined, { media: [photo, { ...photo, media_key: "unrelated", url: "https://pbs.twimg.com/media/other.jpg" }] })]);
  assert.equal(result.candidates[0].prompt, exact);
  assert.equal(result.candidates[0].media?.imageURL, photo.url);
  assert.deepEqual(result.records[0].attachedMediaKeys, [photo.media_key]);
  assert.equal(result.records[0].mediaItems, 1);
  assert.equal(result.records[0].authorID, "456");
  assert.equal(result.records[0].sourceDigest, nativeXSourceDigest(result.candidates[0]));
  assert.equal(result.records[0].reason, nativeXPublicationBlocker);
  assert.deepEqual(input, original);
});

test("missing or contradictory attachment evidence never turns a post's media link into instructions", () => {
  const input = { ...post("123", `Image prompt:\n${visualBody}\n${mediaLink.url}`), attachments: { media_keys: [photo.media_key] }, entities: { urls: [mediaLink] } };
  const cases = [
    { post: { ...input, attachments: undefined }, media: [photo], reason: "unverified-media-reference" },
    { post: input, media: [], reason: "unverified-media-reference" },
    { post: input, media: [{ ...photo, media_key: "unrelated" }], reason: "unverified-media-reference" },
    { post: { ...input, entities: { urls: [{ ...mediaLink, media_key: undefined }] } }, media: [photo], reason: "unverified-media-reference" },
    { post: { ...input, entities: { urls: [{ ...mediaLink, expanded_url: "https://x.com/other/status/999/photo/1" }] } }, media: [photo], reason: "conflicting-media-reference" },
    { post: { ...input, entities: { urls: [{ ...mediaLink, unwound_url: "https://twitter.com/i/web/status/999" }] } }, media: [photo], reason: "conflicting-media-reference" },
  ];
  for (const fixture of cases) assert.deepEqual(extractMarkedXPrompt(fixture.post, fixture.media), { reason: fixture.reason });
  for (const url of ["https://pbs.twimg.com.evil.example/fixture.jpg", "https://pbs.twimg.com@evil.example/fixture.jpg",
    "https://evil.example@pbs.twimg.com/fixture.jpg", "https://pbs.twimg.com:8443/fixture.jpg", "http://pbs.twimg.com/fixture.jpg"]) {
    assert.deepEqual(extractMarkedXPrompt(input, [{ ...photo, url }]), { reason: "unverified-media-reference" });
  }
});

test("inline media references and known source links stay in the complete instructions", () => {
  const input = { ...post("123", `Text prompt:\n${body}\nUse (${mediaLink.url}) as the visual reference.`),
    attachments: { media_keys: [photo.media_key] }, entities: { urls: [mediaLink] } };
  const result = convertXDiscovery([snapshot([input], undefined, { media: [photo] })]);
  assert.equal(result.candidates[0].prompt, `${body}\nUse (${mediaLink.expanded_url}) as the visual reference.`);
  assert.equal(result.candidates[0].kind, "text");
  assert.equal(result.candidates[0].media?.imageURL, photo.url, "A text prompt may depend on a real attached reference image");
  const known = { url: "https://t.co/source", expanded_url: "https://example.com/old", unwound_url: "https://example.com/source?format=full#section" };
  assert.deepEqual(extractMarkedXPrompt({ ...post("123", `Prompt:\n${body}\nRead ${known.url}. Keep https://example.org/direct unchanged.`), entities: { urls: [known] } }),
    { body: `${body}\nRead ${known.unwound_url}. Keep https://example.org/direct unchanged.`, kind: "text" });
});

test("unknown or conflicting short links remain blocked and entity URLs cannot replace URL prefixes", () => {
  const input = { ...post("123", `Prompt:\n${body}\nhttps://t.co/source`), entities: { urls: [] as { url: string; expanded_url?: string }[] } };
  for (const urls of [[], [{ url: "https://t.co/sour", expanded_url: "https://example.com/incorrect-prefix" }],
    [{ url: "https://t.co/source", expanded_url: "javascript:alert(1)" }],
    [{ url: "https://t.co/source", expanded_url: "https://example.com/one" }, { url: "https://t.co/source", expanded_url: "https://example.com/two" }]]) {
    assert.deepEqual(extractMarkedXPrompt({ ...input, entities: { urls } }), { reason: "unresolved-short-link" });
  }
  assert.deepEqual(extractMarkedXPrompt({ ...input, text: "Prompt:\nhttps://t.co/source", entities: { urls: [{ url: "https://t.co/source", expanded_url: "https://example.com/full-prompt" }] } }),
    { reason: "insufficient-instructions" }, "An expanded link is still not its external body");
});

test("generic markers require explicit task, model or attached media evidence for modality", () => {
  assert.deepEqual(extractMarkedXPrompt(post("123", `Prompt:\n${body}`)), { body, kind: "text" });
  assert.deepEqual(extractMarkedXPrompt(post("123", `Prompt:\n${visualBody}`)), { reason: "ambiguous-modality" });
  assert.deepEqual(extractMarkedXPrompt(post("123", `GPT Image 1.5\nPrompt:\n${visualBody}`)), { body: visualBody, kind: "image", model: "GPT Image 1.5" });
  assert.deepEqual(extractMarkedXPrompt(post("123", `Seedance 2.0\nPrompt:\n${visualBody}`)), { body: visualBody, kind: "video", model: "Seedance 2.0" });
  assert.deepEqual(extractMarkedXPrompt(post("123", `Claude Sonnet 4.5\nPrompt:\nKeep the supplied context in mind before proceeding with this task.`)),
    { body: "Keep the supplied context in mind before proceeding with this task.", kind: "text", model: "Claude Sonnet 4.5" });
  const web = "Build a responsive website with a searchable list of fictional hiking trails and a simple contact form.";
  assert.deepEqual(extractMarkedXPrompt(post("123", `Prompt:\n${web}`)), { body: web, kind: "web" });
  for (const asset of [photo, movie]) {
    assert.deepEqual(extractMarkedXPrompt({ ...post("123", `Prompt:\n${visualBody}`), attachments: { media_keys: [asset.media_key] } }, [asset]),
      { body: visualBody, kind: asset.type === "photo" ? "image" : "video" });
  }
  assert.deepEqual(extractMarkedXPrompt(post("123", `Prompt:\n${visualBody}`), [photo]), { reason: "ambiguous-modality" });
  assert.deepEqual(extractMarkedXPrompt(post("123", `Nano Banana Pro and Seedance 2.0\nPrompt:\n${visualBody}`)), { reason: "conflicting-modality-evidence" });
});

test("video source proof rejects spoofed hosts and retains only the strongest valid attached variant", () => {
  const url = "https://t.co/video", input = { ...post("123", `Video prompt:\n${visualBody}\n${url}`),
    attachments: { media_keys: [movie.media_key] }, entities: { urls: [{ url, expanded_url: "https://x.com/fixture/status/123/video/1", media_key: movie.media_key }] } };
  for (const invalid of ["https://video.twimg.com.evil.example/clip.mp4", "https://video.twimg.com@evil.example/clip.mp4", "http://video.twimg.com/clip.mp4"]) {
    assert.deepEqual(extractMarkedXPrompt(input, [{ ...movie, variants: [{ content_type: "video/mp4", url: invalid }] }]), { reason: "unverified-media-reference" });
  }
  const result = convertXDiscovery([snapshot([input], undefined, { media: [{ ...movie, variants: [
    { content_type: "video/mp4", url: "https://evil.example/high.mp4", bit_rate: 10000 },
    { content_type: "video/mp4", url: "https://video.twimg.com/low.mp4", bit_rate: 500 }, ...movie.variants,
  ] }] })]);
  assert.equal(result.candidates[0].prompt, visualBody);
  assert.equal(result.candidates[0].media?.videoURL, movie.variants[0].url);
});

test("source digests bind exact body, author, modality and source assets without binding mutable profile metadata", () => {
  const original = convertXDiscovery([snapshot([post()])]).candidates[0], digest = nativeXSourceDigest(original);
  const whitespace = { ...original, prompt: body.replace("short story", "short  story") };
  assert.equal(fingerprint(whitespace.prompt), original.fingerprint);
  for (const changed of [whitespace, { ...original, id: "x-post-124" }, { ...original, kind: "image" as const }, { ...original, model: "Declared model" },
    { ...original, source: { ...original.source, url: "https://x.com/i/web/status/124" } },
    { ...original, creator: { ...original.creator!, externalID: "457" } },
    { ...original, media: { image: null, video: null, demoURL: null, imageURL: photo.url } },
    { ...original, media: { image: null, video: null, demoURL: null, videoURL: movie.variants[0].url } }]) assert.notEqual(nativeXSourceDigest(changed), digest);
  const enriched = { ...original, title: "Edited metadata", source: { ...original.source, author: "New display name" },
    creator: { ...original.creator!, displayName: "New display name", username: "new-handle", avatarURL: "https://api.prompix.dev/media/new.jpg" } };
  assert.equal(nativeXSourceDigest(enriched), digest);
});
