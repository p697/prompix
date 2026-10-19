import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { catalogSchema, type Prompt } from "../packages/schema/catalog.ts";
import { atomic, json, writeImmutableBytes } from "./publication.ts";
import { historyBatchSchema, historyCatalogSchema, historyLimits, completeHistoryItem, uniqueHistoryItems, type HistoryBatch } from "./history-cohort.ts";
import { admitXLeadSelection } from "./x-search-admission.ts";
import { readXIntake } from "./x-intake.ts";
import { applyEditorialReviews, reviewsSchema } from "./editorial.ts";
import { editorialCacheSchema, editorialLedgerSchema, editorialVersion, runEditorialReview } from "./editorial-runner.ts";
import { codexEditorialProvider } from "./editorial-provider.ts";
import { selectLibrary } from "./library.ts";
import { publicationText } from "./templates.ts";
import { websiteReviewer } from "./website-review.ts";
import { mirrorPromptMediaBatch } from "./mirror-media.ts";
import { runVisualReview, applyVisualPresentation, visualCacheSchema, visualLedgerSchema, visualReviewVersion } from "./visual-review.ts";
import { codexVisualProvider } from "./visual-provider.ts";
import { prepareVisualMedia } from "./visual-media.ts";
import { applyQualityHolds, readQualityHolds } from "./quality-holds.ts";
import { attachTranslations, translationLocales, type TranslationLocale } from "./translation.ts";
import { readTranslationCache } from "./translation-cache.ts";
import { readTranslationReviews } from "./translation-review.ts";
import { runTranslations, type TranslationRunReport } from "./translation-runner.ts";
import { requiredIngestLocales, originalAndChinese, seedApprovedChineseMetadata } from "./ingest-language-policy.ts";
import { verifyReviewedHistory } from "./history-stage-verification.ts";
import { codexTranslationProvider } from "./translation-provider.ts";

/** Run under the cohort lock. This stages artifacts only, and never activates a public release. */
export async function runHistoryBatch(directory: string, input: HistoryBatch, previous: Prompt[], sharedRoot: string, seedTranslations?: string, revalidate = false, options: { stage?: "source" | "review" | "translation"; chineseOnly?: boolean; translationConcurrency?: number; checkLease?: () => Promise<void> } = {}) {
  const batch = historyBatchSchema.parse(input), day = batch.createdAt.slice(0, 10), env = process.env;
  if (env.PROMPIX_X_DISCOVERY_PROVIDER !== "third-party" || env.PROMPIX_X_OFFICIAL_ENABLED !== "0" || env.X_BEARER_TOKEN ||
      env.PROMPIX_TRANSLATION_MODEL !== "gpt-6-luna" || env.PROMPIX_TRANSLATION_PROVIDER !== "codex" || !env.PROMPIX_CODEX)
    throw new Error("History requires explicit third-party-only and Codex gpt-6-luna configuration");
  const completed = await json<unknown>(join(directory, "complete.json"), null);
  if (completed && !options.stage) {
    historyCatalogSchema.parse(completed);
    if (!revalidate) return historyCatalogSchema.parse(completed).prompts;
    const retained = Buffer.from(JSON.stringify(completed, null, 2) + "\n");
    await writeImmutableBytes(join(directory, "quality-revisions", `complete-${createHash("sha256").update(retained).digest("hex")}.json`), retained);
  }
  const reportPath = join(directory, "report.json");
  const report: Record<string, unknown> = await json(reportPath, { startedAt: new Date().toISOString(), batch: batch.id, assigned: batch.leads.length, published: 0 });
  if (report.error) {
    report.priorErrors = [...(Array.isArray(report.priorErrors) ? report.priorErrors : []), { at: report.updatedAt, error: report.error }];
    delete report.error;
  }
  const phase = async (stage: string) => {
    const at = new Date().toISOString();
    report.phases = [...(Array.isArray(report.phases) ? report.phases : []), { stage, at }];
    report.stage = stage; report.updatedAt = at; await atomic(reportPath, report);
  };
  try {
    await options.checkLease?.();
    if (!options.stage || options.stage === "source") {
    await phase("source");
    const ledgers = await readdir(join(directory, "x-lead-acquisitions")).catch(e => { if (e.code === "ENOENT") return []; throw e; });
    for (const file of ledgers.filter(f => f.endsWith(".json"))) {
      const attempts = await json<{ state: string }[]>(join(directory, "x-lead-acquisitions", file), []);
      if (attempts.some(a => a.state === "reserved" || a.state === "failed")) throw new Error("Unresolved historical acquisition requires evidence recovery; no repeat request sent");
    }
    const admission = await admitXLeadSelection(directory, batch.leads, `history-${batch.id}`, { enabled: true, maxPosts: batch.leads.length, lane: "history" });
    report.acquisition = admission;
    if (["failed", "unresolved", "budget-limit"].includes(admission.status)) throw new Error(`History source ${admission.status}`);
    if (options.stage === "source") return [];
    }
    let ready: Prompt[];
    const holds = await readQualityHolds(sharedRoot);
    if (options.stage !== "translation") {
    const intake = await readXIntake(directory); report.intake = intake.report;
    const approvedIDs = new Set(batch.leads.map(l => `x-post-${l.id}`));
    const excluded = new Set((await json<{ removedIDs: string[] }>(join(sharedRoot, "moderation.json"), { removedIDs: [] })).removedIDs);
    for (const id of Object.keys(holds.holds)) excluded.add(id);
    const candidates = intake.candidates.filter(p => approvedIDs.has(p.id) && !excluded.has(p.id));
    await phase("editorial");
    const reviews = reviewsSchema.parse(await json(join(directory, "editorial.json"), await json(join(sharedRoot, "editorial.json"), {})));
    const cachePath = join(directory, "editorial-cache.json"), ledgerPath = join(directory, "editorial-ledger.json");
    const cache = editorialCacheSchema.parse(await json(cachePath, { version: editorialVersion, decisions: {} }));
    const ledgerRaw = await json(ledgerPath, undefined), ledger = ledgerRaw === undefined ? undefined : editorialLedgerSchema.parse(ledgerRaw);
    if (ledger && ledger.day !== day) throw new Error("History editorial ledger identity changed");
    let sequence = ledger?.requests ?? 0;
    const editorial = await runEditorialReview({ candidates, previous: [], reviews, cache, ledger, day, maxRequests: historyLimits.editorial,
      provider: async items => { await options.checkLease?.(); return codexEditorialProvider(env.PROMPIX_CODEX, response => atomic(join(directory, "editorial-responses", `${sequence}.json`), response),
        async evidence => { await writeImmutableBytes(join(directory, "editorial-attempts", `${sequence}.json`), Buffer.from(JSON.stringify(evidence) + "\n")); })(items); },
      persistReviews: value => atomic(join(directory, "editorial.json"), value), persistCache: value => atomic(cachePath, value),
      persistLedger: async value => { await atomic(ledgerPath, value); sequence = value.requests; } });
    report.editorial = editorial.report;
    if (["failed", "prior-attempt-blocked"].includes(editorial.report.status)) throw new Error("Historical editorial attempt requires inspection");
    const planned = uniqueHistoryItems(selectLibrary(applyEditorialReviews(candidates, editorial.reviews), excluded).map(candidate => {
      const { fingerprint: _, featured: __, reviewStatus: ___, editorialRank: ____, ...prompt } = candidate;
      return { ...prompt, prompt: publicationText(candidate, editorial.reviews) };
    }), previous);
    report.editorialEligible = planned.length;
    await phase("media");
    // Reuse previously mirrored objects without replacing any batch progress.
    for (const name of ["media-map.json", "media-aspects.json"]) {
      if (await json(join(directory, name), null) === null) await atomic(join(directory, name), await json(join(sharedRoot, name), {}));
    }
    const { prompts: mirrored, errors: mediaErrors } = await mirrorPromptMediaBatch(planned, directory);
    report.mediaErrors = mediaErrors; report.mediaPrepared = mirrored.length;
    await phase("visual");
    const visualPath = join(directory, "visual-cache.json"), visualLedgerPath = join(directory, "visual-ledger.json");
    const visualCache = visualCacheSchema.parse(await json(visualPath, { version: visualReviewVersion, decisions: {} }));
    const visualRaw = await json(visualLedgerPath, undefined), visualLedger = visualRaw === undefined ? undefined : visualLedgerSchema.parse(visualRaw);
    if (visualLedger && visualLedger.day !== day) throw new Error("History visual ledger identity changed");
    let visualSequence = visualLedger?.requests ?? 0;
    const temporary = await mkdtemp(join(tmpdir(), "prompix-history-review-"));
    const reviewWebsite = mirrored.some(p => p.kind === "web") ? await websiteReviewer(sharedRoot) : undefined;
    let visual;
    try {
      visual = await runVisualReview({ prompts: mirrored, previous: [], cache: visualCache, ledger: visualLedger, day, maxRequests: historyLimits.visual, reviewWebsite,
        prepareMedia: item => prepareVisualMedia(item, temporary),
        provider: async items => { await options.checkLease?.(); return codexVisualProvider(env.PROMPIX_CODEX, response => atomic(join(directory, "visual-responses", `${visualSequence}.json`), response))(items); },
        persistCache: value => atomic(visualPath, value), persistLedger: async value => { await atomic(visualLedgerPath, value); visualSequence = value.requests; } });
    } finally { await rm(temporary, { recursive: true, force: true }); }
    report.visual = visual.report;
    if (["failed", "prior-attempt-blocked"].includes(visual.report.status)) throw new Error("Historical visual attempt requires inspection");
    const labeled = applyVisualPresentation(visual.prompts, visualCacheSchema.parse(await json(visualPath, visualCache)));
    ready = applyQualityHolds(labeled.filter(p => p.presentation === "general" || p.presentation === "suggestive"), holds).prompts;
    report.visualEligible = ready.length;
    const sourceCatalog = { schemaVersion: 1 as const, version: `history-${batch.id}`, prompts: ready, removedIDs: [] };
    await atomic(join(directory, "source-catalog.json"), sourceCatalog);
    if (options.stage === "review") return ready;
    } else {
      ready = await verifyReviewedHistory(directory, sharedRoot);
    }
    const sourceCatalog = { schemaVersion: 1 as const, version: `history-${batch.id}`, prompts: ready, removedIDs: [] };
    await phase("translation");
    const translations = join(directory, "translations"), translationPath = join(translations, "cache.json");
    const existingCache = await json(translationPath, null);
    if (!existingCache && seedTranslations) await atomic(translationPath, await readTranslationCache(join(seedTranslations, "cache.json")));
    const translationCache = await readTranslationCache(translationPath), translationReviews = await readTranslationReviews(join(sharedRoot, "translations", "semantic-rejections.json"));
    if (options.chineseOnly) seedApprovedChineseMetadata(ready, translationCache);
    const priorTranslation = await json<TranslationRunReport | undefined>(join(translations, "report.json"), undefined);
    const translate = codexTranslationProvider(env.PROMPIX_CODEX, 24000, "gpt-6-luna");
    let translationSequence = priorTranslation?.attempted ?? 0;
    const translationReport = await runHistoryTranslations({ items: ready, cache: translationCache, reviews: translationReviews,
      provider: async (locale, segments) => {
        await options.checkLease?.();
        const attempt = ++translationSequence;
        const response = await translate(locale, segments);
        await writeImmutableBytes(join(translations, "responses", `${attempt}.json`), Buffer.from(JSON.stringify({ locale, ids: segments.map(s => s.id), response }) + "\n"));
        return response;
      }, providerName: "codex", model: "gpt-6-luna",
      concurrency: options.translationConcurrency ?? 6, maxRequests: historyLimits.translation, maxUSD: 0, locales: options.chineseOnly ? requiredIngestLocales : translationLocales,
      prior: priorTranslation,
      persist: async (state, status) => { await atomic(translationPath, state); await atomic(join(translations, "report.json"), status); } });
    report.translation = translationReport;
    const localized = options.chineseOnly ? originalAndChinese(ready, translationCache, translationReviews) : attachTranslations(ready, translationCache, translationReviews);
    await atomic(join(directory, "catalog.localized.json"), { ...sourceCatalog, prompts: localized });
    const { complete, deferred } = acceptHistoryTranslations(localized, translationReport, priorTranslation?.failed ?? 0, options.chineseOnly ? requiredIngestLocales : translationLocales);
    report.translationDeferredIDs = deferred.map(p => p.id);
    report.complete = complete.length; report.completedAt = new Date().toISOString();
    await atomic(join(directory, "complete.json"), { ...sourceCatalog, prompts: complete });
    await phase("complete");
    return complete;
  } catch (error) {
    report.error = error instanceof Error ? error.message : "History processing failed"; await phase("blocked"); throw error;
  }
}

/** Isolate rejected content, but never route around an exhausted quota or a failed provider. */
export function acceptHistoryTranslations(items: Prompt[], report: TranslationRunReport, priorFailures = 0, locales: readonly TranslationLocale[] = translationLocales) {
  if (report.failed > priorFailures) throw new Error("Historical translation provider failed; inspect retained attempts before continuing");
  if (report.pendingSegments && report.attempted >= historyLimits.translation) throw new Error("Historical translation request allowance exhausted");
  const complete: Prompt[] = [], deferred: Prompt[] = [];
  for (const item of items) (completeHistoryItem(item, Date.now(), locales) ? complete : deferred).push(item);
  return { complete, deferred };
}

/** Retry only missing validated segments; every pass retains the same cumulative allowance. */
export async function runHistoryTranslations(options: Parameters<typeof runTranslations>[0]) {
  let prior = options.prior;
  for (let pass = 0; pass < 3; pass++) {
    const failures = prior?.failures ?? [];
    const report = await runTranslations({ ...options, prior, provider: (locale, segments) => options.provider(locale, segments.map(segment => {
      const feedback = failures.filter(f => f.locale === locale && f.ids.includes(segment.id)).map(f => `Previous validation failed: ${f.reason}. Correct this against the complete source; preserve every opaque token exactly once.`);
      return feedback.length ? { ...segment, reviewFeedback: [...new Set([...(segment.reviewFeedback ?? []), ...feedback])] } : segment;
    })) });
    if (!report.pendingSegments || report.failed > (prior?.failed ?? 0) || report.attempted <= (prior?.attempted ?? 0)
        || report.attempted >= (options.maxRequests ?? 500) || pass === 2) return report;
    prior = report;
  }
  throw new Error("Unreachable historical translation retry state");
}
