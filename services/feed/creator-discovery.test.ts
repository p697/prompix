import assert from "node:assert/strict";
import { test } from "node:test";
import type { Prompt } from "../../packages/schema/catalog.ts";
import { createTestDatabase } from "./test-database.ts";
import { activatePublication, stagePublication, removeContent } from "./publication.ts";
import { getCreatorDiscovery } from "./creator-discovery.ts";
import { parseCreatorDiscovery, type CreatorFilters } from "./creator-filters.ts";
import { getState } from "./queries.ts";
import { serveFeed } from "./http.ts";
const secret = "creator-discovery-test-only-secret-000000000000000";
const now = Date.parse("2026-10-15T23:59:00Z");
function item(author: number, index: number, kind: Prompt["kind"]): Prompt {
  return { id: `work-${author}-${index}`, kind, title: `Work ${index}`, summary: "First-party fixture", prompt: "Original test body",
    example: "Example", tags: ["test"], model: "Synthetic", artwork: "test", previewLabel: "Preview", toolURL: null,
    source: { name: "Prompix", url: null, license: "CC0", method: "test" },
    media: kind === "text" ? null : { image: null, video: null, demoURL: null, imageURL: "https://api.prompix.dev/media/test.jpg" },
    creator: { id: `creator-${author}`, platform: "web", displayName: `Author ${String(author).padStart(2, "0")}`, profileURL: `https://example.com/${author}` } };
}

test("creator query validates all filters, bounds, normalization and ambiguous input", () => {
  for (const query of ["sort=bad", "sort=count&sort=name", "sort=count&kind=bad", "sort=count&limit=51", "sort=count&limit=0",
    "sort=count&cursor=", "sort=count&q=a%00b", "sort=count&q=" + "ﬃ".repeat(100), "sort=count&locale=en", "sort=count&day=tomorrow"])
    assert.throws(() => parseCreatorDiscovery(new URL(`https://example.com/v3/creators?${query}`)), query);
  assert.equal(parseCreatorDiscovery(new URL("https://example.com/v3/creators?sort=name&q=ＡＢＣ%20DE")).filters.q, "abc de");
});

test("visual discovery rotates daily and keeps every sort/filter globally paginated and snapshot-bound", async t => {
  const { pg, writer, reader } = await createTestDatabase(); t.after(() => pg.close());
  const prompts = [...Array.from({ length: 90 }, (_, i) => item(0, i, "text")),
    ...Array.from({ length: 45 }, (_, i) => item(i + 1, 0, (["image", "video", "web"] as const)[i % 3]))];
  const release = await stagePublication(writer, { schemaVersion: 1, version: "creator-fixture", prompts });
  await activatePublication(writer, release, "0");
  const recommended: CreatorFilters = { q: "", sort: "recommended" };
  const first = await getCreatorDiscovery(reader, { filters: recommended, limit: 5 }, secret, now);
  assert.ok(first.items.every(value => value.creator.id !== "creator-0"));
  assert.ok(first.items.every(value => ["image", "video", "web"].includes(value.preview!.kind)));
  assert.ok(first.items.every(value => value.preview?.creator?.id === value.creator.id && !("prompt" in value.preview!)));
  assert.deepEqual(await getCreatorDiscovery(reader, { filters: recommended, limit: 5 }, secret, now), first);
  const tomorrow = await getCreatorDiscovery(reader, { filters: recommended, limit: 5 }, secret, now + 86400000);
  assert.notDeepEqual(tomorrow.items.map(value => value.creator.id), first.items.map(value => value.creator.id));
  for (const sort of ["recommended", "latest", "count", "name"] as const) {
    for (const kind of [undefined, "image", "video", "web", "text", "skill"] as const) {
      const filters: CreatorFilters = { q: "", sort, ...(kind ? { kind } : {}) };
      let page = await getCreatorDiscovery(reader, { filters, limit: 7 }, secret, now);
      const values = [...page.items];
      while (page.nextCursor) {
        page = await getCreatorDiscovery(reader, { filters, limit: 7, cursor: page.nextCursor }, secret, now + 120000);
        values.push(...page.items);
      }
      assert.equal(values.length, kind === "skill" ? 0 : kind === "text" ? 1 : kind ? 15 : 46);
      assert.equal(new Set(values.map(value => value.creator.id)).size, values.length);
      if (kind) assert.ok(values.every(value => value.preview?.kind === kind));
      if (sort === "count" && !kind) assert.equal(values[0].creator.id, "creator-0");
      if (sort === "name") assert.deepEqual(values.map(value => value.creator.displayName), values.map(value => value.creator.displayName).sort());
    }
  }
  for (const changed of [{ ...recommended, kind: "image" as const }, { ...recommended, sort: "name" as const }, { ...recommended, q: "author" }])
    await assert.rejects(() => getCreatorDiscovery(reader, { filters: changed, limit: 5, cursor: first.nextCursor! }, secret, now), /invalid_request/);
  await assert.rejects(() => getCreatorDiscovery(reader, { filters: recommended, limit: 5, cursor: first.nextCursor! + "x" }, secret, now), /invalid_request/);
  await assert.rejects(() => getCreatorDiscovery(reader, { filters: recommended, limit: 5, cursor: first.nextCursor! }, secret, now + 86400000), /invalid_request/);
  const expected = await getCreatorDiscovery(reader, { filters: recommended, limit: 50 }, secret, now);
  // Remove one prior-page creator and a not-yet-seen creator. Neither shifts the remaining positions.
  const removed = [first.items[0].preview!.id, expected.items[8].preview!.id];
  await removeContent(writer, removed, "Synthetic takedown");
  const nextRelease = await stagePublication(writer, { schemaVersion: 1, version: "creator-new", prompts: [...prompts.filter(p => !removed.includes(p.id)), item(90, 0, "image")] });
  await activatePublication(writer, nextRelease, (await getState(reader)).generation);
  let page = await getCreatorDiscovery(reader, { filters: recommended, limit: 50, cursor: first.nextCursor! }, secret, now + 120000);
  assert.equal(page.release, release);
  assert.deepEqual(page.items.map(value => value.creator.id), expected.items.slice(5).filter(value => !removed.includes(value.preview!.id)).map(value => value.creator.id));
  assert.equal((await getCreatorDiscovery(reader, { filters: { q: "%", sort: "name" }, limit: 10 }, secret, now)).items.length, 0);
  assert.equal((await serveFeed(new Request("https://example.com/v3/creators?sort=recommended&kind=image"), reader, secret)).status, 200);
  assert.equal((await serveFeed(new Request("https://example.com/v3/creators?sort=name&sort=count"), reader, secret)).status, 400);
  assert.equal((await serveFeed(new Request("https://example.com/v3/creators?limit=2"), reader, secret)).status, 200, "Legacy client compatibility");
});
