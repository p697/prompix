import { validateReviewedTranslation, validateReviewedTranslationField, type TranslationRejection } from "./translation-review.ts";
import { createHash } from "node:crypto";
import type { Prompt } from "../packages/schema/catalog.ts";

export const translationLocales = ["en", "zh-Hans", "zh-Hant", "ja", "ko", "es", "pt-BR", "fr", "de"] as const;
export type TranslationLocale = typeof translationLocales[number];
export const translationVersion = "prompix-translation-1";
export type LocalizedText = Pick<Prompt, "title" | "summary" | "prompt" | "example" | "previewLabel"> & { cover?: { text: string; eyebrow: string } };
export type Localization = { sourceLanguage: string; sourceFingerprint: string; translations: Partial<Record<TranslationLocale, LocalizedText>> };
export type SegmentContext = { sourceText: string; protectedValues: string[]; numericHints?: Record<string, string> };
export type Segment = { id: string; text: string; numericHints?: Record<string, string>; reviewFeedback?: string[]; sourceText?: string; protectedValues?: string[]; contexts?: SegmentContext[] };
export function mergeSegmentContexts(target: Segment, incoming: Segment): void {
  const contexts = [...(incoming.contexts ?? []), ...(incoming.sourceText !== undefined && incoming.protectedValues ? [{ sourceText: incoming.sourceText, protectedValues: incoming.protectedValues, numericHints: incoming.numericHints }] : [])];
  for (const context of contexts) if (context.sourceText !== target.sourceText && !target.contexts?.some(existing => existing.sourceText === context.sourceText)) (target.contexts ??= []).push(context);
}
export type TranslationCache = { version: typeof translationVersion; segments: Record<string, Record<string, string>>;
  provenance?: Record<string, Record<string, { provider: string; model: string; generatedAt: string }>> };
export const emptyTranslationCache = (): TranslationCache => ({ version: translationVersion, segments: {} });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function translationText(item: Prompt): LocalizedText {
  return { title: item.title, summary: item.summary, prompt: item.prompt, example: item.example, previewLabel: item.previewLabel,
    ...(item.cover ? { cover: { text: item.cover.text, eyebrow: item.cover.eyebrow } } : {}) };
}
export function translationFingerprint(item: Prompt): string { return hash(JSON.stringify(translationText(item))); }
/** Identity reuse is conservative: ambiguous/mixed prose is still translated by a model. */
export function knownTextLocale(masked: string): "en" | "zh-Hans" | undefined {
  const prose = masked.replace(/⟦PP\d+⟧/g, "");
  const letters = prose.match(/\p{L}/gu) ?? [];
  if (letters.length < 20) return undefined;
  if (letters.every(letter => /^[A-Za-z]$/.test(letter))) {
    const words = prose.toLowerCase().match(/[a-z]+/g) ?? [];
    const strong = new Set(words.filter(word => /^(the|you|your|with|will|that|this)$/.test(word)));
    const grammar = words.filter(word => /^(the|you|your|with|will|that|this|and|of|to|for|from|are|should|without|while)$/.test(word));
    if (strong.size >= 3 && words.length >= 12 && grammar.length / words.length >= 0.13) return "en";
  }
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(prose) || /[這為個與圖畫體現譯簡觀創復轉說時種點書開變從讓過進應對來將請產維動線場]/u.test(prose)) return undefined;
  const han = letters.filter(letter => /\p{Script=Han}/u.test(letter)).length;
  const grammar = new Set(prose.match(/的|了|在|请|使用|生成|保持|不要|一个|可以|替换|适合|让|把|你|先|再|并|每|将/g) ?? []);
  if (han / letters.length >= 0.92 && /[这为个与图画体现译简观创复转说时种点书开变从让过进应对来将请产维动线场]/u.test(prose) && grammar.size >= 2 && !/[A-Za-z]{2,}(?:[ \t]+[A-Za-z]{2,}){3,}/.test(prose)) return "zh-Hans";
  return undefined;
}
export function seedOriginalSegments(items: readonly Prompt[], cache: TranslationCache): number {
  let reused = 0;
  for (const item of items) for (const segment of promptSegments(item)) {
    const locale = knownTextLocale(segment.text);
    if (!locale || cache.segments[locale]?.[segment.id] !== undefined) continue;
    (cache.segments[locale] ??= {})[segment.id] = segment.text;
    ((cache.provenance ??= {})[locale] ??= {})[segment.id] = { provider: "original", model: "none", generatedAt: new Date().toISOString() };
    reused++;
  }
  return reused;
}


/** Opaque syntax never goes to the model unprotected. JSON keys and primitives never become segments. */
function renderedLiterals(text: string, preserveLettering: boolean): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const quotes = /“[^”\n]+”|「[^」\n]+」|『[^』\n]+』|"[^"\n]+"|‘[^’\n]+’/gu;
  let previousEnd = -1;
  for (const match of text.matchAll(quotes)) {
    const start = match.index!, end = start + match[0].length;
    const before = text.slice(Math.max(0, start - 85), start).split(/[。.!?;；\n”」』"’]/).at(-1)!;
    const after = text.slice(end, end + 20);
    const caption = /文字|字体|字體|字样|字樣|文本|标语|標語|标注|標註|标有|標有|写着|寫著|标题|標題|标签|標籤|日期|笔记|筆記|\b(?:lettering|text|caption|slogan|label|title|headline|read|reads|say|says|written)\b/iu.test(before)
      || /^\s*(?:文字|字样|字樣|标题|標題|标签|標籤|按钮|按鈕|text|caption|label|button)/iu.test(after)
      || (previousEnd >= 0 && /^[\s,，、/]*(?:(?:and|or|above|below|under|beneath|over|next to|和|与|與|以及|上方|下方)[\s,，、/]*)?$/iu.test(text.slice(previousEnd, start)));
    const input = /(?:my first sentence is|first (?:input|sentence)\s*(?:is|:)|input (?:example|sentence|text)\s*:|我的第一句(?:话|話)?(?:是|：)|输入示例[：:]|輸入示例[：:])\s*$/iu.test(before);
    if (input || (preserveLettering && caption)) { ranges.push({ start, end }); previousEnd = end; }
    else previousEnd = -1;
  }
  // Treat repeated occurrences of the same literal consistently, including later
  // references to a caption. Otherwise a whole-quote token overlaps an inner placeholder.
  const literals = new Set(ranges.map(range => text.slice(range.start, range.end)));
  for (const match of text.matchAll(quotes)) if (literals.has(match[0]) && !ranges.some(range => range.start === match.index)) ranges.push({ start: match.index!, end: match.index! + match[0].length });
  return ranges;
}
/** Literal lettering in visual prompts is part of the image/video specification. */
export function protectText(text: string, preserveLettering = false) {
  if (/⟦PP\d+⟧/.test(text)) throw new Error("Source contains reserved translation tokens");
  const protectedValues: string[] = [];
  const opaque = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n)|```[\s\S]*?```|`[^`\n]+`|@[A-Za-z_][A-Za-z0-9_-]+|https?:\/\/[^\s<>"\]]+|\{argument\b[^}]*\}|\$\{[^}\n]+\}|\{\{[^}\n]+\}\}|\{[\p{L}\p{N}_ .-]{1,120}\}|\[[^\]\n]{1,160}\]|<\/?[A-Za-z_][A-Za-z0-9_ -]*>|--no[ \t]+[^\n.;]+?(?=[ \t]+--[a-z]|\r?\n|[.;]|$)|--[a-z][a-z0-9-]*(?:[ \t]+[A-Za-z0-9:_-]+(?:\.[A-Za-z0-9]+)*)?|\b(?:GPT[-\s]?[\d.]+(?:[-\w]+)?|DALL-E\s*\d*|Midjourney|Seedance|Stable Diffusion|FLUX|ChatGPT|YouMind)\b|\b\d+(?:[.,:]\d+)*(?:(?:万|千|亿|萬|億)|(?:%|px|fps|mm|cm|ms|s|w)?\b)/giu;
  const humanBracket = (body: string, start: number, end: number) => {
    const heading = /^\s*$/u.test(text.slice(0, start).split("\n").at(-1)!) && /^\s*(?:\r?\n|$)/u.test(text.slice(end));
    // A short action instruction can be a fill-in variable: preserve it unless
    // punctuation, a heading, a quantity, or a descriptive phrase proves otherwise.
    if (/\p{Script=Han}/u.test(body) && (body.length > 24 || /[，。！？：、]/u.test(body) || (heading && /^(?:风格|風格|场景|場景|人物|镜头细节|鏡頭細節)$/u.test(body)) || (body.length >= 8 && !/^(?:写下|寫下|输入|輸入|填写|填寫|选择|選擇|你的)/u.test(body) && /(?:拍摄|拍攝|风格|風格|音效|特效)/u.test(body)) || /^\d+\s*(?:秒|分钟|分鐘|帧|幀)$/u.test(body))) return true;
    if (/^\s*"/u.test(body) && /\p{Script=Han}/u.test(body)) return true;
    return /[a-z]+(?:\s+[a-z]+){3}/u.test(body) && /\b(?:the|you|your|with|is|are|keep|create)\b/iu.test(body);
  };
  const collectRanges = (part: string, offset = 0): { start: number; end: number }[] => [...part.matchAll(opaque)].flatMap(match => {
    const start = offset + match.index!;
    if (match[0].startsWith("[") && humanBracket(match[0].slice(1, -1), start, start + match[0].length)) return collectRanges(match[0].slice(1, -1), start + 1);
    return [{ start, end: start + match[0].length }];
  });
  const ranges = collectRanges(text);
  ranges.push(...renderedLiterals(text, preserveLettering));
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  let cursor = 0, masked = "";
  for (const range of ranges) {
    if (range.start < cursor) continue;
    masked += text.slice(cursor, range.start) + `⟦PP${protectedValues.length}⟧`;
    protectedValues.push(text.slice(range.start, range.end)); cursor = range.end;
  }
  masked += text.slice(cursor);
  return { masked, protectedValues };
}
export function restoreText(masked: string, protectedValues: readonly string[]): string {
  const tokens = [...masked.matchAll(/⟦PP(\d+)⟧/g)].map(m => Number(m[1])).sort((a, b) => a - b);
  if (tokens.length !== protectedValues.length || tokens.some((token, index) => token !== index)) {
    throw new Error("Translation changed, reordered or duplicated protected syntax");
  }
  return masked.replace(/⟦PP(\d+)⟧/g, (_, index) => protectedValues[Number(index)]);
}

const opaqueJSONKeys = new Set(["model", "model_id", "modelId", "seed", "steps", "cfg_scale", "sampler", "sampler_name", "scheduler", "aspect_ratio", "aspectRatio", "resolution", "size", "width", "height", "fps", "duration", "duration_seconds", "output_format", "response_format", "style_preset", "code", "html", "css", "javascript", "typescript", "script"]);
const opaqueJSONString = (key: string | undefined, value: string) => Boolean(key && (opaqueJSONKeys.has(key) || (key === "quality" && /^(auto|low|medium|high|standard|hd)$/i.test(value))));
function transformStrings(value: unknown, transform: (text: string) => string, key?: string): unknown {
  if (typeof value === "string") return opaqueJSONString(key, value) ? value : transform(value);
  if (Array.isArray(value)) return value.map(item => transformStrings(item, transform));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, transformStrings(item, transform, key)]));
  return value;
}
function visitText(text: string, transform: (text: string) => string): string {
  // Parse whole JSON prompts before translation. Keep exact original bytes if no value changed.
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object") {
      const result = transformStrings(value, transform);
      return JSON.stringify(value) === JSON.stringify(result) ? text : JSON.stringify(result, null, 2);
    }
  } catch { /* Plain natural language. */ }
  return transform(text);
}
function numericHints(values: readonly string[]): { numericHints?: Record<string, string> } {
  const hints = Object.fromEntries(values.flatMap((value, index) => /^\d+(?:[.,:]\d+)*(?:%|px|fps|mm|cm|ms|s|w|万|千|亿|萬|億)?$/i.test(value) ? [[`⟦PP${index}⟧`, value]] : []));
  return Object.keys(hints).length ? { numericHints: hints } : {};
}
export function promptSegments(item: Prompt): Segment[] {
  const segments = new Map<string, Segment>();
  const collect = (text: string) => {
    const { masked, protectedValues } = protectText(text, item.kind === "image" || item.kind === "video");
    if (/[\p{L}]/u.test(masked.replace(/⟦PP\d+⟧/g, ""))) {
      const segment = { id: hash(masked), text: masked, sourceText: text, protectedValues, ...numericHints(protectedValues) };
      const previous = segments.get(segment.id);
      if (previous) mergeSegmentContexts(previous, segment); else segments.set(segment.id, segment);
    }
    return text;
  };
  for (const [key, value] of Object.entries(translationText(item))) {
    if (key === "cover") { const cover = value as LocalizedText["cover"]; collect(cover!.text); collect(cover!.eyebrow); }
    else visitText(value as string, collect);
  }
  return [...segments.values()];
}
const humanLanguageNames = {
  zh: /(?<![图圖])中文|汉语|漢語|普通话|普通話|中国語|중국어|\b(?:chines\w*|chinois\w*|chin[eê]s\w*|chin[oa]\w*|mandarin)\b/iu,
  en: /英文|英语|英語|英会話|英単語|영어|\b(?:english|englisch\w*|anglais\w*|ingl[eéê]s\w*)\b/iu,
  ja: /日文|日语|日語|日本語|일본어|\bJLPT\b|\b(?:japan\w*|japon\w*)\b/iu,
  ko: /韩文|韩语|韓文|韓語|韓国語|한국어|\b(?:korean\w*|cor[eé]en\w*|corean\w*)\b/iu,
  es: /西班牙语|西班牙語|スペイン語|스페인어|\b(?:spanish|spanisch\w*|espa[ñgn]+ol\w*|espanh\w*)\b/iu,
  pt: /葡萄牙语|葡萄牙語|ポルトガル語|포르투갈어|\bportug[ui]\w*/iu,
  fr: /法语|法語|法文|フランス語|프랑스어|\b(?:french|fran[cç]ais\w*|franz[oö]s\w*|franc[eéê]s\w*)\b/iu,
  de: /德语|德語|德文|ドイツ語|독일어|\b(?:german|deutsch\w*|allemand\w*|alem[aáã]\w*)\b/iu,
};
function requiredHumanLanguages(source: string): (keyof typeof humanLanguageNames)[] {
  // Country/style adjectives are not language requirements. Inspect each local clause,
  // rather than combining an adjective with an unrelated "write" elsewhere in a Skill.
  return (Object.keys(humanLanguageNames) as (keyof typeof humanLanguageNames)[]).filter(key => {
    const matches = source.matchAll(new RegExp(humanLanguageNames[key].source, "giu"));
    for (const match of matches) {
      if (/[^\x00-\x7f]/.test(match[0])) return true;
      const index = match.index!;
      const before = source.slice(Math.max(0, index - 65), index).split(/[.!?;\n]/).at(-1)!;
      const after = source.slice(index + match[0].length, index + match[0].length + 40);
      if (/^\s+(?:orange|fruit|photobook|aesthetic|style|art|painting|architecture|garden|food|cuisine)\b/i.test(after)) continue;
      if (/\b(?:in|into|from|to|language|speak|speaking|learn|learning|teach|teaching|translate|translation|respond|answer|reply|write|writing|use)\s+(?:(?:natural|fluent|simple|casual|plain|the|only)\s+){0,3}$/i.test(before)
        || /^\s+(?:language|grammar|spelling|pronunciation|lettering|text|words|captions?|subtitles?|teacher|instructor|translator|responses?|replies|answers?|conversation)\b/i.test(after)
        || /\bJLPT\b/i.test(match[0])) return true;
    }
    return false;
  });
}
export function validateSegment(source: string, translated: string, locale: TranslationLocale, hints: Record<string, string> = {}): void {
  if (!translated.trim() || translated.length > Math.max(500, source.length * 6)) throw new Error("Empty or oversized translation");
  const placeholders = [...source.matchAll(/⟦PP(\d+)⟧/g)].map(m => Number(m[1]));
  restoreText(translated, placeholders.map(() => "opaque"));
  const prose = source.replace(/⟦PP\d+⟧/g, "");
  const outputProse = translated.replace(/⟦PP\d+⟧/g, "");
  for (const language of requiredHumanLanguages(prose)) if (!humanLanguageNames[language].test(outputProse)) throw new Error(`Translation changed explicit ${language} language requirement`);
  const wordUnits: Partial<Record<TranslationLocale, string>> = { en: "words?", es: "palabras?", "pt-BR": "palavras?", fr: "mots?", de: "W(?:ö|oe)rter|W(?:ö|oe)rtern", ja: "単語", ko: "단어" };
  if (wordUnits[locale]) for (const match of source.matchAll(/(⟦PP\d+⟧)\s*(?:个|個)?字(?!母|体|體|样|樣)|(?:(⟦PP\d+⟧)\s+characters?\b)/giu)) {
    const token = match[1] ?? match[2];
    if (new RegExp(`${token}\\s*(?:${wordUnits[locale]})(?:\\b|(?=[^A-Za-z])|$)`, "iu").test(translated)) throw new Error("Character limit mistranslated as word limit");
  }
  const sourceLetters = prose.match(/\p{L}/gu)?.length ?? 0;
  const sourceHan = prose.match(/\p{Script=Han}/gu)?.length ?? 0;
  const sourceLatin = prose.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (sourceLetters >= 100) {
    const outputLetters = outputProse.match(/\p{L}/gu)?.length ?? 0;
    const outputHan = outputProse.match(/\p{Script=Han}/gu)?.length ?? 0;
    const outputLatin = outputProse.match(/\p{Script=Latin}/gu)?.length ?? 0;
    if (outputLetters < sourceLetters * 0.15 || (locale.startsWith("zh") && sourceHan / sourceLetters > 0.7 && outputHan < sourceHan * 0.5) || (/^(en|es|pt-BR|fr|de)$/.test(locale) && sourceLatin / sourceLetters > 0.8 && outputLatin < sourceLatin * 0.45)) throw new Error("Translation may omit substantial source prose");
  }
  if (locale === "ko" && /超写实|超寫實|hyperreal/iu.test(prose) && !/超现实|超現實|surreal/iu.test(prose) && /초현실/u.test(outputProse)) throw new Error("Hyperrealism mistranslated as surrealism");
  for (const [token, value] of Object.entries(hints)) {
    if (value !== "1") continue;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if ((locale === "es" && new RegExp(`${escaped}\\s+vueltas\\b`, "u").test(translated)) || (locale === "pt-BR" && new RegExp(`${escaped}\\s+vezes\\b`, "u").test(translated)) || (locale === "fr" && new RegExp(`${escaped}\\s+tours\\b`, "u").test(translated)) || (locale === "de" && new RegExp(`${escaped}\\s+Kreise\\b`, "u").test(translated))) throw new Error("Singular count translated with plural motion unit");
  }
  for (const match of source.matchAll(/\[[^\]\n]+\]/gu)) {
    if (!/\p{Script=Han}/u.test(match[0]) || !translated.includes(match[0])) continue;
    const body = match[0].slice(1, -1);
    const simplified = /[这译简观创复转说时种点书开变从让过进应对来将请产维动线场风户镜细关]/u.test(body);
    if (/^(en|es|pt-BR|fr|de|ko)$/.test(locale) || ((locale === "zh-Hant" || locale === "ja") && simplified)) throw new Error("Translation retained untranslated human bracket prose");
    // Shared Japanese/Chinese kanji headings can be valid; full Chinese narrative cannot.
    if (locale === "ja" && knownTextLocale(body) === "zh-Hans") throw new Error("Translation retained untranslated human bracket prose");
  }
  const originalLocale = knownTextLocale(source);
  if (originalLocale && originalLocale !== locale && translated === source) throw new Error("Translation retained foreign-language source prose");
  if (/^(en|es|pt-BR|fr|de)$/.test(locale) && (prose.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0) >= 20 && (translated.replace(/⟦PP\d+⟧/g, "").match(/\p{Script=Latin}+/gu)?.length ?? 0) < 4) throw new Error("Translation lacks target-language prose");
  if (/[A-Za-z]{3}/.test(prose) && prose.length > 30 && /^(zh|ja|ko)/.test(locale)) {
    const expected = locale.startsWith("zh") ? /\p{Script=Han}/u : locale === "ja" ? /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u : /\p{Script=Hangul}/u;
    if (!expected.test(translated)) throw new Error("Translation lacks target-language script");
  }
}
export function localizePrompt(item: Prompt, locale: TranslationLocale, cache: TranslationCache, reviews: readonly TranslationRejection[] = []): LocalizedText | undefined {
  if (cache.version !== translationVersion) return undefined;
  const translate = (text: string) => {
    const { masked, protectedValues } = protectText(text, item.kind === "image" || item.kind === "video");
    if (!/[\p{L}]/u.test(masked.replace(/⟦PP\d+⟧/g, ""))) return text;
    const translated = cache.segments[locale]?.[hash(masked)];
    if (translated === undefined) throw new Error("Missing translation segment");
    validateSegment(masked, translated, locale, numericHints(protectedValues).numericHints);
    validateReviewedTranslation(reviews, locale, hash(masked), translated);
    const restored = restoreText(translated, protectedValues);
    validateReviewedTranslationField(reviews, locale, text, restored);
    return restored;
  };
  try {
    const original = translationText(item);
    const result = { title: visitText(original.title, translate), summary: visitText(original.summary, translate), prompt: visitText(original.prompt, translate),
      example: visitText(original.example, translate), previewLabel: visitText(original.previewLabel, translate),
      ...(original.cover ? { cover: { text: translate(original.cover.text), eyebrow: translate(original.cover.eyebrow) } } : {}) };
    if (result.title.length > 250 || result.summary.length > 4000 || result.prompt.length > 50000 || result.example.length > 50000 || result.previewLabel.length > 500 || (result.cover && (result.cover.text.length > 100 || result.cover.eyebrow.length > 40))) return undefined;
    return validLocalizedText(item, locale, result, reviews) ? result : undefined;
  } catch { return undefined; }
}
/** Revalidate inherited first-party/offline localizations before reusing them. */
export function validLocalizedText(item: Prompt, locale: TranslationLocale, translated: LocalizedText, reviews: readonly TranslationRejection[] = []): boolean {
  const check = (source: string, value: string) => {
    if (typeof value !== "string") throw new Error("Invalid translation field");
    validateReviewedTranslationField(reviews, locale, source, value);
    const protectedText = protectText(source, item.kind === "image" || item.kind === "video");
    if (/⟦PP\d+⟧/.test(value)) throw new Error("Inherited translation contains reserved syntax");
    const indices = new Map<string, number[]>();
    protectedText.protectedValues.forEach((text, index) => { indices.set(text, [...(indices.get(text) ?? []), index]); });
    const alternatives = [...indices.keys()].sort((a, b) => b.length - a.length).map(text => {
      const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return /^\d+(?:[.,:]\d+)*$/.test(text) ? `(?<![0-9])${escaped}(?![0-9])` : escaped;
    });
    // One pass over the original translated value: generated token digits cannot be rematched.
    const masked = alternatives.length ? value.replace(new RegExp(alternatives.join("|"), "gu"), text => {
      const index = indices.get(text)?.shift();
      // Natural prose may translate a written-out numeral to digits (or attach a translated unit).
      // The cache already validates opaque token multiplicity; inherited numeric matches need only
      // account for every original value, without mistaking additional prose numerals for tokens.
      if (index === undefined && /^\d+(?:[.,:]\d+)*(?:%|px|fps|mm|cm|ms|s)?$/i.test(text)) return text;
      if (index === undefined) throw new Error("Inherited translation duplicated opaque syntax");
      return `⟦PP${index}⟧`;
    }) : value;
    if ([...indices.values()].some(remaining => remaining.length)) throw new Error("Inherited translation changed opaque syntax");
    validateSegment(protectedText.masked, masked, locale, numericHints(protectedText.protectedValues).numericHints);
    validateReviewedTranslation(reviews, locale, hash(protectedText.masked), masked);
  };
  const compareJSON = (source: unknown, value: unknown, key?: string): void => {
    if (typeof source === "string") { if (opaqueJSONString(key, source)) { if (source !== value) throw new Error("Changed JSON model parameter"); } else check(source, value as string); return; }
    if (Array.isArray(source)) {
      if (!Array.isArray(value) || value.length !== source.length) throw new Error("Changed JSON array");
      source.forEach((part, index) => compareJSON(part, value[index])); return;
    }
    if (source && typeof source === "object") {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(source).sort().join("\0") !== Object.keys(value).sort().join("\0")) throw new Error("Changed JSON keys");
      for (const [key, part] of Object.entries(source)) compareJSON(part, (value as Record<string, unknown>)[key], key);
      return;
    }
    if (source !== value) throw new Error("Changed JSON parameter");
  };
  const checkField = (source: string, value: string) => {
    let parsed: unknown;
    try { parsed = JSON.parse(source); } catch { /* Plain text. */ }
    if (parsed && typeof parsed === "object") compareJSON(parsed, JSON.parse(value));
    else check(source, value);
  };
  try {
    const source = translationText(item);
    for (const field of ["title", "summary", "prompt", "example", "previewLabel"] as const) checkField(source[field], translated[field]);
    if (Boolean(source.cover) !== Boolean(translated.cover)) return false;
    if (source.cover && translated.cover) { check(source.cover.text, translated.cover.text); check(source.cover.eyebrow, translated.cover.eyebrow); }
    return translated.title.length <= 250 && translated.summary.length <= 4000 && translated.prompt.length <= 50000 && translated.example.length <= 50000 && translated.previewLabel.length <= 500 && (!translated.cover || (translated.cover.text.length <= 100 && translated.cover.eyebrow.length <= 40));
  } catch { return false; }
}
export function attachTranslations<T extends Prompt>(items: readonly T[], cache: TranslationCache, reviews: readonly TranslationRejection[] = []): T[] {
  return items.map(item => {
    const translations: Localization["translations"] = {};
    for (const locale of translationLocales) {
      const cached = localizePrompt(item, locale, cache, reviews);
      const inherited = (item as T & { localization?: Localization }).localization;
      const existing = inherited?.sourceFingerprint === translationFingerprint(item) ? inherited.translations[locale] : undefined;
      const text = cached ?? (existing && validLocalizedText(item, locale, existing, reviews) ? existing : undefined);
      if (text) translations[locale] = text;
    }
    // Mixed source/editorial languages are common. Do not mislabel the whole record English.
    const sourceLanguage = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(item.prompt) ? "ja" : /\p{Script=Hangul}/u.test(item.prompt) ? "ko" : /\p{Script=Han}/u.test(item.prompt) ? "zh" : (item.prompt.match(/\b(the|you|your|with|will|that|this)\b/gi)?.length ?? 0) >= 3 ? "en" : "und";
    const { localization: _old, ...original } = item as T & { localization?: Localization };
    return { ...original, ...(Object.keys(translations).length ? { localization: { sourceLanguage, sourceFingerprint: translationFingerprint(item), translations } } : {}) } as T;
  });
}
/** Retain verified published text across rebuilds, only while original source bytes match. */
export function inheritPreviousTranslations<T extends Prompt>(items: readonly T[], previous: readonly Prompt[]): T[] {
  const byID = new Map(previous.map(item => [item.id, item]));
  return items.map(item => {
    const prior = byID.get(item.id);
    if (!prior?.localization || prior.localization.sourceFingerprint !== translationFingerprint(item)) return item;
    const translations: Localization["translations"] = {};
    for (const candidate of [prior.localization, item.localization]) {
      if (candidate?.sourceFingerprint !== translationFingerprint(item)) continue;
      for (const locale of translationLocales) {
        const text = candidate.translations[locale];
        if (text && validLocalizedText(item, locale, text)) translations[locale] = text;
      }
    }
    return { ...item, localization: { ...prior.localization, translations } } as T;
  });
}
