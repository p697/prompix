import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prompt } from "../packages/schema/catalog.ts";
import { promptSegments, protectText, restoreText, translationFingerprint, validateSegment, type TranslationCache, type TranslationLocale } from "./translation.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const sha = z.string().regex(/^[a-f0-9]{64}$/);
function sourceValue(field: string, path?: string): unknown {
  if (!path) return field;
  let value: unknown = JSON.parse(field);
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error("Correction JSON path mismatch");
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
const correctionSchema = z.array(z.object({
  id: z.string(), locale: z.enum(["en", "zh-Hans", "zh-Hant", "ja", "ko", "es", "pt-BR", "fr", "de"]),
  field: z.enum(["title", "summary", "prompt", "example", "previewLabel"]), source: z.string(), sourceSHA256: sha,
  segmentID: sha, originalTranslation: z.string(), originalTranslationSHA256: sha, originalMaskedTranslationSHA256: sha,
  correctedTranslation: z.string(), correctedMaskedTranslation: z.string(), reason: z.string().min(1), jsonPath: z.string().regex(/^[\w-]+(?:\.[\w-]+)*$/).optional(),
}).strict());
/** Call while holding the translation cache lock. Exact bindings prevent overwriting newer work. */
export function applyReviewedCorrections(items: readonly Prompt[], cache: TranslationCache, input: unknown, reviewerModel: string) {
  const corrections = correctionSchema.parse(input);
  const applied: string[] = [], skipped: string[] = [];
  for (const correction of corrections) {
    const label = `${correction.id}/${correction.locale}/${correction.field}`;
    const item = items.find(item => item.id === correction.id);
    const original = item ? sourceValue(item[correction.field], correction.jsonPath) : undefined;
    if (!item || original !== correction.source || digest(correction.source) !== correction.sourceSHA256 || digest(correction.originalTranslation) !== correction.originalTranslationSHA256) throw new Error(`Correction source binding mismatch: ${label}`);
    const source = protectText(correction.source, item.kind === "image" || item.kind === "video");
    if (digest(source.masked) !== correction.segmentID || restoreText(correction.correctedMaskedTranslation, source.protectedValues) !== correction.correctedTranslation) throw new Error(`Correction protection mismatch: ${label}`);
    if (!promptSegments(item).some(segment => segment.id === correction.segmentID)) throw new Error(`Correction is not a translatable source value: ${label}`);
    const existing = cache.segments[correction.locale]?.[correction.segmentID];
    const inherited = item.localization?.sourceFingerprint === translationFingerprint(item) ? item.localization.translations[correction.locale]?.[correction.field] : undefined;
    const inheritedMatches = existing === undefined && inherited !== undefined && sourceValue(inherited, correction.jsonPath) === correction.originalTranslation;
    if (!inheritedMatches && (existing === undefined || digest(existing) !== correction.originalMaskedTranslationSHA256 || restoreText(existing, source.protectedValues) !== correction.originalTranslation)) { skipped.push(label); continue; }
    const hints = Object.fromEntries(source.protectedValues.flatMap((value, index) => /^\d/.test(value) ? [[`⟦PP${index}⟧`, value]] : []));
    validateSegment(source.masked, correction.correctedMaskedTranslation, correction.locale as TranslationLocale, hints);
    (cache.segments[correction.locale] ??= {})[correction.segmentID] = correction.correctedMaskedTranslation;
    ((cache.provenance ??= {})[correction.locale] ??= {})[correction.segmentID] = { provider: "agent-reviewed", model: reviewerModel, generatedAt: new Date().toISOString() };
    applied.push(label);
  }
  return { applied, skipped };
}
