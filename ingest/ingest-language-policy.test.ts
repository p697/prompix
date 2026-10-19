import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { catalogSchema } from "../packages/schema/catalog.ts";
import { originalAndChinese, hasRequiredTranslations, seedApprovedChineseMetadata } from "./ingest-language-policy.ts";
import { emptyTranslationCache, promptSegments, translationFingerprint, translationText } from "./translation.ts";
import { verifySemanticResult, partitionSemanticResult } from "./translation-semantic.ts";
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
  for (const [title, prompt, quote] of [
    ["香港晨间散步", "Create a morning walk in an older Seoul residential neighborhood.", "Seoul"],
    ["一分钟花瓣短片", "Storyboard: 00:00–00:03 walk; 00:03–00:15 watch petals and finish.", "00:03–00:15"],
  ]) {
    const source = { ...item, title, prompt };
    const reviewed = { ...source, localization: { sourceLanguage: "en", sourceFingerprint: translationFingerprint(source),
      translations: { "zh-Hans": { ...translationText(source), prompt: "按原始分镜生成短片，保留位置、时长与所有约束。" } } } };
    const issue = { field: "title", sourceField: "prompt", sourceQuote: quote, translatedQuote: title, reason: "Metadata contradicts the original prompt." };
    const result = verifySemanticResult({ reviews: [{ id: source.id, verdict: "needs-review", issues: [issue] }] }, [reviewed], "zh-Hans");
    assert.equal(result[0].issues[0].sourceField, "prompt");
    assert.throws(() => verifySemanticResult({ reviews: [{ id: source.id, verdict: "needs-review", issues: [{ ...issue, sourceQuote: "invented source evidence" }] }] }, [reviewed], "zh-Hans"), /evidence/);
    assert.throws(() => verifySemanticResult({ reviews: [{ id: source.id, verdict: "needs-review", issues: [{ ...issue, translatedQuote: "invented title" }] }] }, [reviewed], "zh-Hans"), /evidence/);
  }
});
