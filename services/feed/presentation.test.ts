import assert from "node:assert/strict";
import { test } from "node:test";
import type { Prompt } from "../../packages/schema/catalog.ts";
import { parseFeedQuery, type FeedFilters } from "../../packages/schema/feed.ts";
import { createTestDatabase } from "./test-database.ts";
import { activatePublication, stagePublication } from "./publication.ts";
import { getBrowse, getCreators, getDetail, getFeed } from "./queries.ts";
import { getCreatorDiscovery } from "./creator-discovery.ts";
import { parseCreatorDiscovery } from "./creator-filters.ts";
import { serveFeed } from "./http.ts";

const secret = "presentation-test-only-secret-0000000000000000000000";
const now = Date.parse("2026-11-06T12:00:00Z");
const labels = ["general", "suggestive", "unknown", undefined] as const;
function item(index: number): Prompt {
  const presentation = labels[index % 4];
  return { id: `work-${index}`, kind: "image", title: `Portrait ${index}`, summary: "First-party fixture", prompt: "Original test body",
    example: "Example", tags: ["portrait"], model: "Synthetic", artwork: "test", previewLabel: "Preview", toolURL: null,
    source: { name: "Prompix", url: null, license: "CC0", method: "test" },
    media: { image: null, video: null, demoURL: null, imageURL: "https://api.prompix.dev/media/test.jpg" },
    // Creator 0 publishes only suggestive work, so they disappear from default directories.
    creator: { id: `creator-${presentation === "suggestive" ? 0 : 1 + index % 3}`, platform: "web", displayName: `Author ${index}`, profileURL: "https://example.com/a" },
    ...(presentation ? { presentation } : {}) };
}

test("lists hide suggestive and unreviewed imagery unless the viewer opts in, and detail stays reachable", async t => {
  const { pg, writer, reader } = await createTestDatabase(); t.after(() => pg.close());
  const release = await stagePublication(writer, { schemaVersion: 1, version: "presentation", prompts: Array.from({ length: 40 }, (_, i) => item(i)) });
  await activatePublication(writer, release, "0");
  const presentations = async (filters: FeedFilters) => {
    const seen = new Set<string | undefined>();
    let page = await getFeed(reader, { filters, limit: 7 }, secret, now), pages = 1;
    page.items.forEach(card => seen.add(card.presentation));
    while (page.nextCursor) {
      page = await getFeed(reader, { filters, limit: 7, cursor: page.nextCursor }, secret, now); pages++;
      page.items.forEach(card => seen.add(card.presentation));
    }
    return { seen: [...seen].sort(), pages };
  };
  const base: FeedFilters = { locale: "original", q: "" };
  for (const sort of [undefined, "latest", "discovery", "recommended"] as const) {
    const filters: FeedFilters = { ...base, ...(sort ? { sort } : {}), ...(sort === "recommended" ? { seed: "a".repeat(32) } : {}) };
    assert.deepEqual((await presentations(filters)).seen, ["general"], sort);
    assert.deepEqual((await presentations({ ...filters, presentation: "suggestive" })).seen, ["general", "suggestive"], sort);
  }
  assert.deepEqual((await presentations({ ...base, q: "portrait" })).seen, ["general"]);

  const browse = await getBrowse(reader, "original"), opted = await getBrowse(reader, "original", "suggestive");
  assert.deepEqual(browse.models, [{ name: "Synthetic", count: 10 }]);
  assert.deepEqual(opted.models, [{ name: "Synthetic", count: 20 }]);
  assert.ok(browse.collections.flatMap(collection => collection.covers).every(card => card.presentation === "general"));

  const directory = await getCreators(reader, { q: "", limit: 10 }, secret, now);
  assert.ok(directory.items.every(entry => entry.creator.id !== "creator-0"));
  assert.equal(directory.items.reduce((sum, entry) => sum + entry.count, 0), 10);
  const optedDirectory = await getCreators(reader, { q: "", limit: 10, presentation: "suggestive" }, secret, now);
  assert.equal(optedDirectory.items.find(entry => entry.creator.id === "creator-0")?.count, 10);
  const discovery = await getCreatorDiscovery(reader, { filters: { q: "", sort: "count" }, limit: 10 }, secret, now);
  assert.ok(discovery.items.every(entry => entry.creator.id !== "creator-0" && entry.preview?.presentation === "general"));
  const optedDiscovery = await getCreatorDiscovery(reader, { filters: { q: "", sort: "count", presentation: "suggestive" }, limit: 10 }, secret, now);
  assert.ok(optedDiscovery.items.some(entry => entry.creator.id === "creator-0"));

  // Saved items and shared links open whatever their label.
  for (const index of [1, 2, 3]) assert.equal((await getDetail(reader, `work-${index}`, "original")).item.id, `work-${index}`);

  const first = await getFeed(reader, { filters: { ...base, sort: "latest" }, limit: 3 }, secret, now);
  await assert.rejects(getFeed(reader, { filters: { ...base, sort: "latest", presentation: "suggestive" }, limit: 3, cursor: first.nextCursor! }, secret, now),
    { message: "invalid_request" });
  const response = await serveFeed(new Request("https://api.prompix.dev/v3/browse?presentation=suggestive&locale=original"), reader, secret);
  assert.equal(response.status, 200);
  assert.equal((await serveFeed(new Request("https://api.prompix.dev/v3/creators?presentation=suggestive"), reader, secret)).status, 200);
});

test("only general or suggestive can be requested", async () => {
  for (const value of ["unknown", "explicit", "", "GENERAL"]) {
    assert.throws(() => parseFeedQuery(new URL(`https://example.com/v3/feed?presentation=${value}`)), value);
    assert.throws(() => parseCreatorDiscovery(new URL(`https://example.com/v3/creators?sort=count&presentation=${value}`)), value);
  }
  assert.throws(() => parseFeedQuery(new URL("https://example.com/v3/feed?presentation=general&presentation=suggestive")));
  assert.equal(parseFeedQuery(new URL("https://example.com/v3/feed?presentation=suggestive")).filters.presentation, "suggestive");
  const { pg, reader } = await createTestDatabase();
  try {
    for (const query of ["presentation=unknown", "presentation=general&presentation=general", "presentation=explicit&locale=original"])
      assert.equal((await serveFeed(new Request(`https://api.prompix.dev/v3/browse?${query}`), reader, secret)).status, 400, query);
  } finally { await pg.close(); }
});
