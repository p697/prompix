import { test } from "node:test";
import assert from "node:assert/strict";
import type { Prompt } from "../../packages/schema/catalog.ts";
import { parseFeedQuery, type FeedFilters } from "../../packages/schema/feed.ts";
import { createTestDatabase } from "./test-database.ts";
import { activatePublication, preparePublication, removeContent, stagePublication } from "./publication.ts";
import { getFeed } from "./queries.ts";
import { contentTopics } from "../../packages/schema/interests.ts";

const secret = "recommendation-test-secret-000000000000000000000";
const filters: FeedFilters = { locale: "original", q: "", sort: "recommended", seed: "a".repeat(32) };
const item = (n: number): Prompt => ({
  id: `recommendation-${n}`, kind: n % 5 === 4 ? "text" : "image", title: `Original fixture ${n}`,
  summary: "Original test content", prompt: "Create a still life with an original ceramic cup.", example: "A cup",
  tags: ["fixture"], model: "Fixture", toolURL: null, artwork: "test", previewLabel: "Preview",
  source: { name: "Prompix", url: null, license: "Original", method: "Test" },
  media: n % 5 === 4 ? null : { image: "lake", video: null, demoURL: null },
});
const input = (prompts: Prompt[]) => ({ schemaVersion: 1 as const, version: "fixture", prompts });

test("editorial topic coverage includes visual design and everyday tasks without guessing ambiguous interests", () => {
  assert.deepEqual(contentTopics({ tags: ["时装编辑", "合照构图"], kind: "image" }), ["portrait", "fashion"]);
  assert.deepEqual(contentTopics({ tags: ["信息图", "平面设计"], kind: "image" }), ["illustration"]);
  assert.deepEqual(contentTopics({ tags: ["菜谱生成", "食材利用"], kind: "text" }), ["lifestyle"]);
  assert.deepEqual(contentTopics({ tags: ["项目规划", "客户支持"], kind: "text" }), ["business"]);
  assert.deepEqual(contentTopics({ tags: ["ＷｅｂＧＬ", "着色器"], kind: "text" }), ["coding"]);
  assert.deepEqual(contentTopics({ tags: ["创作灵感", "对话助手"], kind: "image" }), []);
  assert.deepEqual(contentTopics({ tags: ["菜谱生成"], kind: "text", contentType: "skill" }), ["lifestyle", "skills"]);
  assert.deepEqual(contentTopics({ tags: ["运动"], kind: "image" }), ["lifestyle"]);
  assert.deepEqual(contentTopics({ tags: ["镜头运动", "3D运动"], kind: "image" }), []);
});

test("published cards expose newly covered interests without changing their media or presentation evidence", async t => {
  const { pg, reader, writer } = await createTestDatabase(); t.after(() => pg.close());
  const prompt = { ...item(0), tags: ["时装编辑"], presentation: "unknown" as const };
  const release = await stagePublication(writer, input([prompt])); await activatePublication(writer, release, "0");
  const page = await getFeed(reader, { filters, limit: 30 }, secret);
  assert.deepEqual(page.items[0].topics, ["fashion"]);
  assert.equal(page.items[0].presentation, "unknown");
  assert.deepEqual(page.items[0].media, prompt.media);
});

test("recommended requests require an ephemeral seed and refuse behavior or arbitrary extra fields", () => {
  const valid = `https://example.com/v3/feed?sort=recommended&seed=${filters.seed}`;
  assert.equal(parseFeedQuery(new URL(valid)).filters.seed, filters.seed);
  for (const url of ["?sort=recommended", `?sort=latest&seed=${filters.seed}`, `?sort=recommended&seed=${"z".repeat(32)}`,
    `?sort=recommended&seed=${filters.seed}&q=photo`, `?sort=recommended&seed=${filters.seed}&interests=portrait`,
    `?sort=recommended&seed=${filters.seed}&seen=some-item`]) {
    assert.throws(() => parseFeedQuery(new URL(`https://example.com/v3/feed${url}`)));
  }
});

test("each session rotates candidates while an entire filtered page chain stays unique and pinned", async t => {
  const { pg, reader, writer } = await createTestDatabase(); t.after(() => pg.close());
  const prompts = Array.from({ length: 450 }, (_, n) => item(n));
  const release = await stagePublication(writer, input(prompts)); await activatePublication(writer, release, "0");
  const first = await getFeed(reader, { filters, limit: 30 }, secret);
  assert.equal(first.items.filter(card => card.media?.image).length, 24);
  assert.ok(first.items.slice(0, 4).every(card => card.media?.image));
  assert.deepEqual((await getFeed(reader, { filters, limit: 30 }, secret)).items, first.items);
  const rotated = await getFeed(reader, { filters: { ...filters, seed: "b".repeat(32) }, limit: 30 }, secret);
  const overlap = rotated.items.filter(card => first.items.some(other => other.id === card.id)).length;
  assert.ok(overlap <= 12, `Excessive first-page overlap: ${overlap}/30`);
  const ids = first.items.map(card => card.id);
  let cursor = first.nextCursor ?? undefined, iteration = 0;
  while (cursor) {
    const page = await getFeed(reader, { filters, cursor, limit: [7, 50, 1, 13][iteration++ % 4] }, secret);
    assert.equal(page.release, release); ids.push(...page.items.map(card => card.id)); cursor = page.nextCursor ?? undefined;
  }
  assert.equal(ids.length, prompts.length); assert.equal(new Set(ids).size, prompts.length);
  for (const kind of ["text", "image", "video", "web", "skill"] as const) {
    const page = await getFeed(reader, { filters: { ...filters, kind }, limit: 30 }, secret);
    assert.ok(page.items.every(card => card.kind === kind));
    assert.equal(page.items.length > 0, kind === "text" || kind === "image");
  }
});

test("recommendation cursor rejects changed seeds, searches, tampering and expiry; removals do not resurrect", async t => {
  const { pg, reader, writer } = await createTestDatabase(); t.after(() => pg.close());
  const prompts = Array.from({ length: 100 }, (_, n) => item(n));
  const release = await stagePublication(writer, input(prompts)); await activatePublication(writer, release, "0");
  const page = await getFeed(reader, { filters, limit: 7 }, secret);
  for (const changed of [{ ...filters, seed: "b".repeat(32) }, { ...filters, kind: "image" as const },
    { ...filters, locale: "en" as const }, { ...filters, sort: "discovery" as const }, { ...filters, q: "photo" }]) {
    await assert.rejects(getFeed(reader, { filters: changed, cursor: page.nextCursor!, limit: 7 }, secret), /invalid_request/);
  }
  const [body, mac] = page.nextCursor!.split("."); const signature = Buffer.from(mac, "base64url"); signature[0] ^= 1;
  await assert.rejects(getFeed(reader, { filters, cursor: `${body}.${signature.toString("base64url")}`, limit: 7 }, secret), /invalid_request/);
  await assert.rejects(getFeed(reader, { filters, cursor: page.nextCursor!, limit: 7 }, secret, Date.now() + 25 * 3600000), /invalid_request/);
  const unseen = prompts.filter(item => !page.items.some(card => card.id === item.id)).slice(0, 3).map(item => item.id);
  const next = await stagePublication(writer, input([item(999), ...prompts])); await activatePublication(writer, next, "1");
  await removeContent(writer, unseen, "Fixture removal");
  const ids = page.items.map(card => card.id); let cursor = page.nextCursor ?? undefined;
  while (cursor) {
    const result = await getFeed(reader, { filters, cursor, limit: 13 }, secret);
    assert.equal(result.release, release); ids.push(...result.items.map(card => card.id)); cursor = result.nextCursor ?? undefined;
  }
  assert.equal(ids.length, 97); assert.equal(new Set(ids).size, 97);
  assert.ok(ids.every(id => !unseen.includes(id) && id !== "recommendation-999"));
  await pg.query("update prompix.releases set published_at=null where id=$1", [release]);
  await assert.rejects(getFeed(reader, { filters, cursor: page.nextCursor!, limit: 7 }, secret), /snapshot_expired/);
});


test("publication rejects explicit imagery while carrying independent reviewed presentation labels", async t => {
  assert.throws(() => preparePublication(input([{ ...item(0), presentation: "explicit" }])), /explicit/i);
  const { pg, reader, writer } = await createTestDatabase(); t.after(() => pg.close());
  const prompts = [
    { ...item(0), tags: ["人物肖像"], presentation: "general" as const },
    { ...item(1), tags: ["时尚摄影"], presentation: "suggestive" as const },
    { ...item(2), presentation: "unknown" as const },
  ];
  const release = await stagePublication(writer, input(prompts)); await activatePublication(writer, release, "0");
  const page = await getFeed(reader, { filters, limit: 30 }, secret);
  for (const prompt of prompts) assert.equal(page.items.find(card => card.id === prompt.id)?.presentation, prompt.presentation);
  assert.deepEqual(page.items.find(card => card.id === prompts[0].id)?.topics, ["portrait"]);
  assert.deepEqual(page.items.find(card => card.id === prompts[1].id)?.topics, ["fashion"]);
});
