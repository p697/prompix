import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Prompt } from "../packages/schema/catalog.ts";
import { mirrorPromptMedia, mirrorPromptMediaBatch, type MediaMirrorDependencies } from "./mirror-media.ts";
import { atomic, json } from "./publication.ts";
function item(): Prompt { return { id: "synthetic", kind: "image", title: "Synthetic", summary: "Synthetic", prompt: "Create a paper village", example: "Synthetic", tags: [], model: "Any", toolURL: null,
  artwork: "synthetic", previewLabel: "Source attachment", source: { name: "X", url: "https://x.com/i/web/status/1", license: "Source-author-rights", method: "Synthetic test" },
  media: { image: null, video: null, demoURL: null, imageURL: "https://pbs.twimg.com/media/a.jpg", imageURLs: ["https://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com/media/b.jpg"] } }; }
test("mirroring resumes a partial gallery and preserves its order and immutable cover", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-mirror-test-")); let downloads = 0, uploads = 0, fail = true;
  const deps: MediaMirrorDependencies = { download: async url => { downloads++; return { bytes: Buffer.from(url), type: "image/jpeg" }; },
    prepareJPEG: copyFile, aspectRatio: async () => 0.75, upload: async () => { uploads++; if (uploads === 2 && fail) throw new Error("temporary upload failure"); } };
  try {
    const original = item(); await assert.rejects(mirrorPromptMedia(original, root, deps), /temporary upload/);
    assert.equal(Object.keys(await json(join(root, "media-map.json"), {})).length, 1);
    assert.equal(original.media!.imageURL, "https://pbs.twimg.com/media/a.jpg");
    fail = false; const resumed = await mirrorPromptMedia(original, root, deps);
    assert.equal(downloads, 3); assert.equal(uploads, 3); assert.equal(resumed.media!.aspectRatio, 0.75);
    assert.equal(resumed.media!.imageURLs![0], resumed.media!.imageURL); assert.equal(resumed.media!.imageURLs!.length, 2);
    await mirrorPromptMedia(original, root, deps); assert.equal(downloads, 3); assert.equal(uploads, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("unsafe cached media cannot bypass the immutable media host", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-mirror-test-"));
  try { await atomic(join(root, "media-map.json"), { "https://pbs.twimg.com/media/a.jpg": "https://evil.invalid/a.jpg" }); await assert.rejects(mirrorPromptMedia(item(), root), /Invalid cached media/); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("bounded media workers share URLs, retain every map entry and preserve input order", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-mirror-concurrent-"));
  const originals = Array.from({ length: 8 }, (_, index) => ({ ...item(), id: `fixture-${index}`,
    media: { ...item().media!, imageURL: `https://pbs.twimg.com/media/${index}.jpg`, imageURLs: [`https://pbs.twimg.com/media/${index}.jpg`, 'https://pbs.twimg.com/media/shared.jpg'] } }));
  let active = 0, maximum = 0, downloads = 0, uploads = 0;
  const deps: MediaMirrorDependencies = { download: async url => { downloads++; maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, url.endsWith('/0.jpg') ? 25 : 5)); active--; return { bytes: Buffer.from(url), type: 'image/jpeg' }; },
    prepareJPEG: copyFile, aspectRatio: async () => 0.75, upload: async () => { uploads++; } };
  try {
    const oldURL = 'https://pbs.twimg.com/media/retained.jpg', oldMapping = `https://api.prompix.dev/media/${'a'.repeat(64)}.jpg`;
    await atomic(join(root, 'media-map.json'), { [oldURL]: oldMapping });
    await atomic(join(root, 'media-aspects.json'), { [oldURL]: 1 });
    const result = await mirrorPromptMediaBatch(originals, root, 3, deps);
    assert.deepEqual(result.errors, []); assert.deepEqual(result.prompts.map(p => p.id), originals.map(p => p.id));
    assert.equal(maximum, 3); assert.equal(downloads, 9); assert.equal(uploads, 9);
    assert.equal(new Set(result.prompts.map(p => p.media!.imageURLs![1])).size, 1);
    for (const p of result.prompts) { assert.equal(p.media!.imageURL, p.media!.imageURLs![0]); assert.equal(p.media!.aspectRatio, 0.75); }
    const map = await json<Record<string, string>>(join(root, 'media-map.json'), {});
    assert.equal(Object.keys(map).length, 10); assert.equal(map[oldURL], oldMapping);
    assert.equal(Object.keys(await json(join(root, 'media-aspects.json'), {})).length, 10);
    assert.match(originals[0].media.imageURL, /^https:\/\/pbs\.twimg\.com/);
    await mirrorPromptMediaBatch(originals, root, 3, deps);
    assert.equal(downloads, 9); assert.equal(uploads, 9);
    await assert.rejects(mirrorPromptMediaBatch(originals, root, 4, deps), /concurrency/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a shared failed media URL is attempted once without discarding other completed items", async () => {
  const root = await mkdtemp(join(tmpdir(), 'prompix-mirror-failed-shared-')); let failedDownloads = 0;
  const deps: MediaMirrorDependencies = { download: async url => {
    if (url.endsWith('/bad.jpg')) { failedDownloads++; throw new Error('Invalid source media'); }
    return { bytes: Buffer.from(url), type: 'image/jpeg' };
  }, prepareJPEG: copyFile, aspectRatio: async () => 1, upload: async () => {} };
  try {
    const bad = { ...item(), media: { ...item().media!, imageURL: 'https://pbs.twimg.com/media/bad.jpg', imageURLs: undefined } };
    const result = await mirrorPromptMediaBatch([bad, { ...bad, id: 'second' }, { ...item(), id: 'good' }], root, 3, deps);
    assert.equal(failedDownloads, 1); assert.deepEqual(result.prompts.map(p => p.id), ['good']);
    assert.deepEqual(result.errors.map(e => e.id), ['synthetic', 'second']);
    assert.equal(Object.keys(await json(join(root, 'media-map.json'), {})).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("media map persistence failure blocks the batch instead of becoming an item rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), 'prompix-mirror-write-failure-'));
  const deps: MediaMirrorDependencies = { download: async url => ({ bytes: Buffer.from(url), type: 'image/jpeg' }),
    prepareJPEG: copyFile, aspectRatio: async () => 1, upload: async () => { await mkdir(join(root, 'media-aspects.json'), { recursive: true }); } };
  try { await assert.rejects(mirrorPromptMediaBatch([item()], root, 3, deps)); }
  finally { await rm(root, { recursive: true, force: true }); }
});
