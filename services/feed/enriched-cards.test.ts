import assert from "node:assert/strict";
import { test } from "node:test";
import type { Prompt } from "../../packages/schema/catalog.ts";
import { parseFeedQuery, type FeedFilters } from "../../packages/schema/feed.ts";
import { translationFingerprint } from "../../ingest/translation.ts";
import { createTestDatabase } from "./test-database.ts";
import { activatePublication, stagePublication } from "./publication.ts";
import { getBrowse, getFeed } from "./queries.ts";
import { getCreatorDiscovery } from "./creator-discovery.ts";

const secret = "enriched-cards-test-only-secret-00000000000000000000";
function item(index: number, enriched: boolean): Prompt {
  const video = index % 2 === 1;
  const base: Prompt = { id: `work-${index}`, kind: video ? "video" : "image", title: `作品 ${index}`, summary: "中文摘要", prompt: "Original test body",
    example: "Example", tags: ["test"], model: "Synthetic", artwork: "test", previewLabel: "Preview", toolURL: null,
    source: { name: "Prompix", url: null, license: "CC0", method: "test" }, presentation: "general",
    media: { image: null, video: null, demoURL: null, imageURL: "https://api.prompix.dev/media/test.jpg" },
    creator: { id: `creator-${index % 3}`, platform: "web", displayName: `Author ${index}`, profileURL: "https://example.com/a" } };
  if (!enriched) return base;
  const enrichedItem: Prompt = { ...base,
    generation: video ? { modelFamily: "veo", mode: "i2v", hasAudio: true } : { modelFamily: "gpt-image", mode: "t2i", outputAspect: "3:4" },
    inputs: video ? { requirement: "required", count: 1, kinds: ["face"], ownLikenessOnly: true } : { requirement: "none", kinds: [] },
    facets: { useCase: [video ? "fashion" : "portraits"], style: ["cinematic"], subject: ["person"] },
    palette: [{ hex: "#C2410C", weight: 0.5 }, { hex: "#F5F5F4", weight: 0.3 }, { hex: "#1C1917", weight: 0.2 }],
    rights: { license: "CC0-1.0", basis: "license", imageExport: true } };
  return { ...enrichedItem, localization: { sourceLanguage: "zh-Hans", sourceFingerprint: translationFingerprint(enrichedItem), translations: {},
    en: { title: `Work ${index}`, summary: "English summary" } } };
}

test("cards carry the 2.0 fields, English card text and the new filters", async t => {
  const { pg, writer, reader } = await createTestDatabase(); t.after(() => pg.close());
  const prompts = [...Array.from({ length: 12 }, (_, i) => item(i, true)), ...Array.from({ length: 4 }, (_, i) => item(100 + i, false))];
  const release = await stagePublication(writer, { schemaVersion: 1, version: "enriched", prompts });
  await activatePublication(writer, release, "0");
  const base: FeedFilters = { locale: "original", q: "", sort: "latest" };
  const page = await getFeed(reader, { filters: base, limit: 50 }, secret);
  const card = page.items.find(value => value.id === "work-1")!;
  assert.deepEqual(card.generation, { modelFamily: "veo", mode: "i2v", hasAudio: true });
  assert.deepEqual(card.inputs, { requirement: "required", count: 1, kinds: ["face"], ownLikenessOnly: true });
  assert.equal(card.palette?.[0].hex, "#C2410C");
  assert.equal(card.rights?.imageExport, true);
  assert.equal(card.title, "作品 1");
  assert.ok(page.items.every(value => !("en" in value)));

  const english = await getFeed(reader, { filters: { ...base, locale: "en" }, limit: 50 }, secret);
  assert.equal(english.items.find(value => value.id === "work-1")?.title, "Work 1");
  assert.equal(english.items.find(value => value.id === "work-100")?.title, "作品 100");
  assert.ok(english.items.every(value => !("en" in value)));

  const ids = async (filters: Partial<FeedFilters>) =>
    (await getFeed(reader, { filters: { ...base, ...filters }, limit: 50 }, secret)).items.map(value => value.id).sort();
  const even = Array.from({ length: 6 }, (_, i) => `work-${i * 2}`).sort(), odd = Array.from({ length: 6 }, (_, i) => `work-${i * 2 + 1}`).sort();
  assert.deepEqual(await ids({ facet: "portraits" }), even);
  assert.deepEqual(await ids({ facet: "cinematic" }), [...even, ...odd].sort());
  assert.deepEqual(await ids({ mode: "i2v" }), odd);
  assert.deepEqual(await ids({ modelFamily: "gpt-image" }), even);
  assert.deepEqual(await ids({ inputs: "required" }), odd);
  assert.deepEqual(await ids({ inputs: "none", kind: "video" }), []);
  assert.deepEqual(await ids({ facet: "portraits", sort: "discovery" }), even);

  const browse = await getBrowse(reader, "en");
  assert.deepEqual(browse.facets.useCase, [{ id: "fashion", count: 6 }, { id: "portraits", count: 6 }]);
  assert.deepEqual(browse.facets.style, [{ id: "cinematic", count: 12 }]);
  assert.deepEqual(browse.modelFamilies, [{ id: "gpt-image", count: 6 }, { id: "veo", count: 6 }]);
  assert.ok(browse.collections.flatMap(value => value.covers).every(value => !("en" in value)));
  const discovery = await getCreatorDiscovery(reader, { filters: { q: "", sort: "count" }, limit: 5 }, secret);
  assert.ok(discovery.items.every(value => value.preview && !("en" in value.preview)));
});

test("new filter values are validated against the shared vocabularies", () => {
  for (const query of ["facet=unknown-facet", "mode=t3v", "inputs=maybe", "modelFamily=dalle", "facet=portraits&facet=fashion"])
    assert.throws(() => parseFeedQuery(new URL(`https://example.com/v3/feed?${query}`)), query);
  assert.equal(parseFeedQuery(new URL("https://example.com/v3/feed?facet=portraits&mode=t2i&inputs=none&modelFamily=veo")).filters.facet, "portraits");
});
