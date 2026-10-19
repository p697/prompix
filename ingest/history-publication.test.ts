import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Catalog, Prompt } from "../packages/schema/catalog.ts";
import type { PublishedState } from "./release-publication.ts";
import { atomic } from "./publication.ts";
import { qualityHoldIdentity, readQualityHolds, assertNoQualityHolds } from "./quality-holds.ts";
import { publishQualifiedHistory, historyPublicationRun, type HistoryPublicationReport } from "./history-publication.ts";
import { translationFingerprint } from "./translation.ts";
const prompt = (id: string): Prompt => {
  const p: Prompt = { id, kind: "image", title: id, summary: "Synthetic illustration", prompt: `Draw ${id} on white paper.`, example: "Choose colors", tags: ["Art"], model: "Any", toolURL: null, artwork: "paper", previewLabel: "Preview", presentation: "general", source: { name: "Original", url: null, license: "CC0", method: "Synthetic test" }, media: { image: null, video: null, demoURL: null, imageURL: `https://api.prompix.dev/media/${Buffer.from(id).toString("hex").padEnd(64, "a")}.jpg` } };
  p.localization = { sourceLanguage: "en", sourceFingerprint: translationFingerprint(p), translations: { "zh-Hans": { title: "纸面插画", summary: "以纸张为背景的插画。", prompt: "在白纸上画画。", example: "选择配色", previewLabel: "预览" } } };
  return p;
};
const state = (prompts: Prompt[]) => ({ authoritative: { schemaVersion: 1, version: "test", publishedAt: new Date().toISOString(), prompts }, database: { release: "test", generation: "1" } }) as unknown as PublishedState;
const sources = async (_campaign: string, _run: string, items: readonly Prompt[]) => ({ candidates: [...items] as any[], persist: async () => {} });
const quota = (prompts: Prompt[], deferred = 0) => ({ prompts, report: { historicalSelected: 0, dailyCeiling: 100, windowAllowance: 25, alreadyPublished: 24, selected: prompts.length, deferred, visualSelected: prompts.length, plainSelected: 0, plainDailyCeiling: 10, plainAlreadyPublished: 0, minimumVisualShare: 0.8 } });
async function fixture() {
  const shared = await mkdtemp(join(tmpdir(), "prompix-history-public-")), campaign = await mkdtemp(join(tmpdir(), "prompix-history-private-"));
  await atomic(join(campaign, "quality-holds.json"), { schemaVersion: 1, holds: {} });
  return { shared, campaign, report: { startedAt: new Date().toISOString(), published: false } as HistoryPublicationReport,
    cleanup: async () => { await rm(shared, { recursive: true, force: true }); await rm(campaign, { recursive: true, force: true }); } };
}

test("history publication deduplicates live production, honors removals and owner holds, and keeps original plus Chinese", async () => {
  const f = await fixture();
  try {
    const prior = prompt("prior"), fresh = prompt("fresh"), held = prompt("held"), removed = prompt("removed");
    const ready = [prior, { ...prior, id: "duplicate" }, fresh, held, removed];
    const originalBytes = JSON.stringify(ready);
    await atomic(join(f.shared, "moderation.json"), { removedIDs: [removed.id] });
    await atomic(join(f.campaign, "quality-holds.json"), { schemaVersion: 1, holds: { [held.id]: { sourceIdentitySHA256: qualityHoldIdentity(held), reason: "Synthetic defect", evidenceSHA256: "b".repeat(64), reviewerID: "test", reviewedAt: new Date().toISOString() } } });
    let published: Catalog | undefined;
    await publishQualifiedHistory(f.shared, f.campaign, "test", f.report, {
      sources, begin: async () => ({ enabled: true, previous: state([prior]) }), ready: async () => ready,
      limit: async items => { assert.deepEqual(items, [fresh]); return quota(items); },
      mirror: async items => items,
      publish: async (_, catalog) => { published = catalog; return state(catalog.prompts); },
    });
    assert.deepEqual(published!.prompts, [prior, fresh]);
    assert.deepEqual(published!.removedIDs, [removed.id]);
    assert.equal(f.report.selected, 1); assert.equal(f.report.publishedTotal, 2);
    assert.equal(JSON.stringify(ready), originalBytes);
    assert.deepEqual(Object.keys(published!.prompts[1].localization!.translations), ["zh-Hans"]);
  } finally { await f.cleanup(); }
});

test("quota deferral makes no uploads or model work; the next invocation drains a slot exactly once", async () => {
  const f = await fixture();
  try {
    const first = prompt("first"), second = prompt("second"), third = prompt("third");
    let current = [first], slots = 0, uploads = 0;
    const io = {
      sources, begin: async () => ({ enabled: true, previous: state(current) }), ready: async () => [second, third],
      limit: async (items: Prompt[]) => quota(items.slice(0, slots), items.length - Math.min(slots, items.length)),
      mirror: async (items: Prompt[]) => { uploads++; return items; },
      publish: async (_: string, catalog: Catalog) => { current = catalog.prompts; return state(current); },
    };
    await publishQualifiedHistory(f.shared, f.campaign, "test", f.report, io);
    assert.equal(f.report.status, "deferred"); assert.equal(uploads, 0);
    slots = 1;
    await publishQualifiedHistory(f.shared, f.campaign, "test", f.report, io);
    assert.deepEqual(current.map(p => p.id), ["first", "second"]);
    await publishQualifiedHistory(f.shared, f.campaign, "test", f.report, io);
    assert.deepEqual(current.map(p => p.id), ["first", "second", "third"]);
    await publishQualifiedHistory(f.shared, f.campaign, "test", f.report, io);
    assert.equal(uploads, 2); assert.equal(f.report.status, "deferred");
  } finally { await f.cleanup(); }
});

test("retained publication recovery and holds stop before reading the candidate queue", async () => {
  const f = await fixture();
  try {
    const forbidden = async (): Promise<never> => { throw new Error("Must not run new work"); };
    const io = { ready: forbidden, limit: forbidden, mirror: forbidden, publish: forbidden };
    await publishQualifiedHistory(f.shared, f.campaign, "test", f.report, { ...io, sources, begin: async () => ({ enabled: true, recovered: state([prompt("saved")]) }) });
    assert.equal(f.report.status, "recovered");
    await publishQualifiedHistory(f.shared, f.campaign, "test", f.report, { ...io, sources, begin: async () => ({ enabled: true, held: { reason: "operator" } }) });
    assert.equal(f.report.status, "held");
  } finally { await f.cleanup(); }
});

test("new campaign owner hold during upload blocks publication through the registered shared guard", async () => {
  const f = await fixture();
  try {
    const fresh = prompt("fresh");
    await assert.rejects(publishQualifiedHistory(f.shared, f.campaign, "test", f.report, {
      sources, begin: async () => ({ enabled: true, previous: state([]) }), ready: async () => [fresh], limit: async items => quota(items),
      mirror: async items => {
        await atomic(join(f.campaign, "quality-holds.json"), { schemaVersion: 1, holds: { [fresh.id]: { sourceIdentitySHA256: qualityHoldIdentity(fresh), reason: "Late defect", evidenceSHA256: "c".repeat(64), reviewerID: "test", reviewedAt: new Date().toISOString() } } });
        return items;
      },
      publish: async (root, catalog) => { assertNoQualityHolds(catalog, await readQualityHolds(root)); throw new Error("Should be blocked"); },
    }), /quality hold/);
    assert.equal(f.report.published, false);
    assert.ok(await readFile(join(f.shared, "quality-hold-scopes.json")));
  } finally { await f.cleanup(); }
});

test("publication configuration rejects a foreign shared root before any external request", async () => {
  const f = await fixture();
  try {
    await atomic(join(f.campaign, "configuration.json"), { run: "test", sharedRoot: f.shared, extraCampaignSetting: true });
    assert.equal(await historyPublicationRun(f.shared, f.campaign), "test");
    await assert.rejects(historyPublicationRun("/different", f.campaign), /roots differ/);
    await assert.rejects(historyPublicationRun(f.shared, "relative"), /absolute/);
  } finally { await f.cleanup(); }
});
