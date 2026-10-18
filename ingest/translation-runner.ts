import { applyTranslationReviews, validateReviewedTranslation, validateReviewedTranslationField, translationReviewFeedback, type TranslationRejection } from "./translation-review.ts";
import type { Prompt } from "../packages/schema/catalog.ts";
import { promptSegments, mergeSegmentContexts, translationFingerprint, validLocalizedText, restoreText, translationLocales, translationVersion, validateSegment, validateSemanticContext, seedOriginalSegments, type Segment, type TranslationCache, type TranslationLocale } from "./translation.ts";
import { TranslationProviderError, type TranslationProvider } from "./translation-provider.ts";

export type TranslationRunReport = { version: string; provider: string; attempted: number; succeeded: number; rejected: number; failed: number; pendingSegments: number;
  reservedUSD: number; measuredUSD: number | null; inputTokens: number; outputTokens: number; failures: { locale: string; ids: string[]; reason: string }[] };
function validateForEverySource(segment: Segment, translated: string, locale: TranslationLocale, reviews: readonly TranslationRejection[]) {
  if (segment.maxOutputCharacters !== undefined && translated.length > segment.maxOutputCharacters)
    throw new Error(`Translation exceeds display label limit of ${segment.maxOutputCharacters} masked characters`);
  validateSegment(segment.text, translated, locale, segment.numericHints);
  validateReviewedTranslation(reviews, locale, segment.id, translated);
  const contexts = [...(segment.contexts ?? []), ...(segment.sourceText !== undefined && segment.protectedValues ? [{ sourceText: segment.sourceText, protectedValues: segment.protectedValues, numericHints: segment.numericHints }] : [])];
  for (const context of contexts) {
    validateSegment(segment.text, translated, locale, context.numericHints);
    validateSemanticContext(context.sourceText, translated, locale, segment.semanticContext);
    validateReviewedTranslationField(reviews, locale, context.sourceText, restoreText(translated, context.protectedValues));
  }
}
export function translationBatches(items: readonly Prompt[], cache: TranslationCache, locales: readonly TranslationLocale[], maxCharacters = 12000, maxSegments = 160, reviews: readonly TranslationRejection[] = []) {
  const jobs: { locale: TranslationLocale; segments: Segment[] }[] = [];
  for (const locale of locales) {
    const unique = new Map<string, Segment>();
    for (const item of items) {
      const inherited = item.localization?.sourceFingerprint === translationFingerprint(item) ? item.localization.translations[locale] : undefined;
      if (inherited && validLocalizedText(item, locale, inherited, reviews)) continue;
      for (const segment of promptSegments(item)) {
        const previous = unique.get(segment.id);
        if (!previous) unique.set(segment.id, segment);
        else mergeSegmentContexts(previous, segment);
      }
    }
    let batch: Segment[] = [], characters = 0;
    for (const segment of unique.values()) {
      const existing = cache.version === translationVersion ? cache.segments[locale]?.[segment.id] : undefined;
      if (existing !== undefined) { try { validateForEverySource(segment, existing, locale, reviews);
        continue; } catch { /* Rebuild invalid cached translations. */ } }
      if (segment.text.length > 30000) throw new Error("Translation segment exceeds bounded request size");
      if (batch.length && (characters + segment.text.length > maxCharacters || batch.length >= maxSegments)) {
        jobs.push({ locale, segments: batch }); batch = []; characters = 0;
      }
      batch.push(segment); characters += segment.text.length;
    }
    if (batch.length) jobs.push({ locale, segments: batch });
  }
  return jobs;
}
export async function runTranslations(options: { items: readonly Prompt[]; cache: TranslationCache; provider: TranslationProvider; providerName: string; model?: string;
  persist: (cache: TranslationCache, report: TranslationRunReport) => Promise<void>; locales?: readonly TranslationLocale[]; fairLocales?: boolean; concurrency?: number; maxAttempts?: number; maxRequests?: number; maxUSD?: number; maxOutputTokens?: number; maxCharacters?: number; prior?: Partial<TranslationRunReport>; reviews?: readonly TranslationRejection[]; }): Promise<TranslationRunReport> {
  const { cache, provider } = options;
  const maxRequests = options.maxRequests ?? 500;
  const maxUSD = options.maxUSD ?? 5;
  const concurrency = options.concurrency ?? 2;
  const maxAttempts = options.maxAttempts ?? 2;
  const maximumConcurrency = options.providerName === "codex" ? 6 : 3;
  if (!Number.isInteger(maxRequests) || maxRequests < 0 || maxRequests > 1000 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > maximumConcurrency || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3 || !Number.isFinite(maxUSD) || maxUSD < 0) throw new Error("Invalid translation budget or concurrency");
  if (options.maxCharacters !== undefined && (!Number.isFinite(options.maxCharacters) || options.maxCharacters < 1000 || options.maxCharacters > 30000)) throw new Error("Invalid translation batch size");
  seedOriginalSegments(options.items, cache);
  applyTranslationReviews(cache, options.reviews ?? []);
  const locales = options.locales ?? translationLocales;
  const batches = translationBatches(options.items, cache, locales, options.maxCharacters, 160, options.reviews);
  for (const job of batches) job.segments = job.segments.map(segment => {
    const feedback = [segment.sourceText, ...(segment.contexts ?? []).map(context => context.sourceText)].flatMap(source => translationReviewFeedback(options.reviews ?? [], job.locale, segment.id, source));
    return feedback?.length ? { ...segment, reviewFeedback: [...new Set(feedback)] } : segment;
  });
  const jobs = options.fairLocales ? (() => {
    const queues = locales.map(locale => batches.filter(job => job.locale === locale));
    const interleaved: typeof batches = [];
    while (queues.some(queue => queue.length)) for (const queue of queues) { const job = queue.shift(); if (job) interleaved.push(job); }
    return interleaved;
  })() : batches;
  const report: TranslationRunReport = { version: translationVersion, provider: options.providerName, attempted: options.prior?.attempted ?? 0,
    succeeded: options.prior?.succeeded ?? 0, rejected: options.prior?.rejected ?? 0, failed: options.prior?.failed ?? 0,
    pendingSegments: jobs.reduce((total, job) => total + job.segments.length, 0), reservedUSD: options.prior?.reservedUSD ?? 0,
    measuredUSD: options.providerName === "openai" ? (options.prior?.measuredUSD ?? 0) : null, inputTokens: options.prior?.inputTokens ?? 0, outputTokens: options.prior?.outputTokens ?? 0, failures: [...(options.prior?.failures ?? [])] };
  let cursor = 0;
  let permanentFailure: Error | undefined;
  let persistenceFailure: Error | undefined;
  let writeQueue = Promise.resolve();
  const persist = () => {
    writeQueue = writeQueue.then(() => options.persist(cache, report)).catch(error => {
      persistenceFailure ??= error instanceof Error ? error : new Error("Translation persistence failed");
      throw persistenceFailure;
    });
    return writeQueue;
  };
  const worker = async () => {
    while (!permanentFailure && !persistenceFailure && cursor < jobs.length) {
      const job = jobs[cursor++];
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Reserve the conservative byte-based input bound and output cap before making a paid request.
        // A crashed/ambiguous request keeps its reservation on restart.
        if (permanentFailure || persistenceFailure) return;
        const reserved = (Buffer.byteLength(JSON.stringify(job)) + 8000) * 2 / 1_000_000 + (options.maxOutputTokens ?? 24000) * 10 / 1_000_000;
        if (report.attempted >= maxRequests || (options.providerName === "openai" && report.reservedUSD + reserved > maxUSD)) return;
        report.attempted++;
        if (options.providerName === "openai") report.reservedUSD += reserved;
        await persist();
        if (permanentFailure || persistenceFailure) return;
        try {
          const result = await provider(job.locale, job.segments);
          if (result.inputTokens !== undefined && result.outputTokens !== undefined) {
            report.inputTokens += result.inputTokens; report.outputTokens += result.outputTokens;
            if (options.providerName === "openai") report.measuredUSD = (report.measuredUSD ?? 0) + result.inputTokens * 2 / 1_000_000 + result.outputTokens * 10 / 1_000_000;
          }
          if (!Array.isArray(result.translations)) throw new Error("Missing translation array");
          const supplied = new Map(result.translations.map(value => [value.id, value.text]));
          if (supplied.size !== result.translations.length || result.translations.some(value => !job.segments.some(segment => segment.id === value.id))) throw new Error("Duplicate or unexpected translation ID");
          let valid = 0;
          for (const segment of job.segments) {
            const translated = supplied.get(segment.id);
            try {
              if (typeof translated !== "string") throw new Error("Missing translation");
              validateForEverySource(segment, translated, job.locale, options.reviews ?? []);
              (cache.segments[job.locale] ??= {})[segment.id] = translated;
              ((cache.provenance ??= {})[job.locale] ??= {})[segment.id] = { provider: options.providerName, model: options.model ?? "unknown", generatedAt: new Date().toISOString() };
              valid++;
            } catch (reason) { report.rejected++; report.failures.push({ locale: job.locale, ids: [segment.id], reason: reason instanceof Error ? reason.message : "Invalid translated segment" }); }
          }
          report.succeeded += valid;
          report.pendingSegments -= valid;
          await persist();
          // Valid partial results remain reusable. The next incremental run retries rejected segments only.
          break;
        } catch (error) {
          if (persistenceFailure) throw persistenceFailure;
          report.failed++;
          if (error instanceof TranslationProviderError && error.permanent) permanentFailure = error;
          report.failures.push({ locale: job.locale, ids: job.segments.map(segment => segment.id), reason: error instanceof Error ? error.message : "Translation failed" });
          await persist();
          if (permanentFailure) break;
          if (attempt + 1 < maxAttempts) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
    }
  };
  // Drain every active request before callers release the shared cache lock.
  const workers = await Promise.allSettled(Array.from({ length: concurrency }, worker));
  if (persistenceFailure) throw persistenceFailure;
  const rejectedWorker = workers.find(result => result.status === "rejected");
  if (rejectedWorker?.status === "rejected") throw rejectedWorker.reason;
  await persist();
  if (permanentFailure) throw permanentFailure;
  return report;
}
