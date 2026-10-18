import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Prompt } from "../packages/schema/catalog.ts";
import { mirrorPromptMedia, type MediaMirrorDependencies } from "./mirror-media.ts";
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
