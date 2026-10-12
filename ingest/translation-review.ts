import { createHash } from "node:crypto";
import { z } from "zod";
import { json } from "./publication.ts";
import type { TranslationCache, TranslationLocale } from "./translation.ts";

const reviewSchema = z.array(z.object({ locale: z.string(), segmentID: z.string().regex(/^[a-f0-9]{64}$/), translationSHA256: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().min(1), sourceSHA256: z.string().regex(/^[a-f0-9]{64}$/).optional(), renderedTranslationSHA256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().refine(item => Boolean(item.sourceSHA256) === Boolean(item.renderedTranslationSHA256), "Rendered review hashes must be provided together"));
export type TranslationRejection = z.infer<typeof reviewSchema>[number];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
/** Reviews invalidate the exact rejected output, so a corrected translation remains reusable. */
export async function readTranslationReviews(path: string): Promise<TranslationRejection[]> {
  return reviewSchema.parse(await json<unknown>(path, []));
}
export function validateReviewedTranslation(reviews: readonly TranslationRejection[], locale: TranslationLocale, segmentID: string, text: string): void {
  const found = reviews.find(review => review.locale === locale && review.segmentID === segmentID && review.translationSHA256 === hash(text));
  if (found) throw new Error(`Semantic review rejected translation: ${found.reason}`);
}
export function validateReviewedTranslationField(reviews: readonly TranslationRejection[], locale: TranslationLocale, source: string, translated: string): void {
  const sourceHash = hash(source), translatedHash = hash(translated);
  const found = reviews.find(review => review.locale === locale && review.sourceSHA256 === sourceHash && review.renderedTranslationSHA256 === translatedHash);
  if (found) throw new Error(`Semantic review rejected restored translation: ${found.reason}`);
}
export function translationReviewFeedback(reviews: readonly TranslationRejection[], locale: TranslationLocale, segmentID: string, source?: string): string[] {
  const sourceHash = source === undefined ? undefined : hash(source);
  return [...new Set(reviews.filter(review => review.locale === locale && (review.segmentID === segmentID || (sourceHash !== undefined && review.sourceSHA256 === sourceHash))).map(review => review.reason))];
}
export function applyTranslationReviews(cache: TranslationCache, reviews: readonly TranslationRejection[]): number {
  let removed = 0;
  for (const review of reviews) {
    const text = cache.segments[review.locale]?.[review.segmentID];
    if (text !== undefined && hash(text) === review.translationSHA256) {
      delete cache.segments[review.locale][review.segmentID];
      if (cache.provenance?.[review.locale]) delete cache.provenance[review.locale][review.segmentID];
      removed++;
    }
  }
  return removed;
}
