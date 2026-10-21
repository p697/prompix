import test from "node:test";
import { z } from "zod";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { catalogSchema } from "../packages/schema/catalog.ts";
import { originalAndChinese, hasRequiredTranslations, seedApprovedChineseMetadata } from "./ingest-language-policy.ts";
import { emptyTranslationCache, promptSegments, translationFingerprint, translationText } from "./translation.ts";
import { verifySemanticResult, partitionSemanticResult, semanticResponseSchema } from "./translation-semantic.ts";
const fixture = catalogSchema.parse(JSON.parse(await readFile(new URL("../ios/Prompix/Resources/catalog.json", import.meta.url), "utf8"))).prompts[0];
const item = { ...fixture, title: "纸雕山村", summary: "生成精致纸雕村庄，保持柔和光影。", prompt: "Create a quiet mountain village.", example: "使用建议：先选择构图，再生成图片。", previewLabel: "来源图片", cover: undefined };
const translated = { ...translationText(item), prompt: "生成安静的山间村落。" };
const localized = { ...item, localization: { sourceLanguage: "en", sourceFingerprint: translationFingerprint(item), translations: { "zh-Hans": translated, ja: { ...translated, prompt: "broken optional language" } } } };
test("original and Chinese release excludes optional languages and preserves all source bytes", () => {
  const [result] = originalAndChinese([localized]);
  assert.equal(result.prompt, item.prompt);
  assert.deepEqual(Object.keys(result.localization!.translations), ["zh-Hans"]);
  assert.equal(hasRequiredTranslations(result), true);
  assert.equal(hasRequiredTranslations({ ...result, prompt: item.prompt + " Change the source." }), false);
  assert.equal(hasRequiredTranslations(item), false);
});
test("approved Chinese metadata is reused while non-Chinese body remains pending", () => {
  const cache = emptyTranslationCache();
  assert.ok(seedApprovedChineseMetadata([item], cache) >= 4);
  assert.equal(cache.segments["zh-Hans"][promptSegments(item).find(s => s.sourceText === item.prompt)!.id], undefined);
  assert.equal(seedApprovedChineseMetadata([item], cache), 0);
  assert.equal(hasRequiredTranslations(originalAndChinese([item], cache)[0]), false);
});
test("semantic checks require complete IDs and grounded evidence, accepting only quote-format normalization", () => {
  const pass = { reviews: [{ id: item.id, verdict: "pass", issues: [] }] };
  assert.equal(verifySemanticResult(pass, [localized], "zh-Hans").length, 1);
  assert.throws(() => verifySemanticResult({ reviews: [] }, [localized], "zh-Hans"), /Incomplete/);
  const issue = { field: "prompt", sourceQuote: "“quiet mountain village”", translatedQuote: "“安静的山间村落”", reason: "Needs inspection" };
  assert.equal(verifySemanticResult({ reviews: [{ id: item.id, verdict: "needs-review", issues: [issue] }] }, [localized], "zh-Hans").length, 1);
  assert.throws(() => verifySemanticResult({ reviews: [{ id: item.id, verdict: "needs-review", issues: [{ ...issue, sourceQuote: "invented missing sentence" }] }] }, [localized], "zh-Hans"), /evidence/);
  assert.throws(() => verifySemanticResult({ reviews: [{ id: item.id, verdict: "pass", issues: [issue] }] }, [localized], "zh-Hans"), /Invalid semantic/);
});


test("unverifiable review evidence holds its item without losing a verified sibling", () => {
  const second = { ...localized, id: "second" };
  const raw = { reviews: [
    { id: localized.id, verdict: "needs-review", issues: [{ field: "prompt", sourceQuote: "invented", translatedQuote: "invented", reason: "Unverifiable" }] },
    { id: second.id, verdict: "pass", issues: [] },
  ] };
  const result = partitionSemanticResult(raw, [localized, second], "zh-Hans");
  assert.deepEqual(result.unverifiedEvidence, [localized.id]);
  assert.equal(result.reviews[0].verdict, "needs-review");
  assert.equal(result.reviews[1].verdict, "pass");
  assert.throws(() => partitionSemanticResult({ reviews: [raw.reviews[1]] }, [localized, second], "zh-Hans"), /Incomplete/);
});

test("metadata audit binds location and duration claims to original prompt evidence", () => {
  for (const [title, prompt, quote, chinese] of [
    ["香港晨间散步", "Create a morning walk in an older Seoul residential neighborhood.", "Seoul", "在首尔一处较老的住宅区，生成一段清晨散步的场景。"],
    ["一分钟花瓣短片", "Storyboard: 00:00–00:03 walk; 00:03–00:15 watch petals and finish.", "00:03–00:15", "分镜：00:00–00:03 散步；00:03–00:15 看着花瓣并结束。"],
  ]) {
    const source = { ...item, title, prompt };
    const reviewed = { ...source, localization: { sourceLanguage: "en", sourceFingerprint: translationFingerprint(source),
      translations: { "zh-Hans": { ...translationText(source), prompt: chinese } } } };
    const issue = { field: "title", sourceField: "prompt", sourceQuote: quote, translatedQuote: title, reason: "Metadata contradicts the original prompt." };
    const result = verifySemanticResult({ reviews: [{ id: source.id, verdict: "needs-review", issues: [issue] }] }, [reviewed], "zh-Hans");
    assert.equal(result[0].issues[0].sourceField, "prompt");
    assert.throws(() => verifySemanticResult({ reviews: [{ id: source.id, verdict: "needs-review", issues: [{ ...issue, sourceQuote: "invented source evidence" }] }] }, [reviewed], "zh-Hans"), /evidence/);
    assert.throws(() => verifySemanticResult({ reviews: [{ id: source.id, verdict: "needs-review", issues: [{ ...issue, translatedQuote: "invented title" }] }] }, [reviewed], "zh-Hans"), /evidence/);
  }
});


test("semantic provider schema requires nullable sourceField while retained reviews stay readable", () => {
  const schema = z.toJSONSchema(semanticResponseSchema([localized]));
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.properties) assert.deepEqual(new Set(node.required), new Set(Object.keys(node.properties)));
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === "object") visit(value);
  };
  visit(schema);
  const issue = { field: "prompt", sourceField: null, sourceQuote: "quiet mountain village", translatedQuote: "安静的山间村落", reason: "Needs inspection" };
  const raw = { reviews: [{ id: item.id, verdict: "needs-review", issues: [issue] }] };
  assert.equal(verifySemanticResult(raw, [localized], "zh-Hans").length, 1);
  assert.equal(semanticResponseSchema([localized]).safeParse(raw).success, true);
});


test("mixed Chinese metadata with English bracket guidance is translated, never seeded or fatal", async () => {
  const { translationBatches, runTranslations } = await import("./translation-runner.ts");
  const mixed = { ...item, example: "请先填写人物姓名和详细说明，然后生成完整画面：[Enter your name]" };
  const cache = emptyTranslationCache();
  seedApprovedChineseMetadata([mixed], cache);
  const segment = promptSegments(mixed).find(s => s.sourceText === mixed.example)!;
  assert.equal(cache.segments["zh-Hans"]?.[segment.id], undefined);
  assert.ok(translationBatches([mixed], cache, ["zh-Hans"]).some(b => b.segments.some(s => s.id === segment.id)));
  let calls = 0;
  const report = await runTranslations({ items: [mixed], cache, locales: ["zh-Hans"], providerName: "codex", maxAttempts: 1,
    provider: async (_locale, segments) => { calls++; return { translations: segments.map(s => ({ id: s.id, text: s.id === segment.id ? "请先填写人物姓名和详细说明，然后生成完整画面：[输入你的姓名]" : "生成安静的山间村落。" })) }; }, persist: async () => {} });
  assert.equal(calls, 1);
  assert.equal(report.failed, 0);
  assert.equal(report.rejected, 0);
  assert.equal(report.pendingSegments, 0);
  assert.equal(hasRequiredTranslations(originalAndChinese([mixed], cache)[0]), true);
});
