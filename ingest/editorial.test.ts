import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommunityCSV, selectEdition } from "./sources.ts";
import { applyEditorialReviews, reviewsSchema, type Reviews } from "./editorial.ts";

const candidates = parseCommunityCSV('act,prompt,type,contributor\n"A tiny tale","Write a gentle story about an ordinary object. Give it a small wish, one obstacle and a surprising but kind ending. Keep the story below 150 words.",TEXT,studio\n', 'test-revision');
const item = candidates[0];
const metadata = { title: "Give a teacup a tiny adventure", summary: "An ordinary object with an unusual wish.", example: "A teacup hoped to hear the sea. One morning its owner opened the window while the kettle boiled, and for a moment it was almost there.", tags: ["好玩一点"], previewLabel: "Editorial example" };
const reviews: Reviews = { [item.id]: { fingerprint: item.fingerprint, reviewedAt: "2026-10-11T00:00:00Z", metadata } };
test("only an explicit editorial gallery adds images, keeps its order and chooses the cover", () => {
  const images = ["https://example.com/a.jpg", "https://example.com/b.jpg", "https://example.com/a.jpg"];
  const gallery = { [item.id]: { ...reviews[item.id], metadata: { ...metadata, imageURLs: images } } };
  const approved = applyEditorialReviews(candidates, gallery)[0];
  assert.deepEqual(approved.media?.imageURLs, images.slice(0, 2));
  assert.equal(approved.media?.imageURL, images[0]);
  assert.equal(applyEditorialReviews(candidates, reviews)[0].media, null);
  assert.equal(reviewsSchema.safeParse({ [item.id]: { ...reviews[item.id], metadata: { ...metadata, imageURLs: Array(9).fill(images[0]) } } }).success, false);
});
test("raw role prompts cannot enter an edition until edited; provenance and source text survive approval", () => {
  assert.equal(selectEdition(candidates, new Set(), 10).length, 0);
  assert.equal(selectEdition(applyEditorialReviews([{ ...item, reviewStatus: "candidate" }], {}), new Set(), 10).length, 0);
  const approved = applyEditorialReviews(candidates, reviews);
  assert.equal(selectEdition(approved, new Set(), 10).length, 1);
  assert.equal(approved[0].title, metadata.title);
  assert.deepEqual(approved[0].source, item.source);
  assert.equal(approved[0].prompt, item.prompt);
  assert.equal(applyEditorialReviews([{ ...item, fingerprint: 'a'.repeat(64) }], reviews)[0].reviewStatus, "draft");
});
test("website approval requires both a demo and preview; edits cannot alter provenance", () => {
  const website = { ...item, kind: "web" as const };
  assert.equal(applyEditorialReviews([website], reviews)[0].reviewStatus, "draft");
  const complete = { [item.id]: { ...reviews[item.id], metadata: { ...metadata, demoURL: "https://example.com/demo", imageURL: "https://example.com/preview.jpg" } } };
  assert.equal(applyEditorialReviews([website], complete)[0].reviewStatus, "candidate");
  assert.equal(reviewsSchema.safeParse({ [item.id]: { ...reviews[item.id], metadata: { ...metadata, source: { name: "Someone else" } } } }).success, false);
});

test("reviewed concise prompts and editorial order survive selection and removals", () => {
  const short = { ...item, id: "short", prompt: "绘制一座漂浮在茶杯里的迷你气象站，使用淡绿色水彩和柔和的晨光。", fingerprint: "b".repeat(64) };
  const ranked = applyEditorialReviews([item, short], { ...reviews, short: { fingerprint: short.fingerprint, reviewedAt: "2026-10-11T00:00:00Z", metadata: { ...metadata, priority: 90 } } });
  assert.deepEqual(selectEdition(ranked, new Set(), 2).map((x) => x.id), ["short", item.id]);
  assert.equal(selectEdition([{ ...short, reviewStatus: "candidate" }], new Set(), 1).length, 0);
  assert.equal(selectEdition(ranked, new Set(["short"]), 2).length, 1);
  assert.equal(reviewsSchema.safeParse({ short: { fingerprint: short.fingerprint, reviewedAt: "2026-10-11T00:00:00Z", metadata: { ...metadata, priority: 101 } } }).success, false);
});
