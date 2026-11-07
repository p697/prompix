import { test } from "node:test";
import assert from "node:assert/strict";
import type { Prompt } from "../../packages/schema/catalog.ts";
import { createTestDatabase } from "./test-database.ts";
import { stagePublication, activatePublication, removeContent } from "./publication.ts";
import { getFeed, getState } from "./queries.ts";
import { limitNewPublications } from "../../ingest/publication-quota.ts";
import { runVisualReview, visualReviewVersion } from "../../ingest/visual-review.ts";
const secret = "freshness-test-secret-0000000000000000000000000000";
const prompt = (id: string): Prompt => ({ id, kind: "text", title: id, summary: "First-party fixture", prompt: "Write an original short story.", example: "A garden.",
  tags: ["fixture"], model: "test", toolURL: null, artwork: "test", previewLabel: "Preview", source: { name: "Prompix", url: null, license: "Original", method: "Test fixture" }, media: null, presentation: "general" });
const input = (prompts: Prompt[]) => ({ schemaVersion: 1 as const, version: "fixture", prompts });
test("unusable media and a ready text backlog cannot bypass the visual-publication policy", async t => {
  const { pg, writer } = await createTestDatabase(); t.after(() => pg.close());
  const held = Array.from({ length: 30 }, (_, i) => ({ ...prompt(`held-${i}`), kind: "web" as const }));
  const ready = Array.from({ length: 30 }, (_, i) => prompt(`ready-${i}`));
  const visual = await runVisualReview({ prompts: [...held, ...ready], previous: [], day: "2026-10-15",
    cache: { version: visualReviewVersion, decisions: {} },
    prepareMedia: async () => { throw new Error("Unavailable preview"); }, persistCache: async () => {}, persistLedger: async () => {} });
  const result = await limitNewPublications(writer, visual.prompts, new Date("2026-10-15T00:00:00Z"));
  assert.equal(visual.withheldIDs.length, 30);
  assert.deepEqual(result.prompts, []);
  assert.equal(result.report.deferred, 30);
});
test("latest feed sorts by first successful publication, not staging or edits, and pins cursors across releases", async t => {
  const { pg, writer, reader } = await createTestDatabase(); t.after(() => pg.close());
  const old = [prompt("old-a"), prompt("old-b"), prompt("old-c")];
  const first = await stagePublication(writer, input(old));
  assert.equal((await writer.query("select first_published_at from prompix.content where id='old-a'")).rows[0].first_published_at, null);
  await activatePublication(writer, first, "0");
  await pg.exec("update prompix.content set first_published_at=now()-interval '2 days'");
  const second = await stagePublication(writer, input([{ ...old[0], title: "An edited title" }, ...old.slice(1), prompt("new-a"), prompt("new-b")]));
  await activatePublication(writer, second, "1");
  const filters = { locale: "original" as const, q: "", sort: "latest" as const };
  const page = await getFeed(reader, { filters, limit: 1 }, secret);
  assert.equal(page.items[0].id, "new-a");
  const third = await stagePublication(writer, input([...old, prompt("new-a"), prompt("new-b"), prompt("new-c")]));
  await activatePublication(writer, third, "2");
  const next = await getFeed(reader, { filters, limit: 10, cursor: page.nextCursor! }, secret);
  assert.deepEqual(next.items.map(i => i.id), ["new-b", "old-a", "old-b", "old-c"]);
  assert.equal((await getFeed(reader, { filters, limit: 10 }, secret)).items[0].id, "new-c");
  await assert.rejects(getFeed(reader, { filters: { ...filters, sort: "curated" }, limit: 10, cursor: page.nextCursor! }, secret), /invalid_request/);
  await removeContent(writer, ["new-b"], "Fixture removal");
  await activatePublication(writer, second, (await getState(reader)).generation);
  assert.deepEqual((await getFeed(reader, { filters, limit: 10 }, secret)).items.map(i => i.id), ["new-a", "old-a", "old-b", "old-c"]);
});
test("activation no longer caps a day's new publications, and text still waits for four visual works", async t => {
  const { pg, writer, reader } = await createTestDatabase(); t.after(() => pg.close());
  const baseline = await stagePublication(writer, input([prompt("baseline")])); await activatePublication(writer, baseline, "0");
  const visual = (id: string) => ({ ...prompt(id), kind: "image" as const, media: { image: "lake", video: null, demoURL: null } });
  const items = Array.from({ length: 120 }, (_, i) => visual(`new-${i}`));
  const release = await stagePublication(writer, input(items)); await activatePublication(writer, release, "1");
  assert.equal((await getState(reader)).release, release);
  const quota = await limitNewPublications(writer, [items[0], ...Array.from({ length: 40 }, (_, i) => prompt(`text-${i}`))]);
  assert.equal(quota.report.plainSelected, 30, "120 visual works today allow 30 texts");
  assert.ok(quota.prompts.some(i => i.id === items[0].id));
});
test("every reviewed visual work is selected at any hour and staged drafts never count as published", async t => {
  const { pg, writer } = await createTestDatabase(); t.after(() => pg.close());
  const items = Array.from({ length: 110 }, (_, i) => ({ ...prompt(`draft-${i}`), kind: "image" as const, media: { image: "lake", video: null, demoURL: null } }));
  await stagePublication(writer, input(items));
  const early = await limitNewPublications(writer, items, new Date("2026-10-15T00:00:00Z"));
  assert.equal(early.prompts.length, 110); assert.equal(early.report.deferred, 0); assert.equal(early.report.alreadyPublished, 0);
});

test("backup restoration preserves first-publication order and quota history including inactive identities", async t => {
  const { exportPublicationHistory, restorePublicationHistory } = await import("./publication-history.ts");
  const first = await createTestDatabase(), restored = await createTestDatabase();
  t.after(async () => { await first.pg.close(); await restored.pg.close(); });
  const a = await stagePublication(first.writer, input([prompt("old")])); await activatePublication(first.writer, a, "0");
  await first.pg.exec("update prompix.content set first_published_at=now()-interval '2 days'");
  const b = await stagePublication(first.writer, input([prompt("old"), prompt("fresh")])); await activatePublication(first.writer, b, "1");
  const c = await stagePublication(first.writer, input([prompt("fresh")])); await activatePublication(first.writer, c, "2");
  const history = await exportPublicationHistory(first.writer);
  const target = await stagePublication(restored.writer, input([prompt("fresh")]));
  await restorePublicationHistory(restored.writer, history); await activatePublication(restored.writer, target, "0");
  assert.deepEqual(await exportPublicationHistory(restored.writer), history);
  await assert.rejects(restorePublicationHistory(restored.writer, history), /uninitialized/);
  assert.equal((await limitNewPublications(restored.writer, [prompt("fresh"), prompt("old")])).report.selected, 0);
});

test("frozen historical authorization publishes without counting toward the day's text ratio", async t => {
  const { pg, writer, reader } = await createTestDatabase(); t.after(() => pg.close());
  const initial = await stagePublication(writer, input([prompt("baseline")])); await activatePublication(writer, initial, "0");
  const ordinary = Array.from({ length: 100 }, (_, i) => prompt(`ordinary-${i}`));
  const daily = await stagePublication(writer, input(ordinary)); await activatePublication(writer, daily, "1");
  const history = Array.from({ length: 130 }, (_, i) => prompt(`x-post-${1000 + i}`));
  const authorization = { version: 1 as const, id: "owner-approved-history", approvedAt: new Date(Date.now()-1000).toISOString(),
    expiresAt: new Date(Date.now()+3600_000).toISOString(), contentIDs: history.map(p => p.id) };
  const target = await stagePublication(writer, input([...ordinary, ...history]));
  await assert.rejects(activatePublication(writer, target, "2", { ...authorization, expiresAt: new Date(Date.now()-500).toISOString() }), /expired/);
  await activatePublication(writer, target, "2", authorization);
  assert.equal((await getState(reader)).count, 230);
  assert.equal((await writer.query("select count(*)::int as count from prompix.content where counts_toward_daily_limit")).rows[0].count, 100);
  const selection = await limitNewPublications(writer, [prompt("x-post-999999"), history[0]], new Date(), authorization);
  assert.deepEqual(selection.prompts.map(p => p.id), [history[0].id]);
  await activatePublication(writer, daily, "3");
  await activatePublication(writer, target, "4", authorization);
  assert.equal((await writer.query("select count(*)::int as count from prompix.content where counts_toward_daily_limit")).rows[0].count, 100);
});
