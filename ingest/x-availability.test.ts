import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomic } from "./publication.ts";
import { parseXAvailability } from "./x.ts";
import { convertXDiscovery } from "./x-intake.ts";
import { filterXAvailability, prepareXAvailability } from "./x-availability.ts";
import { nativeXSourceDigest, nativeXSourceIssue } from "./x-source.ts";
import { automaticReviewEligibility } from "./editorial-runner.ts";
import { applyEditorialReviews } from "./editorial.ts";
import { selectLibrary } from "./library.ts";
const now = new Date().toISOString();
const post = { id: "123", author_id: "456", created_at: now, text: "Text prompt:\nWrite an original three-scene story. Ask me about my audience and subject before you begin, and finish with a surprising but coherent ending." };
const creator = { id: "x-test", externalID: "456", platform: "x" as const, username: "fixture", displayName: "Fixture", profileURL: "https://x.com/fixture" };
const snapshot = { capturedAt: now, posts: [post], creators: [creator] };
const candidate = () => convertXDiscovery([{ name: "fixture", data: snapshot }]).candidates[0];

test("complete native attribution enters review and exact source revision binds approval", () => {
  const item = candidate();
  assert.equal(nativeXSourceIssue(item), undefined);
  assert.equal(automaticReviewEligibility(item), undefined);
  const entry = { fingerprint: item.fingerprint, sourceRevision: item.source.revision, reviewedAt: now,
    metadata: { title: "Original story", summary: "A test fixture", example: "使用建议：Choose a topic.", tags: ["Writing"], previewLabel: "提示词主题" } };
  assert.equal(selectLibrary(applyEditorialReviews([item], { [item.id]: entry }), new Set()).length, 1);
  const changed = structuredClone(item); changed.source.post!.text += " Updated context.";
  changed.source.revision = nativeXSourceDigest(changed);
  assert.equal(applyEditorialReviews([changed], { [item.id]: entry })[0].reviewStatus, "draft");
  const refreshed = structuredClone(item); refreshed.source.post!.checkedAt = new Date(Date.now() + 1000).toISOString();
  assert.equal(nativeXSourceDigest(refreshed), item.source.revision);
  const altered = applyEditorialReviews([item], { [item.id]: { ...entry, metadata: { ...entry.metadata, imageURL: "https://example.com/unrelated.jpg" } } })[0];
  assert.deepEqual(altered.media, item.media);
});

test("stale, changed and withdrawn sources are withheld after retention, without touching other sources", () => {
  const item = candidate();
  assert.equal(filterXAvailability([item], {}, Date.now() + 25 * 3600_000).prompts.length, 0);
  const checkedAt = new Date(Date.now() + 13 * 3600_000).toISOString();
  for (const record of [{ checkedAt, status: "withheld" as const }, { checkedAt, status: "ready" as const, revision: "b".repeat(64) }])
    assert.deepEqual(filterXAvailability([item], { [item.id]: record }, Date.parse(checkedAt)).withheldIDs, [item.id]);
  assert.equal(filterXAvailability([item], { [item.id]: { checkedAt, status: "ready", revision: item.source.revision } }, Date.parse(checkedAt)).prompts[0].source.post?.checkedAt, checkedAt);
});

test("X lookup accepts accounted-for deletions, rejects ambiguous partial errors and foreign identities", () => {
  const error = { resource_id: "789", type: "https://api.twitter.com/2/problems/resource-not-found" };
  assert.deepEqual(parseXAvailability({ data: [post], errors: [error] }, ["123", "789"]).unavailable, ["789"]);
  assert.throws(() => parseXAvailability({ data: [post] }, ["123", "789"]), /inconsistent/);
  assert.throws(() => parseXAvailability({ errors: [{ ...error, type: "rate-limit" }] }, ["789"]), /unresolved/);
  assert.throws(() => parseXAvailability({ data: [post] }, ["789"]), /inconsistent/);
  assert.deepEqual(parseXAvailability({ data: [{ ...post, withheld: {} }] }, ["123"]).unavailable, ["123"]);
});

test("maintenance reserves before paid reads and does not retry an uncertain result", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-x-check-"));
  try {
    await atomic(join(root, "x-discovery", "2026-10-12.json"), snapshot);
    const next = new Date(Date.now() + 13 * 3600_000).toISOString();
    let calls = 0;
    const lookup = async () => { calls++; throw new Error("Unavailable"); };
    assert.equal((await prepareXAvailability(root, { enabled: true, bearer: "fixture", now: next, lookup })).report.status, "failed");
    assert.equal((await prepareXAvailability(root, { enabled: true, bearer: "fixture", now: next, lookup })).report.status, "daily-limit");
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("maintenance persists withdrawal so older discovery snapshots cannot revive a deleted post", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-x-check-"));
  try {
    await atomic(join(root, "x-discovery", "2026-10-12.json"), snapshot);
    const next = new Date(Date.now() + 13 * 3600_000).toISOString();
    const result = await prepareXAvailability(root, { enabled: true, bearer: "fixture", now: next,
      lookup: async () => ({ posts: [], unavailable: ["123"], creators: [], media: [] }) });
    assert.equal(result.report.withheld, 1);
    assert.equal(filterXAvailability([candidate()], result.state, Date.parse(next)).prompts.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
