import assert from "node:assert/strict";
import { test } from "node:test";
import { collectionDefinitions, parseFeedQuery } from "../../packages/schema/feed.ts";
import type { Prompt } from "../../packages/schema/catalog.ts";
import { translationFingerprint } from "../../ingest/translation.ts";
import { createTestDatabase } from "./test-database.ts";
import { activatePublication, removeContent, stagePublication } from "./publication.ts";
import { getBrowse, getFeed } from "./queries.ts";
import { databaseReport } from "./maintenance.ts";
import { serveFeed } from "./http.ts";

test("global browse facets and collection pages share definitions and respect visibility", async t => {
  const { pg, writer, reader } = await createTestDatabase();
  t.after(() => pg.close());
  const prompts: Prompt[] = Array.from({ length: 63 }, (_, i) => {
    const item: Prompt = { id: `browse-${i}`, kind: i % 3 === 0 ? "video" : i % 3 === 1 ? "image" : "text",
      title: `Synthetic ${i}`, summary: "Synthetic collection", prompt: "Original body", example: "Example",
      tags: i % 2 ? ["肖像", "写作"] : ["好玩一点"], model: i < 10 ? "Popular model" : `Model ${i}`,
      artwork: "test", previewLabel: "Preview", media: null, toolURL: null,
      source: { name: "Synthetic", url: null, license: "CC0", method: "test" } };
    item.localization = { sourceLanguage: "en", sourceFingerprint: translationFingerprint(item), translations: {
      "zh-Hans": { title: `测试 ${i}`, summary: "摘要", prompt: "正文", example: "示例", previewLabel: "预览" },
    } };
    return item;
  });
  const release = await stagePublication(writer, { schemaVersion: 1, version: "browse", prompts });
  await assert.rejects(() => getBrowse(reader, "original"), /unavailable/);
  await activatePublication(writer, release, "0");
  // A staged change must not leak into either statistics or localized covers.
  await stagePublication(writer, { schemaVersion: 1, version: "private", prompts: [{ ...prompts[0], title: "Unpublished", localization: undefined }] });
  const browse = await getBrowse(reader, "zh-Hans");
  assert.equal(browse.release, release);
  assert.equal(browse.collections.length, 10);
  assert.equal(browse.modelCount, 54);
  assert.equal(browse.models.length, 50);
  assert.deepEqual(browse.models[0], { name: "Popular model", count: 10 });
  assert.ok(Buffer.byteLength(JSON.stringify(browse)) < 1_000_000);
  const secret = "browse-test-only-cursor-key-0000000000000000000000";
  for (const [id, definition] of Object.entries(collectionDefinitions)) {
    const expected = prompts.filter(item => (!definition.kind || item.kind === definition.kind) &&
      (!definition.tags.length || item.tags.some(tag => (definition.tags as string[]).includes(tag))));
    const summary = browse.collections.find(value => value.id === id)!;
    assert.equal(summary.count, expected.length, id);
    assert.ok(summary.covers.length <= 2);
    assert.ok(summary.covers.every(card => card.title.startsWith("测试 ") && !("prompt" in card)));
    const query = parseFeedQuery(new URL(`https://example.com/v3/feed?collection=${id}&limit=2`));
    let page = await getFeed(reader, query, secret);
    const ids = page.items.map(card => card.id);
    if (page.nextCursor) {
      await assert.rejects(() => getFeed(reader, { ...query, filters: { locale: "original", q: "" }, cursor: page.nextCursor! }, secret), /invalid_request/);
    }
    while (page.nextCursor) {
      page = await getFeed(reader, { ...query, cursor: page.nextCursor }, secret);
      ids.push(...page.items.map(card => card.id));
    }
    assert.deepEqual(ids, expected.map(item => item.id));
  }
  await removeContent(writer, ["browse-0", "browse-1"], "Synthetic takedown");
  const after = await getBrowse(reader, "original");
  assert.equal(after.models[0].count, 8);
  assert.equal(after.collections.find(value => value.id === "video")!.count, 20);
  assert.ok(after.collections.every(value => value.covers.every(card => !["browse-0", "browse-1"].includes(card.id))));
  const report = await databaseReport(writer);
  assert.equal(report.storage.releases, 2);
  assert.equal(report.storage.revisions, 64);
  assert.equal(report.storage.removals, 2);
  assert.equal(report.distribution.reduce((sum, row) => sum + Number(row.count), 0), 61);
  assert.equal(report.distribution.reduce((sum, row) => sum + Number(row.translations), 0), 61);
  assert.equal(report.latestRun, null);
  await assert.rejects(() => databaseReport(reader), /permission denied/);
  const valid = await serveFeed(new Request("https://example.com/v3/browse?locale=ja"), reader, secret);
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get("cache-control"), "no-store");
  for (const path of ["browse?locale=ja&locale=en", "browse?locale=xx", "browse?limit=5", "feed?collection=unknown"]) {
    assert.equal((await serveFeed(new Request(`https://example.com/v3/${path}`), reader, secret)).status, 400, path);
  }
});
