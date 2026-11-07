import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint, type Candidate } from "./sources.ts";
import { editorialDecisionKey } from "./editorial-runner.ts";
import { classifyItems, summarizeFunnel, type ItemStateInput } from "./item-state.ts";
import type { Reviews } from "./editorial.ts";

const revision = "a".repeat(40), now = Date.parse("2026-11-07T00:00:00Z");
function candidate(id: string, body = `Write a practical three-step weekend plan for ${id}. Ask for the available time and location, then suggest a clear route and alternatives for rain.`): Candidate {
  return { id, kind: "text", title: `Weekend ${id}`, summary: "A synthetic weekend-planning fixture.", prompt: body,
    example: "An original test fixture.", tags: ["Planning"], model: "General text model", toolURL: null, artwork: "test",
    previewLabel: "Test", source: { name: "prompts.chat", license: "CC0-1.0", method: "Synthetic test fixture",
      url: `https://github.com/f/prompts.chat/blob/${revision}/prompts.csv`, revision }, media: null,
    fingerprint: fingerprint(body), featured: false, reviewStatus: "draft" };
}
const review = (item: Candidate): Reviews[string] => ({ fingerprint: item.fingerprint, reviewedAt: "2026-11-01T00:00:00Z",
  metadata: { title: item.title, summary: item.summary, example: item.example, tags: item.tags, previewLabel: item.previewLabel } });
const decision = (item: Candidate, value: "reject" | "defer", reason: string, model = "gpt-5.6-luna", reviewedAt = "2026-11-06T12:00:00Z") =>
  [editorialDecisionKey(item), { id: item.id, fingerprint: item.fingerprint, decision: value, reason, metadata: null, reviewedAt, model }] as const;
function input(items: Candidate[], overrides: Partial<ItemStateInput> = {}): ItemStateInput {
  return { candidates: [{ source: "prompts-chat", items }], live: new Set(), removed: new Set(), moderation: { removedIDs: [] },
    reviews: {}, editorial: { version: 1, decisions: {} }, visual: { version: 1, decisions: {} }, enrichmentExclusions: [],
    qualityHolds: { schemaVersion: 1, holds: {} }, xAvailability: {}, now, ...overrides };
}
const byID = (statuses: ReturnType<typeof classifyItems>) => Object.fromEntries(statuses.map(item => [item.id, item]));

test("database state and retired sources decide first", () => {
  const [live, gone, retired, moderated] = ["live", "gone", "retired", "moderated"].map(id => candidate(id));
  const result = byID(classifyItems(input([live, gone, moderated], { live: new Set(["live"]), removed: new Set(["gone"]),
    moderation: { removedIDs: ["moderated"], history: [{ id: "moderated", reason: "Branded combat example", at: "2026-10-11T00:00:00Z" }] },
    candidates: [{ source: "prompts-chat", items: [live, gone, moderated] }, { source: "youmind-nano", items: [retired] }] })));
  assert.equal(result.live.state, "live");
  assert.equal(result.gone.state, "removed");
  assert.deepEqual([result.retired.state, result.retired.stage], ["excluded", "source"]);
  assert.deepEqual([result.moderated.state, result.moderated.reason], ["excluded", "Branded combat example"]);
});

test("a cached model deferral or rejection is final; an unreviewed item waits", () => {
  const [deferred, rejected, fresh] = ["deferred", "rejected", "fresh"].map(id => candidate(id));
  const result = byID(classifyItems(input([deferred, rejected, fresh], { editorial: { version: 1, decisions: Object.fromEntries([
    decision(deferred, "defer", "Output kind does not match"), decision(rejected, "reject", "Unsafe medical advice")]) } })));
  assert.deepEqual([result.deferred.state, result.deferred.stage, result.deferred.since], ["excluded", "editorial", "2026-11-06T12:00:00Z"]);
  assert.deepEqual([result.rejected.state, result.rejected.reason], ["excluded", "Unsafe medical advice"]);
  assert.deepEqual([result.fresh.state, result.fresh.reason], ["waiting", "等待编辑审核"]);
});

test("preflight reasons about the content are final; defects nobody repairs are stalled", () => {
  const short = candidate("short", "Too short.");
  const long = candidate("long", "Plan a weekend with many careful details. ".repeat(1200));
  const large = { ...candidate("large", "Plan a weekend with many careful details. ".repeat(700)), title: "T".repeat(8000) };
  const result = byID(classifyItems(input([short, long, large])));
  assert.deepEqual([result.long.state, result.long.reason], ["excluded", "Prompt exceeds the publishable length"]);
  assert.deepEqual([result.short.state, result.short.reason], ["excluded", "Insufficient complete copyable instructions"]);
  assert.equal(result.large.state, "stalled");
  assert.match(result.large.reason, /manual review required/);
});

test("approved items continue through library rules, visual review and holds", () => {
  const items = ["ready", "uncertain", "mismatch", "held", "copy"].map(id => candidate(id));
  const live = candidate("original", items[4].prompt);
  const visual = (item: Candidate, verdict: string) => [`${item.id}-identity`, { id: item.id, verdict, reason: `Visual ${verdict}`, reviewedAt: "2026-11-05T00:00:00Z" }];
  const result = byID(classifyItems(input([...items, live], { live: new Set(["original"]),
    reviews: Object.fromEntries(items.map(item => [item.id, review(item)])),
    visual: { version: 1, decisions: Object.fromEntries([visual(items[1], "uncertain"), visual(items[2], "mismatch")]) } as never,
    qualityHolds: { schemaVersion: 1, holds: { held: { reason: "Preview mismatches captions" } } } as never })));
  assert.deepEqual([result.ready.state, result.ready.stage], ["waiting", "publication"]);
  assert.deepEqual([result.uncertain.state, result.uncertain.stage], ["excluded", "visual"]);
  assert.deepEqual([result.mismatch.state, result.mismatch.reason], ["excluded", "Visual mismatch"]);
  assert.deepEqual([result.held.state, result.held.stage], ["excluded", "quality"]);
  assert.deepEqual([result.copy.state, result.copy.reason], ["excluded", "与线上已有条目重复"]);
});

test("an unpublished X draft without a current source check is stalled", () => {
  const draft = { ...candidate("x-post-1"), source: { name: "X", url: "https://x.com/i/web/status/1", license: "X-API-Terms", method: "X API" } } as Candidate;
  const [status] = classifyItems(input([draft], { candidates: [{ source: "x-native", items: [draft] }] }));
  assert.deepEqual([status.state, status.stage], ["stalled", "source"]);
});

test("the funnel counts states by source and the items that stalled within the window", () => {
  const summary = summarizeFunnel([
    { id: "a", source: "x-native", kind: "image", state: "live", reason: "Online" },
    { id: "b", source: "x-native", kind: "image", state: "stalled", stage: "editorial", reason: "内容实际用于生成图像，与 expectedOutputKind 不一致", since: "2026-11-06T20:00:00Z" },
    { id: "c", source: "prompts-chat", kind: "text", state: "stalled", stage: "editorial", reason: "manual review required", since: "2026-10-01T00:00:00Z" },
    { id: "d", source: "prompts-chat", kind: "text", state: "waiting", stage: "editorial", reason: "等待编辑审核" },
  ], now);
  assert.deepEqual(summary.counts, { live: 1, removed: 0, excluded: 0, waiting: 1, stalled: 2 });
  assert.deepEqual(summary.bySource["prompts-chat"], { live: 0, removed: 0, excluded: 0, waiting: 1, stalled: 1 });
  assert.equal(summary.newlyStalled, 1);
  assert.deepEqual(summary.stalled.map(group => group.reason).sort(), ["原文超出审核输入上限，写着待人工，但没有人工环节", "编辑审核暂缓：内容类型对不上"].sort());
});
