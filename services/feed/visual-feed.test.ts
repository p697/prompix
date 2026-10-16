import { test } from "node:test";
import assert from "node:assert/strict";
import type { Prompt } from "../../packages/schema/catalog.ts";
import { parseFeedQuery, type FeedFilters } from "../../packages/schema/feed.ts";
import { hasVisualPreview } from "../../packages/schema/visual.ts";
import { createTestDatabase } from "./test-database.ts";
import { activatePublication, removeContent, stagePublication } from "./publication.ts";
import { getFeed } from "./queries.ts";
import { limitNewPublications } from "../../ingest/publication-quota.ts";

const secret = "visual-feed-fixture-secret-0000000000000000000000";
const filters: FeedFilters = { locale: "original", q: "", sort: "discovery" };
function item(id: string, visual = false): Prompt {
  return { id, kind: visual ? "image" : "text", title: id, summary: "Original visual feed fixture", prompt: "Create an original ceramic still life.",
    example: "A ceramic cup", tags: ["肖像"], model: "Fixture", toolURL: null, artwork: "test", previewLabel: "Preview",
    source: { name: "Prompix", url: null, license: "Original", method: "Test fixture" },
    media: visual ? { image: "lake", video: null, demoURL: null } : null };
}
const input = (prompts: Prompt[]) => ({ schemaVersion: 1 as const, version: "fixture", prompts });

test("visual feed crosses arbitrary page boundaries at 4:1, preserves both lanes, and drains the remaining lane", async t => {
  const { pg, writer, reader } = await createTestDatabase(); t.after(() => pg.close());
  const items = [...Array.from({ length: 110 }, (_, n) => item(`text-${n}`)), ...Array.from({ length: 190 }, (_, n) => item(`image-${n}`, true))];
  const release = await stagePublication(writer, input(items)); await activatePublication(writer, release, "0");
  const all: string[] = [];
  let cursor: string | undefined, iteration = 0;
  do {
    const page = await getFeed(reader, { filters, limit: [7, 1, 50, 13][iteration++ % 4], cursor }, secret);
    all.push(...page.items.map(i => i.id)); cursor = page.nextCursor ?? undefined;
    assert.equal(page.release, release);
    assert.ok(page.items.every(card => !("prompt" in card) && !("skill" in card)));
  } while (cursor);
  assert.equal(all.length, items.length); assert.equal(new Set(all).size, items.length);
  for (let n = 0; n < 47; n++) {
    assert.ok(all.slice(n * 5, n * 5 + 4).every(id => id.startsWith("image-")));
    assert.ok(all[n * 5 + 4].startsWith("text-"));
  }
  assert.deepEqual(all.filter(id => id.startsWith("image-")), items.filter(hasVisualPreview).map(i => i.id));
  assert.deepEqual(all.filter(id => id.startsWith("text-")), items.filter(i => !hasVisualPreview(i)).map(i => i.id));
  assert.equal((await getFeed(reader, { filters: { ...filters, sort: "latest" }, limit: 1 }, secret)).items[0].id, "text-0");
  assert.ok((await getFeed(reader, { filters: { ...filters, kind: "image" }, limit: 50 }, secret)).items.every(i => i.kind === "image"));
  assert.ok((await getFeed(reader, { filters: { ...filters, kind: "text" }, limit: 50 }, secret)).items.every(i => i.kind === "text"));
  assert.equal((await getFeed(reader, { filters: { ...filters, model: "missing" }, limit: 50 }, secret)).items.length, 0);
});

test("visual cursors bind query and snapshot, and removals never renumber either lane", async t => {
  const { pg, writer, reader } = await createTestDatabase(); t.after(() => pg.close());
  const items = [...Array.from({ length: 12 }, (_, n) => item(`text-${n}`)), ...Array.from({ length: 30 }, (_, n) => item(`image-${n}`, true))];
  const first = await stagePublication(writer, input(items)); await activatePublication(writer, first, "0");
  const page = await getFeed(reader, { filters, limit: 7 }, secret);
  const cursor = page.nextCursor!;
  for (const other of [{ ...filters, sort: "latest" as const }, { ...filters, locale: "en" as const }, { ...filters, kind: "text" as const }])
    await assert.rejects(getFeed(reader, { filters: other, limit: 7, cursor }, secret), /invalid_request/);
  await assert.rejects(getFeed(reader, { filters, limit: 7, cursor: cursor.slice(0, -1) + (cursor.endsWith("a") ? "b" : "a") }, secret), /invalid_request/);
  await assert.rejects(getFeed(reader, { filters, limit: 7, cursor }, secret, Date.now() + 25 * 3600000), /invalid_request/);
  const next = await stagePublication(writer, input([item("new-visual", true), ...items])); await activatePublication(writer, next, "1");
  await removeContent(writer, ["image-0", "image-10", "text-5"], "Fixture removal");
  const rest: string[] = []; let token: string | undefined = cursor;
  do {
    const result = await getFeed(reader, { filters, limit: 3, cursor: token }, secret);
    assert.equal(result.release, first); rest.push(...result.items.map(i => i.id)); token = result.nextCursor ?? undefined;
  } while (token);
  const combined = [...page.items.map(i => i.id), ...rest];
  assert.equal(new Set(combined).size, combined.length);
  assert.equal(combined.length, items.length - 2); // image-0 was already seen before removal
  assert.ok(!rest.includes("image-10") && !rest.includes("text-5") && !rest.includes("new-visual"));
  assert.equal((await getFeed(reader, { filters, limit: 1 }, secret)).items[0].id, "new-visual");
  await pg.query("update prompix.releases set published_at=null where id=$1", [first]);
  await assert.rejects(getFeed(reader, { filters, limit: 3, cursor }, secret), /snapshot_expired/);
});

test("only real previews enter the visual lane, and search cannot silently lose ranking", async t => {
  const { pg, writer, reader } = await createTestDatabase(); t.after(() => pg.close());
  const text = { ...item("creative-label"), title: "Image video website creative workflow" };
  const noPreview = { ...item("no-poster"), kind: "video" as const };
  const withPreview = { ...item("real-preview", true), kind: "text" as const };
  const release = await stagePublication(writer, input([text, noPreview, withPreview])); await activatePublication(writer, release, "0");
  assert.deepEqual((await getFeed(reader, { filters, limit: 5 }, secret)).items.map(i => i.id), [withPreview.id, text.id, noPreview.id]);
  assert.throws(() => parseFeedQuery(new URL("https://example.com/v3/feed?sort=discovery&q=creative")));
  await assert.rejects(getFeed(reader, { filters: { ...filters, q: "creative" }, limit: 5 }, secret), /invalid_request/);
});

test("publication selects visual quality before text backlog and keeps prior work across retries, edits and rollback", async t => {
  const { pg, writer } = await createTestDatabase(); t.after(() => pg.close());
  const baseline = await stagePublication(writer, input([item("old")])); await activatePublication(writer, baseline, "0");
  const incoming = [...Array.from({ length: 80 }, (_, n) => item(`plain-${n}`)), ...Array.from({ length: 40 }, (_, n) => item(`visual-${n}`, true))];
  const late = new Date(); late.setUTCHours(23, 0, 0, 0);
  const result = await limitNewPublications(writer, [item("old"), ...incoming], late);
  assert.equal(result.report.visualSelected, 40); assert.equal(result.report.plainSelected, 10);
  assert.equal(result.prompts.length, 51); assert.equal(result.report.deferred, 70);
  const published = await stagePublication(writer, input(result.prompts)); await activatePublication(writer, published, "1");
  const retry = await limitNewPublications(writer, [...result.prompts, item("extra-plain"), item("extra-image", true)], late);
  assert.ok(!retry.prompts.some(i => i.id === "extra-plain")); assert.ok(retry.prompts.some(i => i.id === "extra-image"));
  assert.equal(retry.report.plainAlreadyPublished, 10);
  await activatePublication(writer, baseline, "2");
  const rolledBack = await limitNewPublications(writer, [item("plain-0"), item("extra-plain")], late);
  assert.deepEqual(rolledBack.prompts.map(i => i.id), ["plain-0"]);
  const dry = await limitNewPublications(writer, Array.from({ length: 30 }, (_, n) => item(`next-${n}`)), new Date("2099-01-01T18:00:00Z"));
  assert.equal(dry.prompts.length, 0);
  const small = await limitNewPublications(writer, [item("only-image", true), item("text-without-four-images")], new Date("2099-01-01T18:00:00Z"));
  assert.deepEqual(small.prompts.map(i => i.id), ["only-image"]);
});
