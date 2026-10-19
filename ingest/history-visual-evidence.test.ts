import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Prompt } from "../packages/schema/catalog.ts";
import { atomic } from "./publication.ts";
import { applyDailyVisualPresentation } from "./visual-daily.ts";
import { mergeHistoryVisualEvidence, adoptHistoryVisualEvidence } from "./history-visual-evidence.ts";
import { visualReviewIdentity, visualReviewModel, type VisualCache } from "./visual-review.ts";
const item: Prompt = { id: "history-art", kind: "image", title: "Art", summary: "Art", prompt: "Draw art", example: "Art", tags: [], model: "Any", toolURL: null, artwork: "art", previewLabel: "Art", source: { name: "Test", url: null, license: "CC0", method: "Synthetic" }, media: { image: null, video: null, demoURL: null, imageURL: `https://api.prompix.dev/media/${"a".repeat(64)}.jpg` } };
const empty = (): VisualCache => ({ version: 1, decisions: {} });
function cache(presentation: "general" | "suggestive" | "explicit" | "unknown" = "suggestive", reviewedAt = "2026-10-19T00:00:00Z"): VisualCache {
 const identity = visualReviewIdentity(item);
 return { version: 1, decisions: { [identity]: { id: item.id, identity, verdict: "match", reason: "Synthetic", presentation, reviewedAt, model: visualReviewModel, coverage: { mode: "images" }, attachments: [{ id: "image-0", sha256: "a".repeat(64), byteLength: 100, role: "image", sourceURL: item.media!.imageURL!, verdict: "match", reason: "Synthetic" }] } } };
}
test("historical evidence survives daily publication without provider calls and is independent of removed batch folders", async () => {
 const root = await mkdtemp(join(tmpdir(), "visual-history-"));
 try {
  const campaign = join(root, "campaign"), shared = join(root, "shared");
  await atomic(join(campaign, "run", "batch-1", "visual-cache.json"), cache());
  await adoptHistoryVisualEvidence(campaign, shared, "run", [item]);
  await rm(campaign, { recursive: true });
  assert.equal((await applyDailyVisualPresentation([item], shared))[0].presentation, "suggestive");
  const changed = { ...item, media: { ...item.media!, imageURLs: [item.media!.imageURL!, `https://api.prompix.dev/media/${"b".repeat(64)}.jpg`] } };
  assert.equal((await applyDailyVisualPresentation([changed], shared))[0].presentation, "unknown");
 } finally { await rm(root, { recursive: true, force: true }); }
});
test("newer explicit evidence wins; equal-time conflicting labels stop instead of guessing", () => {
 const newer = cache("explicit", "2026-10-19T01:00:00Z");
 assert.deepEqual(mergeHistoryVisualEvidence(newer, cache(), [item]), newer);
 assert.throws(() => mergeHistoryVisualEvidence(cache("general"), cache(), [item]), /Conflicting/);
});
test("incomplete gallery evidence and wrong identities cannot restore a label", () => {
 const incomplete = cache(); incomplete.decisions[visualReviewIdentity(item)].attachments[0].sourceURL = `https://api.prompix.dev/media/${"b".repeat(64)}.jpg`;
 assert.deepEqual(mergeHistoryVisualEvidence(empty(), incomplete, [item]), empty());
 const changed = { ...item, prompt: "Different instruction" };
 assert.deepEqual(mergeHistoryVisualEvidence(empty(), cache(), [changed]), empty());
 const invalid = cache(); invalid.decisions[visualReviewIdentity(item)].identity = "b".repeat(64);
 assert.throws(() => mergeHistoryVisualEvidence(empty(), invalid, [item]), /identity mismatch/);
});

test("newer complete unknown review clears an older known rating", () => {
 const newer = cache("unknown", "2026-10-19T02:00:00Z");
 assert.deepEqual(mergeHistoryVisualEvidence(cache(), newer, [item]), newer);
});
