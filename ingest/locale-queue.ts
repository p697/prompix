import { join } from "node:path";
import { z } from "zod";
import type { Prompt } from "../packages/schema/catalog.ts";
import { promptSchema } from "../packages/schema/catalog.ts";
import { atomic, json, writeImmutableBytes } from "./publication.ts";
import { StageQueue, queueIdentity, type QueueJob } from "./stage-queue.ts";
import { translationFingerprint, translationLocales, translationVersion, attachTranslations, validLocalizedText, type TranslationLocale } from "./translation.ts";
import { readTranslationCache } from "./translation-cache.ts";
import { runHistoryTranslations } from "./history-batch.ts";
import { codexTranslationProvider, type TranslationProvider } from "./translation-provider.ts";
import { reviewTranslationSemantics, verifySemanticResult, type SemanticVerdict } from "./translation-semantic.ts";
import { readTranslationReviews } from "./translation-review.ts";
import type { TranslationRunReport } from "./translation-runner.ts";
const payloadSchema = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), id: z.string(), kind: z.enum(["text", "image", "video", "web"]), revision: z.string().nullable(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), locale: z.enum(translationLocales), version: z.literal(translationVersion), model: z.literal("gpt-6-luna") }).strict();

/** Internal service entry point. Callers must supply the authoritative approved record, not user text. */
export async function requestLocaleTranslation(queue: StageQueue, root: string, item: Prompt, locale: TranslationLocale) {
  promptSchema.parse(item); z.enum(translationLocales).parse(locale);
  const fingerprint = translationFingerprint(item);
  const kind = item.kind, revision = item.source.revision ?? null;
  const key = queueIdentity({ id: item.id, kind, revision, fingerprint, locale, version: translationVersion, model: "gpt-6-luna" });
  const { localization: _, ...original } = item;
  const path = join(root, key, "source.json"), existing = await json<Prompt | null>(path, null);
  if (existing) {
    if (existing.id !== item.id || existing.kind !== kind || (existing.source.revision ?? null) !== revision || translationFingerprint(existing) !== fingerprint) throw new Error("Locale snapshot identity conflict");
  } else await writeImmutableBytes(path, Buffer.from(JSON.stringify(original) + "\n"));
  // Shared identity across users, including retries. No account/preferences enter the job.
  await queue.enqueue({ id: `locale:${key}`, run: "locales", stage: "locale", priority: 2,
    payload: { key, id: item.id, kind, revision, fingerprint, locale, version: translationVersion, model: "gpt-6-luna" } });
  return key;
}
export async function processLocaleStage(root: string, shared: string, job: QueueJob, current: (id: string) => Promise<Prompt | undefined>, overrides: {
  translate?: TranslationProvider; review?: (items: Prompt[], locale: TranslationLocale, directory: string) => Promise<{ reviews: SemanticVerdict[] }>;
} = {}) {
  const payload = payloadSchema.parse(job.payload);
  if (job.stage !== "locale" || job.id !== `locale:${payload.key}`) throw new Error("Invalid locale task");
  const item = await current(payload.id);
  if (!item || item.kind !== payload.kind || (item.source.revision ?? null) !== payload.revision || translationFingerprint(item) !== payload.fingerprint) return { state: "superseded", ready: false };
  const directory = join(root, payload.key), original = promptSchema.parse(await json(join(directory, "source.json"), null));
  if (original.kind !== payload.kind || (original.source.revision ?? null) !== payload.revision || translationFingerprint(original) !== payload.fingerprint) throw new Error("Locale source changed");
  const cache = await readTranslationCache(join(directory, "cache.json")), reviews = await readTranslationReviews(join(shared, "translations", "semantic-rejections.json"));
  const prior = await json<TranslationRunReport | undefined>(join(directory, "report.json"), undefined);
  if (prior && prior.attempted > 0) throw new Error("Prior locale attempt needs explicit reconciliation");
  const provider = overrides.translate ?? codexTranslationProvider(process.env.PROMPIX_CODEX ?? "codex", 24000, "gpt-6-luna");
  const report = await runHistoryTranslations({ items: [original], cache, reviews, locales: [payload.locale], concurrency: 1, maxAttempts: 1, maxRequests: 8, maxUSD: 0,
    provider, providerName: "codex", model: "gpt-6-luna", prior,
    persist: async (state, status) => { await atomic(join(directory, "cache.json"), state); await atomic(join(directory, "report.json"), status); } });
  if (report.failed) throw new Error("Locale provider failure retained");
  const [localized] = attachTranslations([original], cache, reviews), text = localized.localization?.translations[payload.locale];
  if (!text || !validLocalizedText(original, payload.locale, text, reviews)) return { ready: false, state: "validation-held", report };
  const review = overrides.review ? await overrides.review([localized], payload.locale, join(directory, "semantic"))
    : await reviewTranslationSemantics([localized], payload.locale, join(directory, "semantic"), process.env.PROMPIX_CODEX ?? "codex");
  await atomic(join(directory, "semantic-result.json"), review);
  if (review.reviews.some(r => r.verdict !== "pass")) return { ready: false, state: "semantic-held", report };
  verifySemanticResult({ reviews: review.reviews }, [localized], payload.locale);
  const latest = await current(payload.id);
  const currentReviews = await readTranslationReviews(join(shared, "translations", "semantic-rejections.json"));
  if (!latest || latest.kind !== payload.kind || (latest.source.revision ?? null) !== payload.revision || translationFingerprint(latest) !== payload.fingerprint || !validLocalizedText(latest, payload.locale, text, currentReviews)) return { ready: false, state: "superseded", report };
  await atomic(join(directory, "ready.json"), { id: item.id, sourceFingerprint: payload.fingerprint, locale: payload.locale, translation: text });
  return { ready: true, state: "verified", sha: queueIdentity(text), report };
}
