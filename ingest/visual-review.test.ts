import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Prompt } from "../packages/schema/catalog.ts";
import { applyVisualPresentation, runVisualReview, visualCacheSchema, visualLedgerSchema, visualInputCharacters, visualProviderInput, visualReviewIdentity,
  visualReviewModel, VisualIdentityRejection, type PreparedVisualMedia, type VisualAttachment, type VisualCache, type VisualInput,
  type VisualLedger, type VisualAttempt, type VisualProvider } from "./visual-review.ts";

const day = "2026-10-13", now = `${day}T12:00:00Z`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const imageURL = (value: string) => `https://api.prompix.dev/media/${hash(value)}.jpg`;
const videoURL = (value: string) => `https://api.prompix.dev/media/${hash(value)}.mp4`;
const urlHash = (url: string) => url.match(/\/([a-f0-9]{64})\.(jpg|mp4)$/)![1];
function prompt(id: string, kind: Prompt["kind"] = "image", images = 1): Prompt {
  const urls = Array.from({ length: images }, (_, index) => imageURL(`${id}-${index}`));
  return { id, kind, title: "Ceramic still life", summary: "An original synthetic visual review fixture.",
    prompt: `Create a ${kind} of a green ceramic cup next to folded linen, with soft window light and a cream background. Fixture ${id}.`,
    example: "Usage guidance for a synthetic fixture.", tags: ["Still life"], model: "Synthetic model", toolURL: null,
    artwork: "test", previewLabel: "Source attachment", source: { name: "Synthetic source", url: "https://example.com/source",
      repository: "https://github.com/example/synthetic-fixtures", license: "CC0-1.0", method: "Original synthetic test fixture", revision: "a".repeat(40) },
    media: kind === "text" ? null : { image: null, video: null, demoURL: kind === "web" ? "https://example.com/demo" : null,
      imageURL: urls[0], ...(images > 1 ? { imageURLs: urls } : {}), ...(kind === "video" ? { videoURL: videoURL(id) } : {}) } };
}
function prepare(item: Prompt): PreparedVisualMedia {
  const urls = item.media?.imageURLs ?? (item.media?.imageURL ? [item.media.imageURL] : []);
  const attachments: VisualAttachment[] = urls.map((url, index) => ({ id: `image-${index}`, path: `/synthetic/${item.id}-${index}.jpg`,
    sha256: urlHash(url), byteLength: 100, role: item.kind === "video" && index === 0 ? "poster" : "image", sourceURL: url }));
  if (item.kind !== "video") return { attachments, coverage: { mode: "images" } };
  const times = [0, 2, 4, 6, 8, 9.8];
  return { attachments: [...attachments, ...times.map((time, index): VisualAttachment => ({ id: `frame-${index}`,
    path: `/synthetic/${item.id}-frame-${index}.jpg`, sha256: hash(`${item.id}-${time}`), byteLength: 100,
    role: "video-frame", sourceURL: item.media!.videoURL!, timeSeconds: time }))],
    coverage: { mode: "sampled-frames", durationSeconds: 10, sampleTimes: times, videoSHA256: urlHash(item.media!.videoURL!),
      videoSourceURL: item.media!.videoURL!, hasAudio: false } };
}
function approve(items: readonly VisualInput[]) {
  return { decisions: items.map(item => ({ id: item.id, identity: item.identity, presentation: "general" as const, verdict: "match" as const,
    reason: "The visible content corresponds to the supplied instructions.",
    attachments: item.attachments.map(attachment => ({ id: attachment.id, sha256: attachment.sha256, verdict: "match" as const,
      reason: "This supplied image corresponds to the described scene." })) })) };
}
function harness(items: Prompt[], previous: Prompt[] = []) {
  const state: { cache: VisualCache; ledger?: VisualLedger; events: string[]; preparedIDs: string[]; inputs: readonly VisualInput[];
    batches: Array<readonly VisualInput[]> } = {
    cache: { version: 1, decisions: {} }, events: [], preparedIDs: [], inputs: [], batches: [],
  };
  const run = (settings: { prompts?: Prompt[]; previous?: Prompt[]; provider?: VisualProvider | null;
    prepareMedia?: (item: Prompt) => Promise<PreparedVisualMedia>; day?: string; maxRequests?: unknown; classifyPublished?: boolean; ledger?: VisualLedger | VisualAttempt;
    persistCache?: (cache: VisualCache) => Promise<void>; persistLedger?: (ledger: VisualLedger) => Promise<void> } = {}) => runVisualReview({
    prompts: settings.prompts ?? items, previous: settings.previous ?? previous, cache: state.cache, ledger: settings.ledger ?? state.ledger,
    day: settings.day ?? day, now, maxRequests: settings.maxRequests, classifyPublished: settings.classifyPublished,
    provider: settings.provider === null ? undefined : async input => {
      state.events.push("provider"); state.inputs = input; state.batches.push(input);
      return (settings.provider ?? (async items => approve(items)))(input);
    },
    prepareMedia: async item => { state.preparedIDs.push(item.id); return settings.prepareMedia ? settings.prepareMedia(item) : prepare(item); },
    persistCache: settings.persistCache ?? (async cache => { state.cache = structuredClone(cache); state.events.push("cache"); }),
    persistLedger: settings.persistLedger ?? (async ledger => { state.ledger = structuredClone(ledger); state.events.push(ledger.attempts.at(-1)!.state); }),
  });
  return { state, run };
}

test("text without visual attachments passes, but old metadata approval cannot replace missing visual evidence", async () => {
  const image = { ...prompt("metadata-approved"), reviewStatus: "candidate", editorialRank: 100, reviewedAt: now };
  const { run, state } = harness([prompt("text", "text"), image, prompt("video", "video")]);
  const result = await run({ provider: null });
  assert.deepEqual(result.prompts.map(item => item.id), ["text"]);
  assert.deepEqual(result.withheldIDs, [image.id, "video"]);
  assert.equal(result.report.notRequired, 1); assert.equal(result.report.deferred, 2);
  assert.equal(result.report.status, "disabled"); assert.deepEqual(state.preparedIDs, []);
  assert.deepEqual(state.events, []); assert.deepEqual(state.cache.decisions, {});
});

test("unchanged published semantics reuse a previous snapshot without fabricating a visual decision", async () => {
  const old = prompt("unchanged", "video", 2), changedMetadata = structuredClone(old);
  changedMetadata.title = "New editorial wording"; changedMetadata.summary = "New summary";
  changedMetadata.source.revision = "b".repeat(40); changedMetadata.source.author = "Updated display name";
  changedMetadata.media!.aspectRatio = 1.5;
  assert.equal(visualReviewIdentity(old), visualReviewIdentity(changedMetadata));
  const { run, state } = harness([changedMetadata], [old]);
  const result = await run({ provider: null });
  assert.deepEqual(result.prompts, [{ ...changedMetadata, presentation: "unknown" }]); assert.equal(result.report.previousSnapshots, 1);
  assert.equal(result.report.items[0].status, "previous-snapshot"); assert.deepEqual(state.events, []);
  assert.deepEqual(state.cache.decisions, {}); assert.deepEqual(state.preparedIDs, []);
});

test("previous snapshot identity binds every relevant publication field with exact unnormalized text", async () => {
  const old = prompt("identity", "video", 2);
  const changes: ((item: Prompt) => void)[] = [
    item => { item.prompt += " "; }, item => { item.prompt = item.prompt.toUpperCase(); },
    item => { item.kind = "image"; }, item => { item.model += " 2"; }, item => { item.contentType = "skill"; },
    item => { item.source.url += "?edition=2"; }, item => { item.source.repository += "-new"; }, item => { item.source.license = "MIT"; },
    item => { item.media!.imageURL = imageURL("new-cover"); item.media!.imageURLs![0] = item.media!.imageURL; },
    item => { item.media!.imageURLs!.push(imageURL("extra-gallery-image")); },
    item => { item.media!.imageURLs!.reverse(); item.media!.imageURL = item.media!.imageURLs![0]; },
    item => { item.media!.videoURL = videoURL("replacement-video"); }, item => { item.media!.demoURL = "https://example.com/new-demo"; },
  ];
  for (const change of changes) {
    const next = structuredClone(old); change(next);
    assert.notEqual(visualReviewIdentity(next), visualReviewIdentity(old));
    const result = await harness([next], [old]).run({ provider: null });
    assert.deepEqual(result.prompts, []); assert.equal(result.report.previousSnapshots, 0);
  }
});

test("malformed or foreign media URLs fail before even matching a previous snapshot", async () => {
  const urls = ["https://example.com/preview.jpg", `${imageURL("a")}?query=1`, `${imageURL("a")}#fragment`, `${imageURL("a")}\n`,
    imageURL("a").replace("api.prompix.dev", "api.prompix.dev.evil.test"), imageURL("a").replace(".jpg", ".png"),
    imageURL("a").replace(hash("a"), hash("a").toUpperCase())];
  for (const url of urls) {
    const item = prompt("invalid-url"); item.media!.imageURL = url;
    const { run, state } = harness([item], [item]);
    const result = await run();
    assert.deepEqual(result.prompts, []); assert.equal(result.report.preflightDeferred, 1);
    assert.deepEqual(state.preparedIDs, []); assert.deepEqual(state.events, []);
  }
});

test("new web previews stay deferred until real webpage inspection exists", async () => {
  const item = prompt("web", "web"); const { run, state } = harness([item]);
  const result = await run();
  assert.deepEqual(result.prompts, []); assert.match(result.report.items[0].reason!, /real webpage/);
  assert.deepEqual(state.preparedIDs, []); assert.deepEqual(state.events, []);
  const retained = await run({ previous: [item] });
  assert.equal(retained.report.previousSnapshots, 0); assert.deepEqual(retained.prompts, []);
});

test("real prepared image and sampled video inputs reserve before the provider and persist independent evidence", async () => {
  const items = [prompt("image", "image", 2), prompt("video", "video")], { run, state } = harness(items);
  const result = await run();
  assert.equal(result.report.approved, 2); assert.deepEqual(result.prompts, items.map(item => ({ ...item, presentation: "general" })));
  assert.deepEqual(state.events, ["reserved", "provider", "cache", "completed"]);
  assert.equal(state.ledger?.attempts[0].attachments, 9); assert.equal(state.ledger?.attempts[0].attachmentBytes, 900);
  assert.equal(state.ledger?.attempts[0].inputCharacters, visualInputCharacters(state.inputs));
  assert.equal(state.ledger?.attempts[0].model, visualReviewModel);
  assert.equal(Object.keys(state.cache.decisions).length, 2); visualCacheSchema.parse(state.cache);
  const evidence = state.cache.decisions[visualReviewIdentity(items[1])];
  assert.equal(evidence.coverage.mode, "sampled-frames");
  assert(evidence.attachments.every(attachment => !("path" in attachment)));
  assert(!JSON.stringify(visualProviderInput(state.inputs)).includes("/synthetic/"));
  assert(state.inputs.every(item => item.prompt === items.find(source => source.id === item.id)!.prompt));
});

test("independent cached matches allow exact media reuse with provider disabled; changed media requires fresh evidence", async () => {
  const item = prompt("cached", "image", 2), { run, state } = harness([item]);
  await run(); state.events = []; state.preparedIDs = [];
  const cached = await run({ provider: null });
  assert.equal(cached.report.cachedApproved, 1); assert.equal(cached.prompts.length, 1);
  assert.deepEqual(state.events, []); assert.deepEqual(state.preparedIDs, []);
  const changed = structuredClone(item); changed.media!.imageURLs![1] = imageURL("unreviewed-replacement");
  const replacement = await run({ prompts: [changed], provider: null });
  assert.deepEqual(replacement.prompts, []); assert.equal(replacement.report.cachedApproved, 0);
});

test("cached match cannot omit a gallery image or video poster", async () => {
  for (const item of [prompt("cached-gallery", "image", 2), prompt("cached-video", "video")]) {
    const { run, state } = harness([item]); await run();
    const cached = state.cache.decisions[visualReviewIdentity(item)];
    if (item.kind === "image") cached.attachments.pop(); else cached.attachments.shift();
    const result = await run({ provider: null });
    assert.deepEqual(result.prompts, []); assert.match(result.report.items[0].reason!, /Invalid cached visual evidence/);
    assert.equal(result.report.cachedApproved, 0);
  }
});

test("missing gallery attachments, swapped order and incorrect prepared hashes never reach the provider", async () => {
  const item = prompt("gallery", "image", 2);
  const corruptions: ((prepared: PreparedVisualMedia) => void)[] = [
    media => { media.attachments.pop(); }, media => { media.attachments.reverse(); },
    media => { media.attachments[1].sha256 = hash("wrong-bytes"); },
    media => { media.attachments[1].id = media.attachments[0].id; },
    media => { media.attachments[0].path = "relative-path.jpg"; },
    media => { media.attachments[0].byteLength = 8_000_001; },
  ];
  for (const corrupt of corruptions) {
    const { run, state } = harness([item]);
    const result = await run({ prepareMedia: async item => { const media = prepare(item); corrupt(media); return media; } });
    assert.deepEqual(result.prompts, []); assert.deepEqual(state.events, []);
    assert.equal(result.report.preflightDeferred, 1);
  }
});

test("video evidence requires exactly six ordered source-bound representative frames plus every poster image", async () => {
  const item = prompt("video-coverage", "video", 2);
  const corruptions: ((prepared: PreparedVisualMedia) => void)[] = [
    media => { media.attachments.shift(); }, media => { media.attachments.pop(); },
    media => { media.attachments.at(-1)!.sourceURL = videoURL("different-video"); },
    media => { media.attachments.at(-1)!.timeSeconds = 8; },
    media => { if (media.coverage.mode === "sampled-frames") media.coverage.videoSHA256 = hash("other"); },
    media => { if (media.coverage.mode === "sampled-frames") media.coverage.durationSeconds = 100; },
    media => { if (media.coverage.mode === "sampled-frames") { media.coverage.sampleTimes[0] = 1.5; media.attachments[2].timeSeconds = 1.5; } },
    media => { if (media.coverage.mode === "sampled-frames") { media.coverage.sampleTimes[1] = 0; media.attachments[3].timeSeconds = 0; } },
  ];
  for (const corrupt of corruptions) {
    const { run, state } = harness([item]);
    const result = await run({ prepareMedia: async item => { const media = prepare(item); corrupt(media); return media; } });
    assert.deepEqual(result.prompts, []); assert.deepEqual(state.events, []);
    assert.equal(result.report.preflightDeferred, 1);
  }
});

test("one uncertain or mismatching attachment defers the item even if its overall verdict says match", async () => {
  for (const verdict of ["uncertain", "mismatch"] as const) {
    const item = prompt(`attachment-${verdict}`, "image", 2), { run, state } = harness([item]);
    const result = await run({ provider: async items => {
      const output = approve(items) as { decisions: { id: string; identity: string; verdict: string; reason: string;
        attachments: { id: string; sha256: string; verdict: string; reason: string }[] }[] };
      output.decisions[0].attachments[1].verdict = verdict; output.decisions[0].attachments[1].reason = "The second image does not establish correspondence.";
      return output;
    } });
    assert.deepEqual(result.prompts, []); assert.equal(result.report.approved, 0); assert.equal(result.report.deferred, 1);
    assert.match(result.report.items[0].reason!, /second image/);
    assert.equal(state.cache.decisions[visualReviewIdentity(item)].verdict, "uncertain");
    assert.equal(state.ledger?.attempts.at(-1)?.state, "completed");
    const second = await run({ day: "2026-10-14" });
    assert.equal(second.report.cachedDeferred, 1); assert.equal(second.report.requests, 0);
    assert.equal(state.events.filter(event => event === "provider").length, 1);
  }
});

test("malformed, missing, duplicate and mismatched provider identities fail the batch and consume the attempt", async () => {
  const corruptions = [
    (output: ReturnType<typeof approve>) => { output.decisions = []; },
    (output: ReturnType<typeof approve>) => { output.decisions[0].identity = hash("other-source"); },
    (output: ReturnType<typeof approve>) => { output.decisions[0].id = "unexpected"; },
    (output: ReturnType<typeof approve>) => { output.decisions[0].attachments.pop(); },
    (output: ReturnType<typeof approve>) => { output.decisions[0].attachments.reverse(); },
    (output: ReturnType<typeof approve>) => { output.decisions[0].attachments[1] = output.decisions[0].attachments[0]; },
    (output: ReturnType<typeof approve>) => { output.decisions[0].attachments[0].sha256 = hash("wrong-image"); },
    (output: ReturnType<typeof approve>) => { output.decisions.push(output.decisions[0]); },
  ];
  for (const corrupt of corruptions) {
    const { run, state } = harness([prompt("invalid-response", "image", 2)]);
    const first = await run({ provider: async items => { const output = approve(items); corrupt(output); return output; } });
    assert.equal(first.report.status, "failed"); assert.deepEqual(first.prompts, []);
    assert.deepEqual(state.cache.decisions, {}); assert.equal(state.ledger?.attempts.at(-1)?.state, "failed");
    const calls = state.preparedIDs.length, second = await run();
    assert.equal(second.report.status, "prior-attempt-blocked"); assert.equal(second.report.requests, 0);
    assert.equal(state.preparedIDs.length, calls); assert.equal(state.events.filter(event => event === "provider").length, 1);
  }
});

test("provider failure cannot replace a previous snapshot and does not retry the same UTC day", async () => {
  const old = prompt("retained"), changed = structuredClone(old); changed.prompt += " Add a striped cloth.";
  const { run, state } = harness([changed], [old]);
  const failed = await run({ provider: async () => { throw new Error("Synthetic provider timeout"); } });
  assert.deepEqual(failed.prompts, []); assert.deepEqual(failed.withheldIDs, [old.id]);
  assert.equal(failed.report.previousSnapshots, 0); assert.deepEqual(old, prompt("retained"));
  const second = await run(); assert.equal(second.report.status, "prior-attempt-blocked");
  assert.equal(state.events.filter(event => event === "provider").length, 1);
});

test("reservation persistence failure makes zero provider calls, while cache persistence failure withholds approval", async () => {
  const reserved = harness([prompt("reservation")]);
  await assert.rejects(reserved.run({ persistLedger: async () => { throw new Error("No durable reservation"); } }), /No durable reservation/);
  assert(!reserved.state.events.includes("provider"));
  const cache = harness([prompt("cache-write")]);
  const result = await cache.run({ persistCache: async () => { throw new Error("No durable evidence"); } });
  assert.equal(result.report.status, "failed"); assert.deepEqual(result.prompts, []);
  assert.deepEqual(cache.state.cache.decisions, {}); assert.equal(cache.state.ledger?.attempts.at(-1)?.state, "failed");
});

test("limits preparation to three candidates and rotates past failed media on later days", async () => {
  const items = Array.from({ length: 10 }, (_, index) => prompt(`item-${index}`)), { run, state } = harness(items);
  await run({ maxRequests: 1, prepareMedia: async () => { throw new Error("Unreachable synthetic media"); } });
  assert.equal(state.preparedIDs.length, 3); const firstIDs = [...state.preparedIDs];
  state.preparedIDs = [];
  await run({ day: "2026-10-14", maxRequests: 1, prepareMedia: async () => { throw new Error("Unreachable synthetic media"); } });
  assert.equal(state.preparedIDs.length, 3); assert.notDeepEqual(state.preparedIDs, firstIDs);
  assert.deepEqual(state.events, []);
});

test("three-candidate, sixteen-image and actual byte budgets bound each provider request without truncating galleries", async () => {
  const images = harness(Array.from({ length: 5 }, (_, index) => prompt(`gallery-${index}`, "image", 8)));
  const result = await images.run({ maxRequests: 1 });
  assert.equal(images.state.preparedIDs.length, 3); assert.equal(result.report.attemptedCandidates, 2);
  assert.equal(images.state.inputs.flatMap(item => item.attachments).length, 16);
  assert(images.state.inputs.every(item => item.attachments.length === 8));
  const bytes = harness(Array.from({ length: 3 }, (_, index) => prompt(`bytes-${index}`, "image", 3)));
  const byteResult = await bytes.run({ maxRequests: 1, prepareMedia: async item => {
    const media = prepare(item); for (const attachment of media.attachments) attachment.byteLength = 6_000_000; return media;
  } });
  assert.equal(byteResult.report.attemptedCandidates, 1); assert.equal(byteResult.report.attachmentBytes, 18_000_000);
  assert.equal(bytes.state.preparedIDs.length, 2, "The next intact item is carried instead of preparing past a full batch");
});

test("shared serialized input budget includes attachment metadata and permits the exact boundary without truncation", async () => {
  const item = prompt("boundary"), media = prepare(item);
  const input: VisualInput = { id: item.id, identity: visualReviewIdentity(item), kind: "image", prompt: item.prompt,
    model: item.model, source: { url: item.source.url, repository: item.source.repository, license: item.source.license }, ...media };
  item.prompt += "x".repeat(32000 - visualInputCharacters([input]));
  const exact = harness([item]); const accepted = await exact.run();
  assert.equal(accepted.report.inputCharacters, 32000); assert.equal(accepted.report.approved, 1);
  assert.equal(exact.state.inputs[0].prompt, item.prompt);
  const tooLarge = harness([{ ...item, prompt: item.prompt + "x" }]); const rejected = await tooLarge.run();
  assert.equal(rejected.report.requests, 0); assert.deepEqual(rejected.prompts, []);
  assert.match(rejected.report.items[0].reason!, /bounded budget/); assert.deepEqual(tooLarge.state.events, []);
});

test("duplicate input IDs and foreign cache keys fail closed without preparation or requests", async () => {
  const item = prompt("duplicate"), duplicates = harness([item, item]);
  await assert.rejects(duplicates.run(), /Duplicate prompt/); assert.deepEqual(duplicates.state.preparedIDs, []);
  const cached = harness([item]); await cached.run();
  const entry = Object.values(cached.state.cache.decisions)[0]; cached.state.cache.decisions = { [hash("foreign")]: entry };
  cached.state.events = []; cached.state.preparedIDs = [];
  await assert.rejects(cached.run(), /Visual cache identity mismatch/);
  assert.deepEqual(cached.state.preparedIDs, []); assert.deepEqual(cached.state.events, []);
});

test("default daily budget completes four durable batches and a repeat run cannot exceed it", async () => {
  const items = Array.from({ length: 15 }, (_, index) => prompt(`batch-${String(index).padStart(2, "0")}`));
  const { run, state } = harness(items);
  const result = await run();
  assert.equal(result.report.maxRequests, 4); assert.equal(result.report.requests, 4); assert.equal(result.report.dailyRequests, 4);
  assert.equal(result.report.approved, 12); assert.equal(result.prompts.length, 12); assert.equal(result.withheldIDs.length, 3);
  assert.equal(state.preparedIDs.length, 12); assert.equal(new Set(state.preparedIDs).size, 12);
  assert.deepEqual(state.events, Array.from({ length: 4 }, () => ["reserved", "provider", "cache", "completed"]).flat());
  assert.equal(state.ledger?.requests, 4); assert.equal(state.ledger?.attempts.length, 4);
  assert(state.ledger?.attempts.every(attempt => attempt.state === "completed" && attempt.candidateIDs.length === 3));
  visualLedgerSchema.parse(state.ledger);
  assert.equal(Object.keys(state.cache.decisions).length, 12, "Later batches retain every earlier persisted decision");
  const repeated = await run();
  assert.equal(repeated.report.requests, 0); assert.equal(repeated.report.dailyRequests, 4);
  assert.equal(repeated.report.cachedApproved, 12); assert.equal(repeated.report.status, "daily-limit");
  assert.equal(state.batches.length, 4); assert.equal(state.preparedIDs.length, 12);
});

test("later batches preserve whole galleries and every per-request cap", async () => {
  const { run, state } = harness(Array.from({ length: 5 }, (_, index) => prompt(`full-gallery-${index}`, "image", 8)));
  const result = await run();
  assert.equal(result.report.requests, 3); assert.equal(result.report.approved, 5);
  assert.deepEqual(state.batches.map(batch => batch.length), [2, 2, 1]);
  assert.equal(state.preparedIDs.length, 5, "Carrying a prepared gallery does not download it again");
  for (const batch of state.batches) {
    assert(batch.length <= 3); assert(batch.flatMap(item => item.attachments).length <= 16);
    assert(batch.every(item => item.attachments.length === 8)); assert(visualInputCharacters(batch) <= 32000);
    assert(batch.flatMap(item => item.attachments).reduce((sum, attachment) => sum + attachment.byteLength, 0) <= 32_000_000);
  }
});

test("legacy completed attempt counts as one and later calls resume within the configured budget", async () => {
  const { run, state } = harness(Array.from({ length: 8 }, (_, index) => prompt(`legacy-${index}`)));
  await run({ maxRequests: 1 });
  const legacy = structuredClone(state.ledger!.attempts[0]);
  const resumed = await run({ ledger: legacy, maxRequests: "3" });
  assert.equal(resumed.report.requests, 2); assert.equal(resumed.report.dailyRequests, 3);
  assert.equal(resumed.report.cachedApproved, 3); assert.equal(resumed.report.approved, 5);
  assert.equal(resumed.prompts.length, 8); assert.equal(state.ledger?.schemaVersion, 2);
  assert.deepEqual(state.ledger?.attempts[0], legacy);
  assert.equal(new Set(state.batches.flatMap(batch => batch.map(item => item.identity))).size, 8);
});

test("legacy failed and reserved attempts stop the day even when the configured budget increases", async () => {
  for (const status of ["failed", "reserved"] as const) {
    const { run, state } = harness([prompt(`legacy-${status}`)]);
    await run();
    const legacy: VisualAttempt = { ...state.ledger!.attempts[0], state: status };
    state.cache = { version: 1, decisions: {} }; state.events = []; state.preparedIDs = [];
    const saved = JSON.stringify(state.ledger), savedLegacy = JSON.stringify(legacy);
    const result = await run({ ledger: legacy, maxRequests: 20 });
    assert.equal(result.report.requests, 0); assert.equal(result.report.dailyRequests, 1);
    assert.equal(result.report.status, "prior-attempt-blocked"); assert.deepEqual(state.events, []); assert.deepEqual(state.preparedIDs, []);
    assert.deepEqual(result.report.blockedAttempt, { ordinal: 1, state: status, reservedAt: legacy.reservedAt });
    assert.equal(JSON.stringify(state.ledger), saved); assert.equal(JSON.stringify(legacy), savedLegacy);
    const tomorrow = await run({ ledger: legacy, day: "2026-10-14", maxRequests: 20 });
    assert.equal(tomorrow.report.status, "reviewed"); assert.equal(tomorrow.report.requests, 1);
    assert.equal(tomorrow.report.dailyRequests, 1); assert.equal(tomorrow.report.blockedAttempt, undefined);
  }
});

test("an exhausted visual budget remains a daily limit even with an unfinished final attempt", async () => {
  for (const status of ["completed", "reserved", "failed"] as const) {
    const { run, state } = harness([prompt(`budget-${status}`)]);
    await run();
    const legacy: VisualAttempt = { ...state.ledger!.attempts[0], state: status };
    state.cache = { version: 1, decisions: {} }; state.events = []; state.preparedIDs = [];
    const saved = JSON.stringify(legacy);
    const result = await run({ ledger: legacy, maxRequests: 1 });
    assert.equal(result.report.status, "daily-limit"); assert.equal(result.report.blockedAttempt, undefined);
    assert.equal(result.report.requests, 0); assert.equal(result.report.dailyRequests, 1); assert.equal(result.report.maxRequests, 1);
    assert.deepEqual(state.events, []); assert.deepEqual(state.preparedIDs, []); assert.equal(JSON.stringify(legacy), saved);
  }
});

test("a failed second batch preserves the first batch and blocks remaining requests until the next UTC day", async () => {
  const { run, state } = harness(Array.from({ length: 9 }, (_, index) => prompt(`partial-${index}`)));
  let calls = 0;
  const failed = await run({ provider: async input => {
    if (++calls === 2) throw new Error("Synthetic second-batch timeout");
    return approve(input);
  } });
  assert.equal(failed.report.status, "failed"); assert.equal(failed.report.requests, 2); assert.equal(failed.report.dailyRequests, 2);
  assert.equal(failed.report.approved, 3); assert.equal(failed.prompts.length, 3);
  assert.equal(Object.keys(state.cache.decisions).length, 3);
  assert.deepEqual(state.ledger?.attempts.map(attempt => attempt.state), ["completed", "failed"]);
  const repeated = await run({ maxRequests: 20 });
  assert.equal(repeated.report.requests, 0); assert.equal(repeated.report.cachedApproved, 3);
  assert.equal(state.batches.length, 2); assert.equal(state.preparedIDs.length, 6);
  const tomorrow = await run({ day: "2026-10-14" });
  assert.equal(tomorrow.report.requests, 2); assert.equal(tomorrow.report.dailyRequests, 2);
  assert.equal(tomorrow.prompts.length, 9);
  assert(state.ledger?.attempts.every(attempt => attempt.day === "2026-10-14"));
});

test("persisted interruption before a second call remains reserved and never replays its identities", async () => {
  const { run, state } = harness(Array.from({ length: 9 }, (_, index) => prompt(`interrupted-${index}`)));
  await assert.rejects(run({ persistLedger: async ledger => {
    state.ledger = structuredClone(ledger);
    if (ledger.requests === 2 && ledger.attempts.at(-1)?.state === "reserved") throw new Error("Synthetic interruption after reservation");
  } }), /interruption after reservation/);
  assert.equal(state.batches.length, 1); assert.equal(Object.keys(state.cache.decisions).length, 3);
  assert.deepEqual(state.ledger?.attempts.map(attempt => attempt.state), ["completed", "reserved"]);
  const repeated = await run();
  assert.equal(repeated.report.status, "prior-attempt-blocked"); assert.equal(repeated.report.requests, 0);
  assert.equal(repeated.report.cachedApproved, 3); assert.equal(repeated.report.dailyRequests, 2);
  assert.equal(state.batches.length, 1);
});

test("completed identity history prevents duplicate paid review when its cache entry disappears", async () => {
  const { run, state } = harness(Array.from({ length: 6 }, (_, index) => prompt(`lost-evidence-${index}`)));
  await run({ maxRequests: 1 });
  const attempted = new Set(state.ledger!.attempts[0].identities);
  state.cache = { version: 1, decisions: {} };
  const resumed = await run({ maxRequests: 2 });
  assert.equal(resumed.report.requests, 1); assert.equal(resumed.report.dailyRequests, 2);
  assert.equal(resumed.prompts.length, 3); assert.equal(resumed.withheldIDs.length, 3);
  assert(state.batches[1].every(item => !attempted.has(item.identity)));
  assert(resumed.report.items.filter(item => attempted.has(item.identity)).every(item => /Already attempted/.test(item.reason ?? "")));
});

test("zero budget skips all preparation and invalid budgets fail before any side effect", async () => {
  for (const maxRequests of [0, "0"]) {
    const { run, state } = harness([prompt("disabled-budget")]);
    const result = await run({ maxRequests });
    assert.equal(result.report.requests, 0); assert.equal(result.report.maxRequests, 0);
    assert.equal(result.report.status, "daily-limit"); assert.deepEqual(state.events, []); assert.deepEqual(state.preparedIDs, []);
  }
  for (const maxRequests of [-1, 65, 1.5, "1.5", "4 ", "all", false, null]) {
    const { run, state } = harness([prompt("bad-budget")]);
    await assert.rejects(run({ maxRequests }), /request limit/);
    assert.deepEqual(state.events, []); assert.deepEqual(state.preparedIDs, []);
  }
});

test("preparation failures are bounded by the remaining daily slots without spending provider requests", async () => {
  const { run, state } = harness(Array.from({ length: 20 }, (_, index) => prompt(`preflight-${index}`)));
  const result = await run({ prepareMedia: async () => { throw new Error("Synthetic unavailable image"); } });
  assert.equal(state.preparedIDs.length, 12); assert.equal(result.report.preflightDeferred, 12);
  assert.equal(result.report.requests, 0); assert.deepEqual(state.events, []);
});

test("video policy migration preserves old evidence without reinterpreting it as new approval", async () => {
  const item = prompt("policy-migration", "video");
  // The pre-0.4.1 cache contract had no video review policy discriminator.
  const legacyIdentity = hash(JSON.stringify({ id: item.id, prompt: item.prompt, kind: item.kind, model: item.model,
    contentType: item.contentType ?? "prompt", source: { url: item.source.url, repository: item.source.repository ?? null, license: item.source.license },
    media: { image: null, video: null, imageURL: item.media!.imageURL, imageURLs: [], videoURL: item.media!.videoURL, demoURL: null } }));
  const { run, state } = harness([item]);
  await run();
  const evidence = state.cache.decisions[visualReviewIdentity(item)];
  state.cache = { version: 1, decisions: { [legacyIdentity]: { ...evidence, identity: legacyIdentity } } };
  const result = await run({ provider: null });
  assert.equal(result.prompts.length, 0);
  assert.equal(result.report.cachedApproved, 0);
  assert.equal(result.report.pending, 1);
  assert.ok(state.cache.decisions[legacyIdentity], "Historical evidence is retained for audit");
});

test("presentation is independent of relevance; explicit content cannot survive a previous snapshot", async () => {
  for (const presentation of ["general", "suggestive", "unknown", "explicit"] as const) {
    const item = prompt(`presentation-${presentation}`), { run } = harness([item]);
    const result = await run({ provider: async items => ({ decisions: approve(items).decisions.map(decision => ({ ...decision, presentation })) }) });
    if (presentation === "explicit") {
      assert.deepEqual(result.prompts, []); assert.deepEqual(result.blockedIDs, [item.id]);
      const cached = await run({ previous: [item], provider: null });
      assert.deepEqual(cached.prompts, []); assert.deepEqual(cached.blockedIDs, [item.id]);
    } else {
      assert.equal(result.prompts[0].presentation, presentation); assert.deepEqual(result.blockedIDs, []);
    }
  }
});

test("legacy relevance evidence never fabricates a general presentation rating", async () => {
  const item = prompt("legacy-relevance"), { run } = harness([item]);
  const result = await run({ provider: async items => ({ decisions: approve(items).decisions.map(({ presentation: _, ...decision }) => decision) }) });
  assert.equal(result.prompts[0].presentation, "unknown");
  const cached = await run({ previous: [item], provider: null });
  assert.equal(cached.prompts[0].presentation, "unknown");
});


test("published presentation backfill uses only spare budget and never outranks new media", async () => {
  const old = Array.from({ length: 8 }, (_, n) => prompt(`old-${n}`));
  const fresh = [prompt("new-a"), prompt("new-b")];
  const { run, state } = harness([...old, ...fresh], old);
  const result = await run({ classifyPublished: true, maxRequests: 1 });
  assert.equal(result.report.requests, 1); assert.equal(state.inputs.length, 3);
  assert.deepEqual(new Set(state.inputs.slice(0, 2).map(item => item.id)), new Set(fresh.map(item => item.id)));
  assert.ok(state.inputs[2].id.startsWith("old-"));
  assert.equal(result.report.previousSnapshots, 0);
  const repeated = await run({ classifyPublished: true, maxRequests: 1 });
  assert.equal(repeated.report.requests, 0); assert.equal(repeated.report.dailyRequests, 1);
});


test("retained media keeps a presentation rating independently of relevance and never crosses identities", async () => {
  const item = prompt("retained-suggestive", "image", 2), {run, state} = harness([item]);
  const reviewed = await run({provider: async items => ({decisions: approve(items).decisions.map(d => ({
    ...d, presentation: "suggestive", verdict: "mismatch", attachments: d.attachments.map(a => ({...a, verdict: "mismatch"})),
  }))})});
  assert.equal(reviewed.prompts.length, 0, "A rating must not grant relevance approval");
  assert.equal(applyVisualPresentation([item], state.cache)[0].presentation, "suggestive");
  const changed = {...item, media: {...item.media!, imageURLs: item.media!.imageURLs!.slice(0, 1)}};
  assert.equal(applyVisualPresentation([changed], state.cache)[0].presentation, "unknown");
  const corrupt = structuredClone(state.cache);
  corrupt.decisions[visualReviewIdentity(item)].attachments.pop();
  assert.equal(applyVisualPresentation([item], corrupt)[0].presentation, "unknown");
  const foreign = structuredClone(state.cache);
  foreign.decisions[visualReviewIdentity(item)].id = "other-source";
  assert.equal(applyVisualPresentation([item], foreign)[0].presentation, "unknown");
});


test("retained identity rejection isolates its batch, consumes allowance and never fabricates visual evidence", async () => {
  const items = Array.from({ length: 6 }, (_, i) => prompt(`identity-rejection-${i}`));
  const { run, state } = harness(items); let calls = 0;
  const result = await run({ maxRequests: 2, provider: async inputs => {
    if (++calls === 1) throw new VisualIdentityRejection(hash("retained-invalid-response"));
    return approve(inputs);
  } });
  assert.equal(result.prompts.length, 3); assert.equal(result.withheldIDs.length, 3);
  assert.equal(result.report.rejectedRequests, 1); assert.equal(result.report.dailyRequests, 2);
  assert.deepEqual(state.ledger?.attempts.map(a => a.state), ["rejected", "completed"]);
  assert.equal(state.ledger?.attempts[0].responseSHA256, hash("retained-invalid-response"));
  for (const input of state.batches[0]) assert.equal(state.cache.decisions[input.identity], undefined);
  assert.equal(visualLedgerSchema.safeParse(state.ledger).success, true);
  const missingProof = structuredClone(state.ledger!); delete missingProof.attempts[0].responseSHA256;
  assert.equal(visualLedgerSchema.safeParse(missingProof).success, false);
  const resumed = await run({ maxRequests: 3 });
  assert.equal(resumed.report.requests, 0); assert.equal(state.events.filter(e => e === "provider").length, 2);
  assert.equal(resumed.prompts.length, 3);
});
