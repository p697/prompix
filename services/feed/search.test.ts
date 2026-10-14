import assert from "node:assert/strict";
import { test } from "node:test";
import type { Prompt } from "../../packages/schema/catalog.ts";
import { normalizeFeedSearch, parseFeedQuery } from "../../packages/schema/feed.ts";
import { translationFingerprint } from "../../ingest/translation.ts";
import { createTestDatabase } from "./test-database.ts";
import { activatePublication, stagePublication } from "./publication.ts";
import { getCreators, getFeed } from "./queries.ts";

const secret = "search-test-secret-000000000000000000000000000000000000";
function prompt(id: string, changes: Partial<Prompt> = {}): Prompt {
  return { id, kind: "text", title: "An original fixture", summary: "First-party test content", prompt: "Write a tea story.",
    example: "A moonstone example", tags: ["fixture"], model: "Test model", toolURL: null, artwork: "test", previewLabel: "Preview",
    source: { name: "Prompix", url: null, license: "Original", method: "Written for tests" }, media: null, ...changes };
}

test("server search preserves title relevance, complete translated fields, identities and native filters", async t => {
  const { pg, writer, reader } = await createTestDatabase(); t.after(() => pg.close());
  const creator = { id: "jose", platform: "github" as const, displayName: "José Silva", username: "studio_js", profileURL: "https://example.com/jose" };
  const translated = prompt("translated", { creator });
  translated.localization = { sourceLanguage: "en", sourceFingerprint: translationFingerprint(translated), translations: {
    fr: { title: "Café", summary: "Une idée", prompt: "Créer une histoire", example: "Une forêt", previewLabel: "Lueur" },
    ja: { title: "星空の物語", summary: "静かな夜", prompt: "流れ星を探す", example: "青い森", previewLabel: "夜の散歩" },
  } };
  const skill = prompt("skill", { contentType: "skill", skill: { name: "knowledge-capture", description: "Collect research notes", format: "agent-skills",
    entrypoint: "SKILL.md", repository: "https://example.com/repo", directory: "knowledge", installURL: "https://example.com/install" } });
  // Relevance must cross the original position boundary when continuing a cursor.
  const prompts = [prompt("body", { prompt: "Imagine a café." }), prompt("body2", { prompt: "A café interior." }),
    prompt("title", { title: "Café design" }), translated, prompt("image", { kind: "image" }), skill];
  const release = await stagePublication(writer, { schemaVersion: 1, version: "search-fixture", prompts });
  await activatePublication(writer, release, "0");
  const query = (q: string, extra = "") => parseFeedQuery(new URL(`https://example.com/v3/feed?q=${encodeURIComponent(q)}${extra}`));
  const first = await getFeed(reader, query("ＣＡＦＥ", "&limit=1"), secret);
  assert.deepEqual(first.items.map(item => item.id), ["translated"]);
  let page = first; const ids = page.items.map(item => item.id);
  while (page.nextCursor) {
    page = await getFeed(reader, { ...query("cafe", "&limit=1"), cursor: page.nextCursor }, secret);
    ids.push(...page.items.map(item => item.id));
  }
  assert.deepEqual(ids, ["translated", "title", "body", "body2"]);
  for (const q of ["cafe histoire", "foret", "lueur", "星空 流れ星", "青い森", "夜の散歩", "@STUDIO_JS jose GitHub"])
    assert.deepEqual((await getFeed(reader, query(q), secret)).items.map(item => item.id), ["translated"], q);
  assert.equal((await getFeed(reader, query("moonstone"), secret)).items.length, 6);
  assert.deepEqual((await getFeed(reader, query("skills research"), secret)).items.map(item => item.id), ["skill"]);
  assert.equal((await getFeed(reader, query("research", "&kind=text"), secret)).items.length, 0);
  assert.deepEqual((await getFeed(reader, query("", "&kind=skill"), secret)).items.map(item => item.id), ["skill"]);
  assert.deepEqual((await getFeed(reader, query("image"), secret)).items.map(item => item.id), ["image"]);
  assert.deepEqual((await getFeed(reader, query("", "&tag=" + encodeURIComponent("创作灵感")), secret)).items.map(item => item.id), ["image"]);
  assert.equal((await getCreators(reader, { q: normalizeFeedSearch("jose @studio_js"), limit: 30 }, secret)).items.length, 1);
  for (const value of ["Café", "ＣＡＦＥ", "Ångström", "가나다", "が", "ﬃ"]) {
    const sql = (await reader.query<{ normalized: string }>("select prompix.normalize_search($1) as normalized", [value])).rows[0].normalized;
    assert.equal(sql, normalizeFeedSearch(value));
  }
  await assert.rejects(writer.query("update prompix.revisions set original='{}'"), /permission denied/);
});
