import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { catalogSchema } from "../packages/schema/catalog.ts";
import { attachTranslations, emptyTranslationCache, inheritPreviousTranslations, localizePrompt, promptSegments, protectText, restoreText, translationLocales, translationFingerprint, validLocalizedText, validateSegment } from "./translation.ts";
import { translationBatches, runTranslations } from "./translation-runner.ts";
import { TranslationProviderError } from "./translation-provider.ts";

const fixture = catalogSchema.parse(JSON.parse(await readFile(new URL("../ios/Prompix/Resources/catalog.json", import.meta.url), "utf8"))).prompts[0];
const item = { ...fixture, title: "Portrait", summary: "Generate a portrait with gentle studio lighting.", prompt: "Create a portrait of {subject}, add https://example.com/reference and --ar 16:9. Keep `field_name`.", example: "Replace {subject} with the person you want to depict.", previewLabel: "Studio example", cover: { text: "Portrait", eyebrow: "IMAGE", tone: "sage" as const } };

test("oversized historical fields split without truncation, broken syntax or blocking other records", () => {
  const prose = "The scene you create should tell your story with a clear focus. Keep {subject}, https://example.com/reference and `field_name` unchanged. 🌿\n\n".repeat(290);
  for (const body of [prose, JSON.stringify({ prompt: prose, seed: 42, model: "literal_model" })]) {
    const source = { ...item, prompt: body };
    const cache = emptyTranslationCache(), segments = promptSegments(source);
    assert.ok(segments.length > promptSegments(item).length);
    assert.ok(segments.every(segment => segment.text.length <= 30000));
    assert.doesNotThrow(() => translationBatches([source, item], cache, ["en"]));
    cache.segments.en = Object.fromEntries(segments.map(segment => [segment.id, segment.text]));
    assert.equal(localizePrompt(source, "en", cache)?.prompt, body, "Reassembly must retain every source byte, including whitespace and JSON formatting");
    const chunk = segments.find(segment => segment.text.length > 1000)!;
    delete cache.segments.en[chunk.id];
    assert.equal(localizePrompt(source, "en", cache), undefined, "Partial chunks cannot become a complete translation");
    cache.segments.en[chunk.id] = chunk.text.replace(/⟦PP\d+⟧/, "lost placeholder");
    assert.equal(localizePrompt(source, "en", cache), undefined);
  }
});

function fillCache(locale: "en" | "zh-Hans" = "en") {
  const cache = emptyTranslationCache();
  cache.segments[locale] = Object.fromEntries(promptSegments(item).map(segment => [segment.id, locale === "en" ? segment.text : "生成肖像。" + [...segment.text.matchAll(/⟦PP\d+⟧/g)].map(match => match[0]).join(" ")]));
  return cache;
}
test("opaque syntax is preserved exactly and natural word order may reorder it", () => {
  const original = "Use {subject}, [REFERENCE_IMAGE], ${color}, {{name}}, https://example.com/x?a=1 and --no text, logos, watermarks --ar 16:9 at 24fps. `name`\n```json\n{\"key\":42}\n```";
  const protectedText = protectText(original);
  assert.equal(restoreText(protectedText.masked, protectedText.protectedValues), original);
  assert.throws(() => restoreText(protectedText.masked.replace("⟦PP0⟧", "broken"), protectedText.protectedValues));
  assert.throws(() => restoreText(protectedText.masked + "⟦PP0⟧", protectedText.protectedValues));
  assert.equal(restoreText("⟦PP1⟧ ⟦PP0⟧", ["a", "b"]), "b a");
  assert.throws(() => restoreText("⟦PP1⟧ ⟦PP1⟧ ⟦PP9⟧", ["a", "b"]), /missing: ⟦PP0⟧; duplicate: ⟦PP1⟧; unexpected: ⟦PP9⟧/);
  assert.deepEqual(protectText("55.6万本场点赞，12.3w viewers and 68.7萬總計").protectedValues, ["55.6万", "12.3w", "68.7萬"]);
});
test("Skill frontmatter and fenced implementation remain opaque", () => {
  const text = "---\nname: deploy\ndescription: Deploy an app\n---\nExplain the workflow.\n```sh\nnpm run deploy\n```";
  const protectedText = protectText(text);
  assert.equal(protectedText.protectedValues[0], text.split("\nExplain")[0]);
  assert.match(protectedText.masked, /Explain the workflow/);
  assert.equal(restoreText(protectedText.masked, protectedText.protectedValues), text);
});

test("age and decade plurals remain translatable without changing actual seconds units", () => {
  const source = "A woman in her early 20s, styled like the late 1950s. Hold for 20s at 24fps.";
  const result = protectText(source);
  assert.deepEqual(result.protectedValues, ["20", "1950", "20s", "24fps"]);
  assert.equal(restoreText(result.masked, result.protectedValues), source);
  assert.equal(restoreText("一位⟦PP0⟧岁出头的女性，采用⟦PP1⟧年代末的风格。保持⟦PP2⟧，帧率为⟦PP3⟧。", result.protectedValues), "一位20岁出头的女性，采用1950年代末的风格。保持20s，帧率为24fps。");
});

test("values assigned to rendered visual lettering stay literal while descriptive inputs remain prose", () => {
  const source = "[CITY] = KYOTO\n[QUOTE] = Follow the quiet river.\n[SUBJECT] = a small paper boat\n\nDepict [SUBJECT] floating through [CITY].\n\nPlace elegant typography at the top. Show [CITY] in uppercase serif, with [QUOTE] beneath it in smaller type.";
  const protectedText = protectText(source, true);
  assert.ok(protectedText.protectedValues.includes("KYOTO"));
  assert.ok(protectedText.protectedValues.includes("Follow the quiet river."));
  assert.ok(!protectedText.protectedValues.includes("a small paper boat"));
  assert.equal(restoreText(protectedText.masked, protectedText.protectedValues), source);
  assert.ok(!protectText(source, false).protectedValues.includes("KYOTO"));
  assert.ok(!protectText("[CITY] = KYOTO\n\nDepict [CITY] at sunrise.", true).protectedValues.includes("KYOTO"));
});
test("JSON keys, nesting and non-string parameters survive translated values", () => {
  const jsonItem = { ...item, prompt: JSON.stringify({ prompt: "Create a portrait of {subject}", seed: 42, model: "custom_model_v2", aspect_ratio: "16:9", style_preset: "cinematic", html: "<h1>Hello</h1>", style: ["Soft light", { color_space: "sRGB", enabled: true }] }) };
  const cache = emptyTranslationCache();
  cache.segments["zh-Hans"] = Object.fromEntries(promptSegments(jsonItem).map(segment => [segment.id, "中文说明" + [...segment.text.matchAll(/⟦PP\d+⟧/g)].map(match => match[0]).join(" ")]));
  const translated = localizePrompt(jsonItem, "zh-Hans", cache)!;
  const parsed = JSON.parse(translated.prompt);
  assert.equal(parsed.seed, 42);
  assert.equal(parsed.model, "custom_model_v2"); assert.equal(parsed.aspect_ratio, "16:9"); assert.equal(parsed.style_preset, "cinematic"); assert.equal(parsed.html, "<h1>Hello</h1>");
  assert.equal(parsed.style[1].enabled, true);
  assert.deepEqual(Object.keys(parsed), ["prompt", "seed", "model", "aspect_ratio", "style_preset", "html", "style"]);
  assert.match(parsed.prompt, /\{subject\}/);
});
test("multiline captions and explicit-language dialogue remain literal without freezing scene directions", () => {
  const source = "语言：中文\n女主自然开口：\n\n“欢迎……\n今天去哪？”\n\n字幕逐字显示：\n“欢迎……\n今天去哪？”\n\n她轻轻挥手，然后走向门口。";
  const result = protectText(source, true);
  assert.deepEqual(result.protectedValues, ["“欢迎……\n今天去哪？”", "“欢迎……\n今天去哪？”"]);
  assert.match(result.masked, /她轻轻挥手/);
  assert.equal(restoreText(result.masked, result.protectedValues), source);
  assert.equal(protectText(source, false).protectedValues.length, 0);
  const english = protectText('Dialogue must be in Japanese.\nThe narrator whispers:\n\n「明日、また会おう。」\nThe camera pulls back.', true);
  assert.ok(english.protectedValues.includes('「明日、また会おう。」'));
  assert.match(english.masked, /The camera pulls back/);
});
test("unquoted on-screen typography stops before the next visual instruction", () => {
  const source = "Large neon typography appears:\n\nFOLLOW THE LIGHT.\nFIND YOUR WAY.\nUse slow camera moves throughout.\n\nTEXT REQUIREMENTS:\nKEEP BACKGROUND CLEAN";
  const result = protectText(source, true);
  assert.deepEqual(result.protectedValues, ["FOLLOW THE LIGHT.", "FIND YOUR WAY."]);
  assert.match(result.masked, /Use slow camera moves/);
  assert.match(result.masked, /KEEP BACKGROUND CLEAN/);
  assert.equal(restoreText(result.masked, result.protectedValues), source);
  assert.deepEqual(protectText(source, false).protectedValues, []);
  const template = "Below the scene, include vintage typography:\n\n[PLACE]\nNo. [NUMBER] [DESCRIPTION]\nYear: 2040\n\nTypography should use a serif font.";
  const fields = protectText(template, true);
  assert.deepEqual(fields.protectedValues, ["[PLACE]", "No. [NUMBER] [DESCRIPTION]", "Year: 2040"]);
  assert.match(fields.masked, /Typography should use a serif font/);
  assert.equal(restoreText(fields.masked, fields.protectedValues), template);
});
test("JSON quality enums stay opaque while descriptive quality prose is translated", () => {
  const description = "Detailed texture, natural lighting, and realistic materials.";
  const prose = { ...item, prompt: JSON.stringify({ quality: description, variant: { quality: "high" } }) };
  const segments = promptSegments(prose);
  assert.ok(segments.some(segment => segment.text === description));
  assert.ok(!segments.some(segment => segment.text === "high"));
  const cache = emptyTranslationCache();
  cache.segments["zh-Hans"] = Object.fromEntries(segments.map(segment => [segment.id, "详细质感，自然光线与真实材质。" + [...segment.text.matchAll(/⟦PP\d+⟧/g)].map(match => match[0]).join(" ")]));
  const result = JSON.parse(localizePrompt(prose, "zh-Hans", cache)!.prompt);
  assert.equal(result.variant.quality, "high"); assert.notEqual(result.quality, description);
});
test("localization keeps original fields and rejects partial or malformed cache records", () => {
  const cache = fillCache();
  const translated = attachTranslations([item], cache)[0];
  assert.equal(translated.prompt, item.prompt);
  assert.equal(translated.localization?.sourceFingerprint, translationFingerprint(item));
  assert.equal(translated.localization?.translations.en?.prompt, item.prompt);
  delete cache.segments.en[promptSegments(item)[0].id];
  assert.equal(localizePrompt(item, "en", cache), undefined);
  const bad = fillCache("zh-Hans");
  bad.segments["zh-Hans"][promptSegments(item).find(segment => segment.text.includes("⟦PP"))!.id] = "只有中文而没有占位符";
  assert.equal(localizePrompt(item, "zh-Hans", bad), undefined);
});
test("source and editorial changes invalidate records while unchanged segments remain reusable", () => {
  const cache = fillCache();
  assert.equal(translationBatches([item], cache, ["en"]).length, 0);
  const changed = { ...item, summary: item.summary + "Use a warm background." };
  assert.notEqual(translationFingerprint(item), translationFingerprint(changed));
  assert.equal(translationBatches([changed], cache, ["en"])[0].segments.length, 1);
  assert.equal(localizePrompt(changed, "en", cache), undefined);
});
test("wrong target script and oversized translation cannot be published", () => {
  assert.throws(() => validateSegment("Create a beautiful portrait with soft lighting.", "Create a beautiful portrait with soft lighting.", "zh-Hans"));
  const english = "Create the illustration you requested with your chosen subject, and keep the background that you provided.";
  assert.throws(() => validateSegment(english, english, "de"), /foreign-language/);
  const chinese = "请生成一张人物图片，使用柔和的光线，并保持背景简洁。";
  assert.throws(() => validateSegment(chinese, chinese, "en"));
  assert.doesNotThrow(() => validateSegment("动物连帽衫、粉色碗和热烤盘，组成热闹的小厨房。", "Animal hoodies, a pink bowl, and a hot griddle create a lively little kitchen.", "en"));
  const cache = fillCache();
  cache.segments.en[promptSegments(item)[0].id] = "x".repeat(251);
  assert.equal(localizePrompt(item, "en", cache), undefined);
});
test("request budget is persisted before provider execution and unchanged reruns cost no requests", async () => {
  const cache = emptyTranslationCache();
  let reserved = false, requests = 0;
  const report = await runTranslations({ items: [item], cache, locales: ["en"], providerName: "codex", maxRequests: 1,
    persist: async (_cache, report) => { reserved = report.attempted > 0; },
    provider: async (_locale, segments) => { assert.equal(reserved, true); requests++; return { translations: segments.map(segment => ({ id: segment.id, text: segment.text })) }; } });
  assert.equal(requests, 1); assert.equal(report.pendingSegments, 0);
  await runTranslations({ items: [item], cache, locales: ["en"], providerName: "codex", persist: async () => {}, provider: async () => { throw new Error("Must not call"); } });
});
test("invalid outputs stay uncached and failures retry only within bounds", async () => {
  const cache = emptyTranslationCache();
  let attempts = 0;
  const report = await runTranslations({ items: [item], cache, locales: ["en"], providerName: "codex", maxAttempts: 2, maxRequests: 2,
    persist: async () => {}, provider: async () => { attempts++; throw new Error("Temporary network failure"); } });
  assert.equal(attempts, 2); assert.equal(report.failed, 2); assert.deepEqual(cache.segments, {});
  const invalid = await runTranslations({ items: [item], cache, locales: ["en"], providerName: "codex", persist: async () => {}, provider: async (_locale, segments) => ({ translations: segments.map(segment => ({ id: segment.id, text: "" })) }) });
  assert.ok(invalid.rejected > 0); assert.equal(localizePrompt(item, "en", cache), undefined);
});
test("unsupported model/auth failure stops globally without spending retry budget", async () => {
  let attempts = 0;
  await assert.rejects(runTranslations({ items: [item], cache: emptyTranslationCache(), locales: ["en", "zh-Hans", "ja"], providerName: "codex", concurrency: 1,
    persist: async () => {}, provider: async () => { attempts++; throw new TranslationProviderError("Unavailable model", true); } }), /Unavailable model/);
  assert.equal(attempts, 1);
});
test("persistence failure stops reservations and drains active requests before returning", async () => {
  let writes = 0, started = 0, finished = 0;
  await assert.rejects(runTranslations({ items: [item], cache: emptyTranslationCache(), locales: ["en", "zh-Hans", "ja"], providerName: "codex", concurrency: 2,
    persist: async () => { if (++writes === 2) throw new Error("Disk write failed"); },
    provider: async (_locale, segments) => {
      started++;
      await new Promise(resolve => setTimeout(resolve, 30));
      finished++;
      return { translations: segments.map(segment => ({ id: segment.id, text: segment.text })) };
    } }), /Disk write failed/);
  assert.equal(started, 1); assert.equal(finished, 1); assert.equal(writes, 2);
});
test("API dollar reservation blocks unaffordable calls", async () => {
  let calls = 0;
  const report = await runTranslations({ items: [item], cache: emptyTranslationCache(), locales: ["en"], providerName: "openai", maxUSD: 0.001,
    persist: async () => {}, provider: async () => { calls++; return { translations: [] }; } });
  assert.equal(calls, 0); assert.equal(report.attempted, 0);
});
test("daily-sized budgets distribute batches fairly across requested locales", async () => {
  const calls: string[] = [];
  await runTranslations({ items: [{ ...item, prompt: "x".repeat(2400) }], cache: emptyTranslationCache(), locales: ["zh-Hans", "ja", "ko"], fairLocales: true,
    providerName: "codex", concurrency: 1, maxCharacters: 1000, maxRequests: 3, persist: async () => {},
    provider: async (locale, segments) => { calls.push(locale); return { translations: segments.map(segment => ({ id: segment.id, text: (locale === "ko" ? "한국어" : "中文").repeat(100) + [...segment.text.matchAll(/⟦PP\d+⟧/g)].map(match => match[0]).join(" ") })) }; } });
  assert.deepEqual(calls, ["zh-Hans", "ja", "ko"]);
});
test("validated bundled localizations survive missing cache, stale or corrupt ones do not", () => {
  const localized = attachTranslations([item], fillCache())[0];
  assert.ok(attachTranslations([localized], emptyTranslationCache())[0].localization?.translations.en);
  const stale = { ...localized, summary: "A changed editorial purpose." };
  assert.equal(attachTranslations([stale], emptyTranslationCache())[0].localization, undefined);
  const broken = structuredClone(localized);
  broken.localization!.translations.en!.prompt = "A prompt with removed placeholders.";
  assert.equal(attachTranslations([broken], emptyTranslationCache())[0].localization, undefined);
});
test("rebuilt records retain valid online locales with missing or partial cache but reject changed sources", () => {
  const previous = attachTranslations([item], fillCache())[0];
  const rebuilt = inheritPreviousTranslations([item], [previous]);
  assert.deepEqual(attachTranslations(rebuilt, emptyTranslationCache())[0].localization?.translations.en, previous.localization?.translations.en);
  const partial = fillCache();
  delete partial.segments.en[promptSegments(item)[0].id];
  assert.deepEqual(attachTranslations(rebuilt, partial)[0].localization?.translations.en, previous.localization?.translations.en);
  assert.equal(attachTranslations(inheritPreviousTranslations([{ ...item, prompt: item.prompt + " Changed." }], [previous]), emptyTranslationCache())[0].localization, undefined);
  const broken = structuredClone(previous);
  broken.localization!.translations.en!.prompt = "Removed required syntax";
  assert.equal(attachTranslations(inheritPreviousTranslations([item], [broken]), emptyTranslationCache())[0].localization, undefined);
});
test("inherited opaque syntax remasks atomically with duplicate and overlapping values", () => {
  const sample = { ...item, prompt: "Open `file0.py` and use 0 items. Then use 0 items with `long 0`." };
  assert.equal(validLocalizedText(sample, "en", sample), true);
  assert.equal(validLocalizedText(sample, "en", { ...sample, prompt: "Use 0 items with `long 0`, then open `file0.py` and use 0 items." }), true);
  assert.equal(validLocalizedText(sample, "en", { ...sample, prompt: "Open `file0.py` and use 10 items. Then use 0 items with `long 0`." }), false);
  assert.equal(validLocalizedText(sample, "en", { ...sample, prompt: sample.prompt + " 0" }), true);
  assert.equal(validLocalizedText(sample, "en", { ...sample, prompt: sample.prompt + " `file0.py`" }), false);
  const unit = { ...item, prompt: "Show 12秒 and two things at 4K." };
  assert.equal(validLocalizedText(unit, "en", { ...unit, prompt: "Show 12seconds and 2 things at 4K." }), true);
});
test("completeness rejects drastic same-script omissions without rejecting Chinese compression", () => {
  const han = "沿着废弃的航道寻找灯塔，观察守塔人、楼梯、旧照片与远处闪烁的灯光。".repeat(6);
  assert.throws(() => validateSegment(han, "沿着废弃的航道寻找灯塔。", "zh-Hant"), /omit substantial/);
  const english = "Describe the keeper, the stairs, the photographs, the abandoned shipping routes, and the distant lights in the detailed scene. ".repeat(3);
  assert.doesNotThrow(() => validateSegment(english, "详细描述守塔人、楼梯、照片、废弃航道与远处灯光，营造完整场景，并且保留画面中的所有细节。".repeat(2), "zh-Hans"));
});
test("translation preserves explicitly requested output languages and bilingual tasks", () => {
  assert.throws(() => validateSegment("用轻松的中文回答。", "편안한 한국어로 답하세요.", "ko"), /language requirement/);
  assert.doesNotThrow(() => validateSegment("用轻松的中文回答。", "편안한 중국어로 답하세요.", "ko"));
  assert.throws(() => validateSegment("Translate the English text into Chinese and retain both languages.", "英語のテキストを日本語に翻訳し、両方の言語を残してください。", "ja"), /language requirement/);
  assert.doesNotThrow(() => validateSegment("Translate the English text into Chinese and retain both languages.", "英語のテキストを中国語に翻訳し、両方の言語を残してください。", "ja"));
  assert.doesNotThrow(() => validateSegment("A classic English coastal painting.", "Une peinture côtière britannique classique.", "fr"));
});
test("daily staging only reads cache unless explicitly enabled and busy runs make no model call", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { prepareDailyTranslations } = await import("./translation-daily.ts");
  const root = await mkdtemp(join(tmpdir(), "prompix-translation-test-"));
  try {
    await mkdir(join(root, "translations"));
    await writeFile(join(root, "translations/cache.json"), JSON.stringify(fillCache()));
    const cached = await prepareDailyTranslations([item], root, {});
    assert.equal(cached.report.status, "cached"); assert.equal(cached.report.coverage.en, 1);
    assert.equal(cached.report.pendingRecords["zh-Hans"], 1);
    const dryRun = await prepareDailyTranslations([item], root, { PROMPIX_TRANSLATION_PROVIDER: "codex", PROMPIX_CODEX: "/this-command-must-not-run" }, false);
    assert.equal(dryRun.report.status, "cached"); assert.equal(dryRun.report.coverage.en, 1);
    await mkdir(join(root, "translations/run.lock"));
    const busy = await prepareDailyTranslations([item], root, { PROMPIX_TRANSLATION_PROVIDER: "codex", PROMPIX_CODEX: "/this-command-must-not-run" });
    assert.equal(busy.report.status, "busy"); assert.equal(busy.report.coverage.en, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("identity reuse requires confident language evidence and preserves every original byte", async () => {
  const { knownTextLocale, seedOriginalSegments } = await import("./translation.ts");
  assert.equal(knownTextLocale("Create the illustration you requested with your chosen subject, and keep the background that you provided."), "en");
  assert.equal(knownTextLocale("请生成一张人物图片，使用柔和的光线，并保持背景简洁。"), "zh-Hans");
  assert.equal(knownTextLocale("請生成一張人物圖片，使用柔和的光線，並保持背景簡潔。"), undefined);
  assert.equal(knownTextLocale("映画のような人物画像を作成し、背景の光を保持してください。"), undefined);
  assert.equal(knownTextLocale("映画人物構図背景画像画国人物背景写真美術映画人物画像構図"), undefined);
  assert.equal(knownTextLocale("请生成图片。 You are the artist with your creative vision and this detailed instruction."), undefined);
  assert.equal(knownTextLocale("Erstelle eine detaillierte Illustration und bewahre die Beleuchtung der angegebenen Szene."), undefined);
  const original = { ...item, prompt: "  Create the illustration you requested with your chosen subject, and keep the background that you provided.\n\n" };
  const cache = emptyTranslationCache();
  assert.ok(seedOriginalSegments([original], cache) >= 1);
  const segment = promptSegments(original).find(segment => segment.text.startsWith("  Create"))!;
  assert.equal(cache.segments.en[segment.id], original.prompt);
  assert.equal(cache.provenance?.en[segment.id].provider, "original");
});
test("daily publication rejects corrupt or unreadable caches and allows absent cache", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { prepareDailyTranslations } = await import("./translation-daily.ts");
  const root = await mkdtemp(join(tmpdir(), "prompix-corrupt-cache-test-"));
  const path = join(root, "translations/cache.json");
  try {
    assert.equal((await prepareDailyTranslations([item], root, {})).report.total, 1);
    await mkdir(join(root, "translations"));
    for (const content of ["{broken", JSON.stringify({ version: "obsolete", segments: {} })]) {
      await writeFile(path, content);
      await assert.rejects(prepareDailyTranslations([item], root, {}), /publication stopped/);
    }
    await rm(path);
    await mkdir(path);
    await assert.rejects(prepareDailyTranslations([item], root, {}), /publication stopped/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("language requirements use local clauses and exclude fruit and visual styles", () => {
  assert.doesNotThrow(() => validateSegment("A peeled mandarin orange under warm studio lighting. No text.", "Una mandarina pelada bajo una cálida luz de estudio. Sin texto.", "es"));
  assert.doesNotThrow(() => validateSegment("Write detailed design notes. Choose a Japanese photobook aesthetic.", "詳しいデザインノートを書いてください。日本の写真集の美学を選んでください。", "ja"));
  assert.doesNotThrow(() => validateSegment("保留图中文字和配色。", "Preserve the lettering in the image and its colors.", "en"));
  assert.doesNotThrow(() => validateSegment("Chinese lettering, natural colors.", "Tipografía china, colores naturales.", "es"));
  assert.doesNotThrow(() => validateSegment("一题一题练日语 N5 汉字", "Practice JLPT N5 kanji one question at a time.", "en"));
  assert.throws(() => validateSegment("若希望中文回答，请用中文回复。", "日本語で回答してほしい場合は、日本語で返答してください。", "ja"), /language requirement/);
});
test("syntax documentation does not imply a French language requirement", () => {
  for (const source of ["参考官方语法文档，检查工作流配置。", "參考官方語法文件，檢查工作流程設定。"]) {
    assert.doesNotThrow(() => validateSegment(source, "Refer to the official syntax documentation and check the workflow configuration.", "en"));
  }
  assert.throws(() => validateSegment("Use French documentation.", "使用官方语法文档。", "zh-Hans"), /explicit fr language requirement/);
  assert.doesNotThrow(() => validateSegment("Use French documentation.", "使用法文语法文档。", "zh-Hans"));
});
test("French instructions remain required alongside syntax documentation", () => {
  for (const language of ["法文", "法语", "法語"]) {
    const source = `请用${language}回答。`;
    assert.doesNotThrow(() => validateSegment(source, "Please answer in French.", "en"));
    assert.throws(() => validateSegment(source, "Please answer in English.", "en"), /explicit fr language requirement/);
  }
  for (const [source, translation] of [
    ["请提供法文文档。", "Please provide French documentation."],
    ["請提供法文文件。", "Please provide French documentation."],
    ["参考官方语法文档，并用法文回答。", "Refer to the official syntax documentation and answer in French."],
    ["參考官方語法文件，並用法文回答。", "Refer to the official syntax documentation and answer in French."],
  ]) {
    assert.doesNotThrow(() => validateSegment(source, translation, "en"));
    assert.throws(() => validateSegment(source, translation.replace("French", "English"), "en"), /explicit fr language requirement/);
  }
});
test("visual lettering remains exact while style quotations and prose still translate", () => {
  const text = '海报标题“上海早安”，标语“从早餐开始”。采用“爆炸图”风格。角落有“关注”按钮。';
  const visual = protectText(text, true);
  assert.deepEqual(visual.protectedValues, ['“上海早安”', '“从早餐开始”', '“关注”']);
  assert.match(visual.masked, /“爆炸图”/);
  assert.deepEqual(protectText('标题“上海早安”，采用“爆炸图”风格。', true).protectedValues, ['“上海早安”']);
  assert.equal(restoreText(visual.masked, visual.protectedValues), text);
  assert.deepEqual(protectText(text).protectedValues, []);
  const poster = { ...item, kind: "image" as const, prompt: 'Write the title "GOOD MORNING" above "SHANGHAI".' };
  const segment = promptSegments(poster).find(segment => segment.text.startsWith("Write"))!;
  assert.equal(segment.text, 'Write the title ⟦PP0⟧ above ⟦PP1⟧.');
  const count = promptSegments({ ...item, prompt: 'Draw 1 turn of the camera.' }).find(segment => segment.text.startsWith("Draw"))!;
  assert.equal(count.numericHints?.["⟦PP0⟧"], "1");
});
test("semantic reviews invalidate only exact rejected outputs and reject repeated bad responses", async () => {
  const { createHash } = await import("node:crypto");
  const { applyTranslationReviews, validateReviewedTranslation } = await import("./translation-review.ts");
  const segment = promptSegments(item)[0], cache = fillCache();
  const reviews = [{ locale: "en", segmentID: segment.id, translationSHA256: createHash("sha256").update(segment.text).digest("hex"), reason: "Missing required clause" }];
  assert.equal(applyTranslationReviews(cache, reviews), 1);
  assert.throws(() => validateReviewedTranslation(reviews, "en", segment.id, segment.text), /Semantic review/);
  cache.segments.en[segment.id] = "A corrected portrait title";
  assert.equal(applyTranslationReviews(cache, reviews), 0);
  assert.doesNotThrow(() => validateReviewedTranslation(reviews, "en", segment.id, cache.segments.en[segment.id]));
  assert.throws(() => validateSegment("超写实电影场景", "초현실적인 영화 장면", "ko"), /Hyperrealism/);
  assert.doesNotThrow(() => validateSegment("超现实场景中的超写实纹理", "초현실적인 장면 속 극사실적인 질감", "ko"));
});
test("rejected published translations and repeated provider responses cannot bypass semantic reviews", async () => {
  const { createHash } = await import("node:crypto");
  const cache = fillCache(), segment = promptSegments(item)[0];
  const reviews = [{ locale: "en", segmentID: segment.id, translationSHA256: createHash("sha256").update(segment.text).digest("hex"), reason: "Reviewed semantic omission" }];
  const published = attachTranslations([item], cache)[0];
  assert.equal(attachTranslations([published], emptyTranslationCache(), reviews)[0].localization, undefined);
  delete cache.segments.en[segment.id];
  const report = await runTranslations({ items: [item], cache, reviews, locales: ["en"], providerName: "codex", maxRequests: 1,
    persist: async () => {}, provider: async (_locale, segments) => ({ translations: segments.map(part => ({ id: part.id, text: part.text })) }) });
  assert.equal(report.rejected, 1); assert.equal(cache.segments.en[segment.id], undefined);
  assert.equal(attachTranslations([published], cache, reviews)[0].localization, undefined);
});
test("opaque numeric hints retain singular camera-motion grammar", () => {
  assert.throws(() => validateSegment("慢慢绕⟦PP0⟧圈", "Gira lentamente ⟦PP0⟧ vueltas", "es", { "⟦PP0⟧": "1" }), /Singular/);
  assert.throws(() => validateSegment("慢慢绕⟦PP0⟧圈", "Gira lentamente ⟦PP0⟧ vezes", "pt-BR", { "⟦PP0⟧": "1" }), /Singular/);
  assert.doesNotThrow(() => validateSegment("慢慢绕⟦PP0⟧圈", "Gira lentamente ⟦PP0⟧ vuelta", "es", { "⟦PP0⟧": "1" }));
  assert.doesNotThrow(() => validateSegment("慢慢绕⟦PP0⟧圈", "Gira lentamente ⟦PP0⟧ vueltas", "es", { "⟦PP0⟧": "2" }));
});
test("human bracket headings, narrative and descriptor arrays translate while placeholders remain opaque", () => {
  const source = '[风格]\n[保持人物五官与原图完全一致。] [14 秒] [IMAGE_URL] [主题] [00:00-00:05]\n["电影摄影", "照片级真实感"]';
  const result = protectText(source);
  assert.deepEqual(result.protectedValues, ['14', '[IMAGE_URL]', '[主题]', '[00:00-00:05]']);
  assert.match(result.masked, /\[风格\]/);
  assert.deepEqual(protectText('把[风格]替换为[写下喜欢的摄影风格]。').protectedValues, ['[风格]']); assert.match(result.masked, /保持人物五官/); assert.match(result.masked, /电影摄影/);
  assert.equal(restoreText(result.masked, result.protectedValues), source);
  const sample = 'My first sentence is "istanbulu cok seviyom burada olmak cok guzel"';
  assert.deepEqual(protectText(sample).protectedValues, ['"istanbulu cok seviyom burada olmak cok guzel"']);
});
test("clear bracket guidance translates while embedded parameters, numbers and URLs remain exact", () => {
  const source = '[写下最近在意的一件事] [Enter your name] [write your {subject} using ${color}, {{name}}, 2 notes at https://example.com/input ]';
  const protectedText = protectText(source);
  assert.deepEqual(protectedText.protectedValues, ['{subject}', '${color}', '{{name}}', '2', 'https://example.com/input']);
  assert.equal(protectedText.masked, '[写下最近在意的一件事] [Enter your name] [write your ⟦PP0⟧ using ⟦PP1⟧, ⟦PP2⟧, ⟦PP3⟧ notes at ⟦PP4⟧ ]');
  assert.equal(restoreText(protectedText.masked, protectedText.protectedValues), source);
  for (const instruction of ['自由写下所有念头', '请输入图片', '列出日常事件', 'describe a memory without private details']) {
    assert.deepEqual(protectText(`[${instruction}]`).protectedValues, []);
  }
});
test("guidance classification preserves identifiers, ambiguous noun labels, code and literal lettering", () => {
  const identifiers = ['[主题]', '[输入法]', '[描述符]', '[输入_URL]', '[描述_字段]', '[输入-field]', '[IMAGE_URL]', '[WRITE_YOUR_PROMPT]', '[input_value]', '[writeFile]', '[00:00-00:05]'];
  assert.deepEqual(protectText(identifiers.join(' ')).protectedValues, identifiers);
  const code = '`[Enter your name]`\n```json\n{"prompt":"[写下你的想法]"}\n```';
  const protectedCode = protectText(code);
  assert.deepEqual(protectedCode.protectedValues, ['`[Enter your name]`', '```json\n{"prompt":"[写下你的想法]"}\n```']);
  assert.equal(restoreText(protectedCode.masked, protectedCode.protectedValues), code);
  const caption = 'Draw the label "[Enter your name]" beside the title "[写下你的想法]".';
  assert.deepEqual(protectText(caption, true).protectedValues, ['"[Enter your name]"', '"[写下你的想法]"']);
  const nested = '[enter your value using [IMAGE_URL]]';
  const protectedNested = protectText(nested);
  assert.equal(protectedNested.masked, '⟦PP0⟧]');
  assert.equal(restoreText(protectedNested.masked, protectedNested.protectedValues), nested);
  assert.ok(!protectedNested.masked.includes('IMAGE_URL'), 'Nested square-bracket instructions remain opaque instead of exposing the inner identifier');
});
test("unambiguously foreign bracket guidance is rejected without rejecting shared Han or ambiguous Latin wording", () => {
  for (const locale of ['en', 'zh-Hant', 'ja', 'ko', 'es', 'pt-BR', 'fr', 'de'] as const) {
    assert.throws(() => validateSegment('[写下最近在意的一件事]', 'Guidance: [写下最近在意的一件事]', locale), /untranslated/);
  }
  for (const locale of ['zh-Hans', 'zh-Hant', 'ja', 'ko', 'es', 'pt-BR', 'fr', 'de'] as const) {
    assert.throws(() => validateSegment('[Enter your name]', 'Guidance: [Enter your name]', locale), /untranslated bracket guidance/);
  }
  assert.doesNotThrow(() => validateSegment('[写下最近在意的一件事]', '[写下最近在意的一件事]', 'zh-Hans'));
  assert.doesNotThrow(() => validateSegment('[写下最近在意的一件事]', '[寫下最近在意的一件事]', 'zh-Hant'));
  assert.doesNotThrow(() => validateSegment('[写下最近在意的一件事]', '[最近気になっていることを一つ書いてください]', 'ja'));
  for (const locale of ['zh-Hant', 'ja'] as const) assert.doesNotThrow(() => validateSegment('[提供素材]', '[提供素材]', locale));
  assert.deepEqual(protectText('[輸入商品の説明]').protectedValues, ['[輸入商品の説明]']);
  assert.doesNotThrow(() => validateSegment('[輸入商品の説明]', '[輸入商品の説明]', 'ja'));
  assert.doesNotThrow(() => validateSegment('[輸入素材]', '[輸入素材]', 'ja'));
  assert.doesNotThrow(() => validateSegment('[Describe ideas]', '[Describe ideas]', 'es'));
  assert.doesNotThrow(() => validateSegment('[Enter your name]', '[Enter your name]', 'en'));
});
test("the bundled tarot Japanese translation must translate its input guidance without changing its source", async () => {
  const catalog = catalogSchema.parse(JSON.parse(await readFile(new URL('../ios/Prompix/Resources/catalog.json', import.meta.url), 'utf8')));
  const tarot = catalog.prompts.find(prompt => prompt.id === 'gentle-tarot')!;
  const sourceBytes = JSON.stringify(tarot), fingerprint = translationFingerprint(tarot);
  const existing = tarot.localization!.translations.ja!;
  assert.ok(existing.prompt.includes('[写下最近在意的一件事]'));
  assert.equal(validLocalizedText(tarot, 'ja', existing), false);
  const corrected = { ...existing, prompt: existing.prompt.replace('[写下最近在意的一件事]', '[最近気になっていることを一つ書いてください]') };
  assert.equal(validLocalizedText(tarot, 'ja', corrected), true);
  assert.equal(translationFingerprint(tarot), fingerprint);
  assert.equal(JSON.stringify(tarot), sourceBytes);
});
test("JSON guidance values translate while identical JSON keys and code remain unchanged", () => {
  const source = { ...item, prompt: JSON.stringify({ '[Enter your name]': '[Enter your name] for {user_name}',
    code: 'const value = "[Enter your name]";', model: 'custom_model', seed: 42 }) };
  const cache = emptyTranslationCache();
  cache.segments.fr = Object.fromEntries(promptSegments(source).map(segment => [segment.id,
    segment.sourceText === '[Enter your name] for {user_name}' ? '[Saisissez votre nom] pour ⟦PP0⟧' : segment.text]));
  const translated = JSON.parse(localizePrompt(source, 'fr', cache)!.prompt);
  assert.deepEqual(Object.keys(translated), ['[Enter your name]', 'code', 'model', 'seed']);
  assert.equal(translated['[Enter your name]'], '[Saisissez votre nom] pour {user_name}');
  assert.equal(translated.code, 'const value = "[Enter your name]";');
  assert.equal(translated.model, 'custom_model'); assert.equal(translated.seed, 42);
});
test("new guidance masks rebuild only the affected field and reject both inherited and fresh untranslated output", async () => {
  const { createHash } = await import('node:crypto');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const source = { ...item, kind: 'text' as const, prompt: 'Prompt: [写下最近在意的一件事]. Keep {subject}.' };
  const legacyMask = 'Prompt: ⟦PP0⟧. Keep ⟦PP1⟧.', legacyID = hash(legacyMask);
  const segments = promptSegments(source), guidance = segments.find(segment => segment.sourceText === source.prompt)!;
  assert.equal(guidance.text, 'Prompt: [写下最近在意的一件事]. Keep ⟦PP0⟧.');
  assert.notEqual(guidance.id, legacyID);
  const cache = emptyTranslationCache();
  cache.segments.en = Object.fromEntries(segments.filter(segment => segment.id !== guidance.id).map(segment => [segment.id, segment.text]));
  cache.segments.en[legacyID] = legacyMask;
  const provenance = { provider: 'existing', model: 'existing-model', generatedAt: '2026-10-12T00:00:00Z' };
  cache.provenance = { en: Object.fromEntries(Object.keys(cache.segments.en).map(id => [id, { ...provenance }])) };
  const untouched = structuredClone(cache);
  const inherited = { ...source, localization: { sourceLanguage: 'zh', sourceFingerprint: translationFingerprint(source),
    translations: { en: { title: source.title, summary: source.summary, prompt: source.prompt, example: source.example,
      previewLabel: source.previewLabel, cover: { text: source.cover.text, eyebrow: source.cover.eyebrow } } } } };
  assert.deepEqual(translationBatches([inherited], cache, ['en']).flatMap(job => job.segments.map(segment => segment.id)), [guidance.id]);
  const bad = await runTranslations({ items: [inherited], cache, locales: ['en'], providerName: 'codex', maxRequests: 1,
    persist: async () => {}, provider: async (_locale, pending) => ({ translations: pending.map(segment => ({ id: segment.id,
      text: 'Rephrased guidance: [写下最近在意的一件事]. Keep ⟦PP0⟧.' })) }) });
  assert.equal(bad.rejected, 1); assert.equal(cache.segments.en[guidance.id], undefined);
  assert.equal(attachTranslations([inherited], cache)[0].localization?.translations.en, undefined);
  const good = await runTranslations({ items: [inherited], cache, locales: ['en'], providerName: 'codex', maxRequests: 1,
    persist: async () => {}, provider: async (_locale, pending) => ({ translations: pending.map(segment => ({ id: segment.id,
      text: 'Prompt: [Write down one thing you have been thinking about]. Keep ⟦PP0⟧.' })) }) });
  assert.equal(good.succeeded, 1);
  assert.ok(attachTranslations([inherited], cache)[0].localization?.translations.en?.prompt.includes('[Write down'));
  for (const [id, value] of Object.entries(untouched.segments.en)) {
    assert.equal(cache.segments.en[id], value); assert.deepEqual(cache.provenance!.en[id], untouched.provenance!.en[id]);
  }
});
test("verified same-fingerprint inherited records need no paid rebuilding but untranslated bracket prose does", async () => {
  const published = attachTranslations([item], fillCache())[0];
  assert.equal(translationBatches([published], emptyTranslationCache(), ["en"]).length, 0);
  const report = await runTranslations({ items: [published], cache: emptyTranslationCache(), locales: ["en"], providerName: "codex", persist: async () => {},
    provider: async () => { throw new Error("Must reuse verified published translation"); } });
  assert.equal(report.attempted, 0);
  assert.ok(translationBatches([{ ...published, summary: "An updated summary." }], emptyTranslationCache(), ["en"]).length > 0);
  const paragraph = '[保持参考图像中人物的外貌，并完整保留所有面部特征。]';
  const source = { ...item, prompt: `请绘制一幅人物肖像。${paragraph}` };
  const text = { title: item.title, summary: item.summary, prompt: `Create a cinematic portrait with careful lighting. ${paragraph}`, example: item.example, previewLabel: item.previewLabel, cover: { text: item.cover.text, eyebrow: item.cover.eyebrow } };
  const falselyCompleted = { ...source, localization: { sourceLanguage: "zh", sourceFingerprint: translationFingerprint(source), translations: { en: text } } };
  assert.equal(validLocalizedText(source, "en", text), false);
  assert.equal(attachTranslations([falselyCompleted], emptyTranslationCache())[0].localization, undefined);
  assert.ok(translationBatches([falselyCompleted], emptyTranslationCache(), ["en"]).length > 0);
  const reviewed = promptSegments(item)[0];
  const { createHash } = await import("node:crypto");
  const reviews = [{ locale: "en", segmentID: reviewed.id, translationSHA256: createHash("sha256").update(reviewed.text).digest("hex"), reason: "Known semantic defect" }];
  assert.ok(translationBatches([published], emptyTranslationCache(), ["en"], 12000, 160, reviews).length > 0);
});
test("semantic rejection survives a new protection mask and blocks inherited and fresh outputs", async () => {
  const { createHash } = await import("node:crypto");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const source = { ...item, prompt: "Create a portrait using @Image1." };
  const cache = emptyTranslationCache(); cache.segments.en = Object.fromEntries(promptSegments(source).map(segment => [segment.id, segment.text]));
  const published = attachTranslations([source], cache)[0];
  const reviewed = promptSegments(source).find(segment => segment.text.startsWith("Create"))!;
  const reviews = [{ locale: "en", segmentID: "c".repeat(64), translationSHA256: hash(source.prompt), sourceSHA256: hash(source.prompt), renderedTranslationSHA256: hash(source.prompt), reason: "Previously rejected before reference masking" }];
  assert.equal(attachTranslations([published], cache, reviews)[0].localization, undefined);
  assert.ok(translationBatches([published], cache, ["en"], 12000, 160, reviews).length > 0);
  const report = await runTranslations({ items: [published], cache, reviews, locales: ["en"], providerName: "codex", maxRequests: 1, persist: async () => {},
    provider: async (_locale, segments) => { assert.ok(segments.find(segment => segment.id === reviewed.id)?.reviewFeedback?.length); return { translations: segments.map(segment => ({ id: segment.id, text: segment.text })) }; } });
  assert.equal(report.rejected, 1); assert.equal(attachTranslations([published], cache, reviews)[0].localization, undefined);
});
test("repeated literal captions and nested placeholders remain atomically valid", () => {
  const source = { ...item, prompt: '标题“{dishLeft}”，旁边绘制“{dishLeft}”的成品。文字“Focus.”，另一处标有“Focus.”。' };
  const cache = emptyTranslationCache();cache.segments.en = Object.fromEntries(promptSegments(source).map(segment => [segment.id, segment.text]));
  const literal = protectText(source.prompt, true);
  assert.equal(literal.protectedValues.filter(value => value === '“{dishLeft}”').length, 2);
  assert.equal(literal.protectedValues.filter(value => value === '“Focus.”').length, 2);
  const text = { title: source.title, summary: source.summary, prompt: 'Title “{dishLeft}”, beside the finished “{dishLeft}” dish. Text “Focus.”, and another label “Focus.”.', example: source.example, previewLabel: source.previewLabel, cover: { text: source.cover.text, eyebrow: source.cover.eyebrow } };
  assert.equal(validLocalizedText(source, "en", text), true);
  assert.equal(validLocalizedText(source, "en", { ...text, prompt: text.prompt + ' “Focus.”' }), false);
});
test("shared masked IDs retain every restored review context regardless of source order", async () => {
  const { createHash } = await import("node:crypto");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const first = { ...item, id: "first", prompt: "Create a portrait using @Image1." };
  const second = { ...item, id: "second", prompt: "Create a portrait using @Image2." };
  const reviewed = promptSegments(first).find(segment => segment.sourceText === first.prompt)!;
  assert.equal(promptSegments(second).find(segment => segment.sourceText === second.prompt)!.id, reviewed.id);
  const reviews = [{ locale: "en", segmentID: "d".repeat(64), translationSHA256: hash(first.prompt), sourceSHA256: hash(first.prompt), renderedTranslationSHA256: hash(first.prompt), reason: "Rejected first source only" }];
  for (const items of [[first, second], [second, first]]) {
    const cache = emptyTranslationCache(); cache.segments.en = Object.fromEntries(items.flatMap(promptSegments).map(segment => [segment.id, segment.text]));
    assert.equal(translationBatches(items, cache, ["en"], 12000, 160, reviews).flatMap(job => job.segments).length, 1);
    const report = await runTranslations({ items, cache, reviews, locales: ["en"], providerName: "codex", maxRequests: 1, persist: async () => {},
      provider: async (_locale, segments) => { assert.ok(segments[0].reviewFeedback?.includes("Rejected first source only")); return { translations: segments.map(segment => ({ id: segment.id, text: segment.text })) }; } });
    assert.equal(report.rejected, 1);
  }
});
test("reviewed minimal corrections bind exact source and output and preserve newer cache work", async () => {
  const { applyReviewedCorrections } = await import("./translation-corrections.ts");
  const { createHash } = await import("node:crypto");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const protectedText = protectText(item.prompt, true);
  const originalMasked = protectedText.masked;
  const correctedMasked = originalMasked.replace("Create a portrait", "Create a detailed portrait");
  const correction = { id: item.id, locale: "en", field: "prompt", source: item.prompt, sourceSHA256: hash(item.prompt), segmentID: hash(originalMasked),
    originalTranslation: item.prompt, originalTranslationSHA256: hash(item.prompt), originalMaskedTranslationSHA256: hash(originalMasked),
    correctedTranslation: restoreText(correctedMasked, protectedText.protectedValues), correctedMaskedTranslation: correctedMasked, reason: "Reviewed wording correction" };
  const cache = emptyTranslationCache();cache.segments.en = { [correction.segmentID]: originalMasked };
  assert.equal(applyReviewedCorrections([item], cache, [correction], "reviewer-model").applied.length, 1);
  assert.equal(cache.provenance?.en[correction.segmentID].provider, "agent-reviewed");
  assert.equal(applyReviewedCorrections([item], cache, [correction], "reviewer-model").skipped.length, 1);
  assert.equal(cache.segments.en[correction.segmentID], correctedMasked);
  assert.throws(() => applyReviewedCorrections([{ ...item, prompt: item.prompt + " Changed." }], cache, [correction], "reviewer-model"), /source binding/);
  assert.throws(() => applyReviewedCorrections([item], cache, [{ ...correction, correctedMaskedTranslation: correctedMasked.replace("⟦PP0⟧", "missing") }], "reviewer-model"), /token|protect/);
});
test("numeric character limits cannot become word limits", () => {
  for (const [locale, wrong, correct] of [["en", "words", "characters"], ["es", "palabras", "caracteres"], ["pt-BR", "palavras", "caracteres"], ["fr", "mots", "caractères"], ["de", "Wörter", "Zeichen"], ["ja", "単語", "文字"], ["ko", "단어", "자"]] as const) {
    const source = "Write approximately ⟦PP0⟧ 字.";
    assert.throws(() => validateSegment(source, `Use ⟦PP0⟧ ${wrong}.`, locale), /Character limit/);
    assert.doesNotThrow(() => validateSegment(source, `Use ⟦PP0⟧ ${correct}.`, locale));
    assert.doesNotThrow(() => validateSegment("Write ⟦PP0⟧ words.", `Use ⟦PP0⟧ ${wrong}.`, locale));
  }
  assert.throws(() => validateSegment("Write ⟦PP0⟧ characters.", "Écrivez ⟦PP0⟧ mots.", "fr"), /Character limit/);
  assert.throws(() => validateSegment("写 ⟦PP0⟧ 字", "⟦PP0⟧ 単語", "ja"), /Character limit/);
});
test("same-item masked duplicates preserve every source-field semantic review", async () => {
  const { createHash } = await import("node:crypto"); const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const source = { ...item, title: "Turn 1 time.", prompt: "Turn 2 time.", example: "Turn 2 time.", previewLabel: "Turn 2 time." };
  const segment = promptSegments(source).find(segment => segment.sourceText === source.title)!;
  assert.ok(segment.contexts?.some(context => context.sourceText === source.prompt));
  const cache = emptyTranslationCache(); cache.segments.fr = Object.fromEntries(promptSegments(source).map(segment => [segment.id, segment.text === "Turn ⟦PP0⟧ time." ? "Tourner ⟦PP0⟧ fois." : segment.text]));
  const reviews = [{ locale: "fr", segmentID: "e".repeat(64), translationSHA256: hash("old mask"), sourceSHA256: hash(source.title), renderedTranslationSHA256: hash("Tourner 1 fois."), reason: "Rejected title only" }];
  assert.equal(translationBatches([source], cache, ["fr"], 12000, 160, reviews).flatMap(job => job.segments).length, 1);
});
test("daily inherits the validated completed local artifact with absent cache and rejects source changes or corruption", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { prepareDailyTranslations } = await import("./translation-daily.ts");
  const root = await mkdtemp(join(tmpdir(), "prompix-local-complete-test-"));
  try {
    await mkdir(join(root, "translations"));
    const template = JSON.parse(await readFile(new URL("../ios/Prompix/Resources/catalog.json", import.meta.url), "utf8"));
    await writeFile(join(root, "translations/catalog.localized.json"), JSON.stringify({ ...template, prompts: attachTranslations([item], fillCache()) }));
    const result = await prepareDailyTranslations([item], root, { PROMPIX_TRANSLATION_PROVIDER: "codex", PROMPIX_CODEX: "/must-not-run" }, false);
    assert.equal(result.report.coverage.en, 1); assert.equal(result.report.status, "cached");
    assert.equal((await prepareDailyTranslations([{ ...item, prompt: item.prompt + " Changed." }], root, {}, false)).report.coverage.en, 0);
    await writeFile(join(root, "translations/catalog.localized.json"), "{broken");
    await assert.rejects(prepareDailyTranslations([item], root, {}, false));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("daily translation default leaves only the unspent part of 36 requests and preserves explicit lower limits", async () => {
  const { mkdtemp, mkdir, writeFile, rm, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { prepareDailyTranslations } = await import("./translation-daily.ts");
  const { translationVersion } = await import("./translation.ts");
  const root = await mkdtemp(join(tmpdir(), "prompix-translation-throughput-"));
  try {
    const day = new Date().toISOString().slice(0, 10), directory = join(root, "translations", "daily-budgets");
    const ledgerPath = join(directory, `${day}.json`), callsPath = join(root, "synthetic-calls.txt");
    await mkdir(directory, { recursive: true });
    await writeFile(ledgerPath, JSON.stringify({ version: translationVersion, provider: "codex", attempted: 35,
      succeeded: 0, rejected: 0, failed: 0, pendingSegments: 0, reservedUSD: 0, measuredUSD: null,
      inputTokens: 120, outputTokens: 60, failures: [] }));
    const explicit = await prepareDailyTranslations([item], root, { PROMPIX_TRANSLATION_PROVIDER: "codex",
      PROMPIX_TRANSLATION_MAX_REQUESTS: "12", PROMPIX_CODEX: "/must-not-run" });
    assert.equal(explicit.report.status, "updated"); assert.equal(explicit.report.attempted, 35);
    const executable = join(root, "synthetic-translation-provider.cjs");
    // Returns an incomplete response to leave pending work without contacting a model.
    await writeFile(executable, `#!${process.execPath}
const fs = require("node:fs");
process.stdin.resume();
process.stdin.on("end", () => {
  const ledger = JSON.parse(fs.readFileSync(${JSON.stringify(ledgerPath)}, "utf8"));
  if (ledger.attempted !== 36) process.exit(2);
  fs.appendFileSync(${JSON.stringify(callsPath)}, "called\\n");
  fs.writeFileSync(process.argv[process.argv.indexOf("--output-last-message") + 1], JSON.stringify({ translations: [] }));
});
`);
    await chmod(executable, 0o700);
    const environment = { PROMPIX_TRANSLATION_PROVIDER: "codex", PROMPIX_CODEX: executable };
    const result = await prepareDailyTranslations([item], root, environment);
    assert.equal(result.report.status, "updated"); assert.equal(result.report.attempted, 36);
    assert.equal(result.report.measuredUSD, null);
    assert.equal(await readFile(callsPath, "utf8"), "called\n");
    const repeat = await prepareDailyTranslations([item], root, { ...environment, PROMPIX_TRANSLATION_LOCALES: "zh-Hans,en" });
    assert.equal(repeat.report.attempted, 36); assert.equal(await readFile(callsPath, "utf8"), "called\n");
    const saved = JSON.parse(await readFile(ledgerPath, "utf8"));
    assert.equal(saved.inputTokens, 120); assert.equal(saved.outputTokens, 60);
    assert.equal(saved.day, day);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("daily translation rejects invalid locale selections before invoking a provider", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { prepareDailyTranslations } = await import("./translation-daily.ts");
  const root = await mkdtemp(join(tmpdir(), "prompix-translation-locales-"));
  try {
    for (const locales of ["", "en,en", "en,", "zh", "en,unknown"]) {
      const result = await prepareDailyTranslations([item], root, {
        PROMPIX_TRANSLATION_PROVIDER: "codex", PROMPIX_CODEX: "/must-not-run", PROMPIX_TRANSLATION_LOCALES: locales,
      });
      assert.equal(result.report.status, "failed");
      assert.match(result.report.error!, /distinct supported locale codes/);
      assert.deepEqual(Object.keys(result.report.coverage), [...translationLocales]);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("daily translation sends only selected locales and keeps cached other languages", async () => {
  const { mkdtemp, mkdir, writeFile, rm, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { prepareDailyTranslations } = await import("./translation-daily.ts");
  const root = await mkdtemp(join(tmpdir(), "prompix-translation-selection-"));
  try {
    await mkdir(join(root, "translations"));
    await writeFile(join(root, "translations/cache.json"), JSON.stringify(fillCache("en")));
    const executable = join(root, "provider.cjs"), calls = join(root, "calls.jsonl");
    await writeFile(executable, `#!${process.execPath}
const fs = require("node:fs"); let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input.trim().split("\\n").at(-1));
  fs.appendFileSync(${JSON.stringify(calls)}, request.locale + "\\n");
  fs.writeFileSync(process.argv[process.argv.indexOf("--output-last-message") + 1], JSON.stringify({ translations: [] }));
});

`);
    await chmod(executable, 0o700);
    const result = await prepareDailyTranslations([item], root, {
      PROMPIX_TRANSLATION_PROVIDER: "codex", PROMPIX_CODEX: executable,
      PROMPIX_TRANSLATION_LOCALES: " zh-Hans ", PROMPIX_TRANSLATION_MAX_REQUESTS: "1",
    });
    assert.equal(result.report.status, "updated"); assert.equal(result.report.attempted, 1);
    assert.equal(await readFile(calls, "utf8"), "zh-Hans\n");
    assert.equal(result.report.coverage.en, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("exhausted transient translation failures remain visible to monitoring without replaying spent budget", async () => {
  const { mkdtemp, writeFile, rm, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { prepareDailyTranslations } = await import("./translation-daily.ts");
  const root = await mkdtemp(join(tmpdir(), "prompix-translation-failure-"));
  try {
    const executable = join(root, "fail.cjs");
    await writeFile(executable, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on("end", () => process.exit(1));\n`);
    await chmod(executable, 0o700);
    const env = { PROMPIX_TRANSLATION_PROVIDER: "codex", PROMPIX_CODEX: executable,
      PROMPIX_TRANSLATION_LOCALES: "ja", PROMPIX_TRANSLATION_MAX_REQUESTS: "1" };
    const failed = await prepareDailyTranslations([item], root, env);
    assert.equal(failed.report.status, "partial"); assert.equal(failed.report.failed, 1);
    const repeated = await prepareDailyTranslations([item], root, env);
    assert.equal(repeated.report.attempted, 1); assert.equal(repeated.report.failed, 1);
    assert.equal(repeated.report.status, "updated", "Old failures must not masquerade as another failed run");
  } finally { await rm(root, { recursive: true, force: true }); }
});
