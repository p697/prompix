import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Prompt } from "../packages/schema/catalog.ts";
import { checkNewTranslations } from "./translation-check-daily.ts";
import { ModelProviderError, type ModelProvider } from "./models/types.ts";
import { translationFingerprint } from "./translation.ts";

const text = (title: string) => ({ title, summary: "摘要", prompt: "提示词", example: "示例", previewLabel: "图片" });
function item(id: string, translations: Record<string, ReturnType<typeof text>>): Prompt {
  const base = { id, kind: "text", title: "Title", summary: "Summary", prompt: "Write a short poem.", example: "", tags: [], model: "GPT",
    source: { name: "X", url: `https://x.com/i/web/status/${id}`, license: "Source-author-rights" } } as unknown as Prompt;
  return { ...base, localization: { sourceLanguage: "en", sourceFingerprint: translationFingerprint(base), translations } } as Prompt;
}
const provider = { id: "anthropic-api", kind: "api", model: "reviewer", capabilities: { images: false, structuredOutput: "native" } } as unknown as ModelProvider;
async function directory(t: { after: (fn: () => Promise<void>) => void }) {
  const path = await mkdtemp(join(tmpdir(), "prompix-translation-check-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("only new translations are reviewed; held or unreviewed text hides that locale alone", async t => {
  const root = await directory(t), calls: string[][] = [];
  const live = item("a", { "zh-Hans": text("旧标题"), ja: text("旧タイトル") });
  const items = [item("a", { "zh-Hans": text("旧标题"), ja: text("新タイトル") }), item("b", { "zh-Hans": text("好"), fr: text("Mauvais") })];
  const review = async (_provider: ModelProvider, batch: readonly Prompt[], locale: string) => {
    calls.push(batch.map(value => `${value.id}:${locale}`));
    return { reviews: batch.map(value => ({ id: value.id, verdict: locale === "fr" ? "needs-review" as const : "pass" as const, issues: [] })) } as never;
  };
  const result = await checkNewTranslations(items, [live], root, { provider, review });
  assert.deepEqual(calls.flat().sort(), ["a:ja", "b:fr", "b:zh-Hans"], "live text is not reviewed again");
  assert.deepEqual(Object.keys(result.prompts[0].localization!.translations).sort(), ["ja", "zh-Hans"]);
  assert.deepEqual(Object.keys(result.prompts[1].localization!.translations), ["zh-Hans"], "the held French text is hidden, the item stays");
  assert.deepEqual({ passed: result.report.passed, held: result.report.held }, { passed: 2, held: 1 });

  const again = await checkNewTranslations(items, [live], root);
  assert.deepEqual(again.prompts, result.prompts, "recorded verdicts need no model");
  const unreviewed = await checkNewTranslations([item("c", { de: text("Neu") })], [], root);
  assert.deepEqual(unreviewed.prompts[0].localization!.translations, {});
  assert.equal(unreviewed.report.withheld, 1);
});

test("a refusal holds the text for good and a rate limit stops the run without publishing unreviewed text", async t => {
  const root = await directory(t);
  let calls = 0;
  const refuse = async () => { calls++; throw new ModelProviderError("declined", "refused", false); };
  await checkNewTranslations([item("d", { ko: text("제목") })], [], root, { provider, review: refuse });
  const after = await checkNewTranslations([item("d", { ko: text("제목") })], [], root, { provider, review: refuse });
  assert.equal(calls, 1);
  assert.equal(after.report.held, 1);
  const limited = await checkNewTranslations([item("e", { es: text("Título") })], [], root,
    { provider, review: async () => { throw new ModelProviderError("slow", "rate_limited", true); } });
  assert.equal(limited.report.status, "stopped");
  assert.deepEqual(limited.prompts[0].localization!.translations, {});
});
