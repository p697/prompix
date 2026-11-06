import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptSchema, type Prompt } from "../packages/schema/catalog.ts";
import { ModelProviderError, type ModelProvider, type ModelRequest } from "./models/types.ts";
import { modelTranslationProvider, TranslationProviderError } from "./translation-provider.ts";
import { reviewTranslationSemanticsWith } from "./translation-semantic.ts";
import { translationFingerprint } from "./translation.ts";

function provider(respond: (request: ModelRequest) => unknown, seen: ModelRequest[] = []): ModelProvider {
  return { id: "anthropic-api", kind: "api", model: "claude-sonnet-5-5", capabilities: { images: true, structuredOutput: "native" },
    async complete(request) {
      seen.push(request);
      const output = respond(request);
      return { output, text: JSON.stringify(output), provider: "anthropic-api", model: "claude-sonnet-5-5", usage: { inputTokens: 10, outputTokens: 5 },
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    } };
}

test("provider-layer translation keeps segment identities, data framing and usage", async () => {
  const seen: ModelRequest[] = [];
  const translate = modelTranslationProvider(provider(() => ({ translations: [{ id: "0", text: "你好" }, { id: "1", text: "世界" }] }), seen));
  const result = await translate("zh-Hans", [{ id: "a".repeat(64), text: "Hello" }, { id: "b".repeat(64), text: "World", reviewFeedback: ["Keep the slogan in English."] }]);
  assert.deepEqual(result.translations, [{ id: "a".repeat(64), text: "你好" }, { id: "b".repeat(64), text: "世界" }]);
  assert.equal(result.inputTokens, 10);
  assert.ok(!seen[0].instructions.includes("World"), "segments are data, not instructions");
  assert.match(seen[0].input, /Keep the slogan in English/);
});

test("a refusal or malformed answer is a permanent translation failure", async () => {
  const refusing: ModelProvider = { ...provider(() => ({})), async complete() { throw new ModelProviderError("declined", "refused", false); } };
  await assert.rejects(modelTranslationProvider(refusing)("zh-Hans", [{ id: "a".repeat(64), text: "Hello" }]),
    (error: unknown) => error instanceof TranslationProviderError && error.permanent);
  await assert.rejects(modelTranslationProvider(provider(() => ({ translations: "nope" })))("zh-Hans", [{ id: "a".repeat(64), text: "Hello" }]),
    (error: unknown) => error instanceof TranslationProviderError && error.permanent);
});

test("provider-layer semantic review sends a vendor-neutral schema and keeps strict verification", async () => {
  const base = promptSchema.parse({ id: "x-post-1", kind: "text", title: "雨夜故事", summary: "写一个雨夜的短故事。", prompt: "Write a short story about a rainy night.",
    example: "使用建议：直接复制。", tags: ["写作"], model: "Unspecified", toolURL: null, artwork: "x-post-1", previewLabel: "文字",
    source: { name: "Prompix Studio", url: null, license: "CC0-1.0", method: "原创" }, media: null });
  const item: Prompt = { ...base, localization: { sourceLanguage: "en", sourceFingerprint: translationFingerprint(base), translations: {
    "zh-Hans": { title: "雨夜故事", summary: "写一个雨夜的短故事。", prompt: "写一个关于雨夜的短故事。", example: "使用建议：直接复制。", previewLabel: "文字" } } } };
  const seen: ModelRequest[] = [];
  const directory = await mkdtemp(join(tmpdir(), "prompix-semantic-route-"));
  const passed = await reviewTranslationSemanticsWith(provider(() => ({ reviews: [{ id: "x-post-1", verdict: "pass", issues: [] }] }), seen), [item], "zh-Hans", directory);
  assert.equal(passed.reviews[0].verdict, "pass");
  for (const keyword of ["minItems", "maxItems", "minLength", "$schema"]) assert.ok(!JSON.stringify(seen[0].schema).includes(`"${keyword}"`), keyword);
  // A pass that still lists an issue is contradictory and is held, as on the Codex route.
  const contradictory = await reviewTranslationSemanticsWith(provider(() => ({ reviews: [{ id: "x-post-1", verdict: "pass",
    issues: [{ field: "prompt", sourceQuote: "rainy night", translatedQuote: "雨夜", reason: "Changed meaning" }] }] })), [item], "zh-Hans", join(directory, "second"));
  assert.equal(contradictory.reviews[0].verdict, "needs-review");
});
