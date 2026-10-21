import type { Prompt } from "../packages/schema/catalog.ts";
import { attachTranslations, emptyTranslationCache, promptSegments, validateSegment, translationFingerprint, validLocalizedText, type TranslationCache, type TranslationLocale } from "./translation.ts";
import type { TranslationRejection } from "./translation-review.ts";
export const requiredIngestLocales = ["zh-Hans"] as const;
export const ingestLanguagePolicy = "original-zh-Hans-v1";
/** Never overwrite the original. Other locales do not block ingest and are not advertised as ready. */
export function originalAndChinese(items: readonly Prompt[], cache: TranslationCache = emptyTranslationCache(), reviews: readonly TranslationRejection[] = []): Prompt[] {
  return attachTranslations(items, cache, reviews).map(item => {
    const chinese = item.localization?.translations["zh-Hans"];
    const { localization, ...original } = item;
    if (!localization || !chinese || !validLocalizedText(item, "zh-Hans", chinese, reviews)) return original;
    return { ...original, localization: { ...localization, translations: { "zh-Hans": chinese } } };
  });
}
export function hasRequiredTranslations(item: Prompt, reviews: readonly TranslationRejection[] = [], locales: readonly TranslationLocale[] = requiredIngestLocales): boolean {
  return item.localization?.sourceFingerprint === translationFingerprint(item) && locales.every(locale => {
    const text = item.localization?.translations[locale]; return !!text && validLocalizedText(item, locale, text, reviews);
  });
}

/** Only call after exact-source editorial approval. Its schema already requires Chinese metadata. */
export function seedApprovedChineseMetadata(items: readonly Prompt[], cache: TranslationCache): number {
  let count = 0;
  for (const item of items) for (const segment of promptSegments({ ...item, prompt: "" })) {
    const prose = segment.text.replace(/⟦PP\d+⟧/g, "");
    if (!/\p{Script=Han}/u.test(prose) || /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(prose)) continue;
    if (/[這為個與圖畫體現譯簡觀創復轉說時種點書開變從讓過進應對來將請產維動線場]/u.test(prose)) continue;
    if ((prose.match(/\p{Script=Han}/gu)?.length ?? 0) < (prose.match(/\p{L}/gu)?.length ?? 0) * 0.65) continue;
    // Reuse is optional: mixed-language metadata must enter normal translation.
    // Validation failure is not a provider failure and must not abort the batch.
    try { validateSegment(segment.text, segment.text, "zh-Hans", segment.numericHints); }
    catch { continue; }
    if (cache.segments["zh-Hans"]?.[segment.id] !== undefined) continue;
    (cache.segments["zh-Hans"] ??= {})[segment.id] = segment.text;
    ((cache.provenance ??= {})["zh-Hans"] ??= {})[segment.id] = { provider: "approved-editorial-original", model: "none", generatedAt: new Date().toISOString() };
    count++;
  }
  return count;
}
