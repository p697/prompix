import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Prompt } from "../packages/schema/catalog.ts";
import { prepareDailyVisualReview } from "./visual-daily.ts";
import { applyEditorialReviews } from "./editorial.ts";
import { selectLibrary, retainPublishedLibrary } from "./library.ts";
import { fingerprint, type Candidate } from "./sources.ts";

function picture(): Candidate {
  const prompt = "Create a quiet garden illustration with a stone path, flowering trees, soft morning light and a small wooden bench. Keep the composition spacious and readable.";
  return { id: "visual-daily-fixture", kind: "image", title: "Quiet garden", summary: "An original test fixture.",
    prompt, example: "Synthetic instructions for a test.", tags: ["Garden"], model: "Test model", toolURL: null,
    artwork: "test", previewLabel: "Source image", source: { name: "Test", url: "https://example.com/garden",
      license: "Original", method: "Synthetic test fixture" },
    media: { image: null, video: null, demoURL: null, imageURL: `https://api.prompix.dev/media/${"a".repeat(64)}.jpg` },
    fingerprint: fingerprint(prompt), featured: false, reviewStatus: "draft" };
}

test("daily dry-run cannot use a configured provider or write a visual ledger, and cached metadata cannot publish media", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-visual-dry-"));
  try {
    const item = picture();
    const reviewed = applyEditorialReviews([item], { [item.id]: { fingerprint: item.fingerprint,
      reviewedAt: "2026-10-12T00:00:00Z", metadata: { title: item.title, summary: item.summary,
        example: item.example, tags: item.tags, previewLabel: item.previewLabel } } });
    const selected = selectLibrary(reviewed, new Set());
    assert.equal(selected.length, 1, "A historical metadata approval still reaches the independent gate");
    const result = await prepareDailyVisualReview(selected, [], root, false,
      { PROMPIX_VISUAL_PROVIDER: "codex", PROMPIX_CODEX: "/must-not-be-executed" });
    assert.equal(result.report.requests, 0);
    assert.deepEqual(result.prompts, []);
    assert.deepEqual(result.withheldIDs, [item.id]);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("withheld media replacement preserves the entire previous snapshot and its saved identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-visual-retention-"));
  try {
    const item = picture();
    const previous: Prompt = { ...item, prompt: "Create a quiet garden with a single flowering tree and a wooden bench.",
      media: { ...item.media!, imageURL: `https://api.prompix.dev/media/${"b".repeat(64)}.jpg` } };
    const result = await prepareDailyVisualReview([item], [previous], root, true, {});
    assert.deepEqual(result.withheldIDs, [item.id]);
    const retained = retainPublishedLibrary(result.prompts, [previous], new Set(), () => "awaiting-media-review");
    assert.deepEqual(retained.prompts, [previous]);
    assert.equal(retained.retainedPrevious.reasons["awaiting-media-review"], 1);
    assert.equal(result.report.requests, 0);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unchanged published snapshot stays available without inventing a visual approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-visual-previous-"));
  try {
    const item = picture();
    const result = await prepareDailyVisualReview([item], [item], root, true, {});
    assert.deepEqual(result.prompts, [item]);
    assert.equal(result.report.previousSnapshots, 1);
    assert.equal(result.report.approved, 0);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
