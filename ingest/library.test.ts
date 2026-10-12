import { test } from "node:test";
import assert from "node:assert/strict";
import type { Prompt } from "../packages/schema/catalog.ts";
import { applyEditorialReviews, type Reviews } from "./editorial.ts";
import { assertLibraryDownloadSize, countByKind, interleaveLibrary, libraryDelta, selectLibrary } from "./library.ts";
import { fingerprint, type Candidate } from "./sources.ts";

function candidate(id: string, kind: Prompt["kind"] = "text"): Candidate {
  const prompt = `Create an original example for ${id}. Describe a clear purpose, specific details, and a useful result while keeping the scene easy to understand.`;
  return {
    id, kind, title: `Example ${id}`, summary: "An original synthetic test fixture.", prompt,
    example: "An original test result.", tags: ["test"], model: "Test", toolURL: null,
    artwork: "test", previewLabel: "Test result",
    source: { name: "Test", url: `https://example.com/posts/${id}`, license: "Original", method: "Written for tests" },
    media: kind === "text" ? null : {
      image: null, video: null, demoURL: kind === "web" ? `https://example.com/${id}` : null,
      imageURL: `https://example.com/${id}.jpg`,
      ...(kind === "video" ? { videoURL: `https://example.com/${id}.mp4` } : {}),
    },
    fingerprint: fingerprint(prompt), featured: false, reviewStatus: "draft",
  };
}
function review(item: Candidate, priority = 0): Reviews[string] {
  return {
    fingerprint: item.fingerprint, reviewedAt: "2026-10-12T00:00:00Z",
    metadata: { title: item.title, summary: item.summary, example: item.example, tags: item.tags, previewLabel: item.previewLabel, priority },
  };
}
function approved(items: Candidate[]): Candidate[] {
  return applyEditorialReviews(items, Object.fromEntries(items.map((item) => [item.id, review(item)])));
}

test("more than twelve reviewed cards from one source remain in the full library; priority only changes order", () => {
  const items = Array.from({ length: 40 }, (_, index) => candidate(`youmind-nano-${index}`, "image"));
  const reviews = Object.fromEntries(items.map((item) => [item.id, review(item, item === items[37] ? 95 : 0)]));
  const selected = selectLibrary(applyEditorialReviews(items, reviews), new Set());
  assert.equal(selected.length, 40);
  assert.equal(selected[0].id, items[37].id);
  assert.deepEqual(new Set(selected.map((item) => item.id)), new Set(items.map((item) => item.id)));
  assert.ok(items.every((item) => item.reviewStatus === "draft"), "Planning must not mutate raw snapshots");
});

test("cross-source duplicates resolve after current review, removal and quality eligibility", () => {
  const draft = candidate("unreviewed-copy", "image");
  const removed = { ...draft, id: "removed-copy" };
  const lower = { ...draft, id: "source-a-copy" };
  const higher = { ...draft, id: "source-b-copy" };
  const missingVideo = { ...candidate("watch-page", "video"), media: null };
  const filtered = { ...candidate("filtered", "image"), title: "NSFW example" };
  const items = [draft, removed, lower, higher, missingVideo, filtered];
  const reviews = Object.fromEntries(items.filter((item) => item !== draft).map((item) => [item.id, review(item, item === removed ? 100 : item === higher ? 80 : 0)]));
  assert.deepEqual(selectLibrary(applyEditorialReviews(items, reviews), new Set([removed.id])).map((item) => item.id), [higher.id]);
});

test("no review and stale fingerprint cannot enter the expanded library", () => {
  const item = candidate("changed-source", "image");
  const changed = { ...item, prompt: item.prompt + " A new detail.", fingerprint: fingerprint(item.prompt + " A new detail.") };
  const reviews = { [item.id]: review(item) };
  assert.equal(selectLibrary(applyEditorialReviews([{ ...item, reviewStatus: "candidate" }], {}), new Set()).length, 0);
  assert.equal(selectLibrary(applyEditorialReviews([changed], reviews), new Set()).length, 0);
  assert.equal(selectLibrary(applyEditorialReviews([item], reviews), new Set()).length, 1);
});

test("modality interleaving retains the complete tail beyond the former source and text/web caps", () => {
  const raw = ([ ["image", 45], ["video", 24], ["text", 30], ["web", 12] ] as const)
    .flatMap(([kind, count]) => Array.from({ length: count }, (_, index) => candidate(`community-${kind}-${index}`, kind)));
  const community = selectLibrary(approved(raw), new Set());
  const bundled = [candidate("studio-text"), candidate("studio-web", "web"), {
    ...candidate("studio-image", "image"), media: { image: "original-image", video: null, demoURL: null },
  }];
  const complete = interleaveLibrary(community, bundled, new Set());
  assert.equal(complete.length, raw.length + bundled.length);
  assert.deepEqual(complete.slice(0, 7).map((item) => item.kind), ["image", "text", "video", "web", "text", "web", "image"]);
  assert.deepEqual(new Set(complete.map((item) => item.id)), new Set([...raw, ...bundled].map((item) => item.id)));
  assert.deepEqual(countByKind(complete), { total: 114, text: 31, image: 46, video: 24, web: 13 });
});

test("final library respects tombstones and deduplicates normalized publication text against originals", () => {
  const original = candidate("studio-story");
  const duplicate = { ...candidate("community-story"), prompt: "  " + original.prompt.replaceAll(" ", "  ") + "\n" };
  const removed = candidate("removed-story");
  const complete = interleaveLibrary([duplicate, removed], [original], new Set([removed.id]));
  assert.deepEqual(complete.map((item) => item.id), [original.id]);
});

test("protocol capacity fails explicitly after deduplication instead of truncating approved entries", () => {
  const thousand = Array.from({ length: 1000 }, (_, index) => candidate(`entry-${index}`));
  assert.equal(interleaveLibrary(thousand, [], new Set()).length, 1000);
  const duplicate = { ...thousand[0], id: "another-source" };
  assert.equal(interleaveLibrary([...thousand, duplicate], [], new Set()).length, 1000);
  const tooMany = [...thousand, candidate("entry-1000")];
  assert.throws(() => interleaveLibrary(tooMany, [], new Set()), /1001 entries.*1000-entry.*no entries were truncated/);
  assert.equal(tooMany.length, 1001, "Overflow planning must not alter the input library");
});

test("repeated runs and ranking changes report zero new content; additions and removals use stable IDs", () => {
  const before = [candidate("kept-text"), candidate("old-video", "video")];
  assert.deepEqual(libraryDelta(before, [...before].reverse()), {
    added: { total: 0, text: 0, image: 0, video: 0, web: 0 },
    removed: { total: 0, text: 0, image: 0, video: 0, web: 0 }, retained: 2,
  });
  const after = [{ ...before[0], title: "Edited title" }, candidate("new-image", "image"), candidate("new-web", "web")];
  assert.deepEqual(libraryDelta(before, after), {
    added: { total: 2, text: 0, image: 1, video: 0, web: 1 },
    removed: { total: 1, text: 0, image: 0, video: 1, web: 0 }, retained: 1,
  });
});

test("oversized catalog bytes cannot be uploaded even when entry count fits the client protocol", () => {
  assert.doesNotThrow(() => assertLibraryDownloadSize(new Uint8Array(10_000_000)));
  assert.throws(() => assertLibraryDownloadSize(new Uint8Array(10_000_001)), /10000001 bytes.*10000000-byte client download limit/);
});
