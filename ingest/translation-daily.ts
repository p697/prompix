import { readTranslationCache } from "./translation-cache.ts";
export { readTranslationCache } from "./translation-cache.ts";
import { applyTranslationReviews, readTranslationReviews } from "./translation-review.ts";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { catalogSchema, type Prompt } from "../packages/schema/catalog.ts";
import { atomic, json } from "./publication.ts";
import { attachTranslations, inheritPreviousTranslations, translationLocales } from "./translation.ts";
import { codexTranslationProvider, openAITranslationProvider } from "./translation-provider.ts";
import { runTranslations, type TranslationRunReport } from "./translation-runner.ts";

export type DailyTranslationStatus = { status: "cached" | "running" | "updated" | "busy" | "failed"; model?: string; error?: string;
  total: number; coverage: Record<string, number>; pendingRecords: Record<string, number>; attempted?: number; rejected?: number; failed?: number; reservedUSD?: number; measuredUSD?: number | null };
export async function prepareDailyTranslations(items: readonly Prompt[], root: string, environment: NodeJS.ProcessEnv = process.env, allowModelCalls = true) {
  const directory = join(root, "translations"), cachePath = join(directory, "cache.json"), lock = join(directory, "run.lock");
  let cache = await readTranslationCache(cachePath);
  let reviews = await readTranslationReviews(join(directory, "semantic-rejections.json"));
  const inheritLocalArtifact = async () => {
    const artifact = await json<unknown>(join(directory, "catalog.localized.json"), undefined);
    return artifact === undefined ? [...items] : inheritPreviousTranslations(items, catalogSchema.parse(artifact).prompts);
  };
  let prepared = await inheritLocalArtifact();
  applyTranslationReviews(cache, reviews);
  let status: DailyTranslationStatus["status"] = "cached", error: string | undefined;
  let report: TranslationRunReport | undefined;
  const providerName = allowModelCalls ? environment.PROMPIX_TRANSLATION_PROVIDER : undefined;
  const model = providerName === "openai" ? "gpt-6.1-sol" : (environment.PROMPIX_TRANSLATION_MODEL ?? "gpt-5.6-luna");
  if (providerName) {
    if (!["codex", "openai"].includes(providerName)) { status = "failed"; error = "Unknown translation provider"; }
    else {
      await mkdir(directory, { recursive: true });
      let locked = false;
      try { await mkdir(lock); locked = true; } catch { status = "busy"; }
      if (locked) {
        try {
          // Another writer may have completed between the initial read and lock acquisition.
          cache = await readTranslationCache(cachePath);
          reviews = await readTranslationReviews(join(directory, "semantic-rejections.json"));
          prepared = await inheritLocalArtifact();
          applyTranslationReviews(cache, reviews);
          await atomic(join(lock, "owner.json"), { pid: process.pid, startedAt: new Date().toISOString(), operation: "daily" });
          const day = new Date().toISOString().slice(0, 10), ledgerPath = join(directory, "daily-budgets", `${day}.json`);
          const offset = Math.floor(Date.parse(day) / 86400000) % translationLocales.length;
          const requestedLocales = environment.PROMPIX_TRANSLATION_LOCALES?.split(",").map(locale => locale.trim());
          if (requestedLocales && (!requestedLocales.length || new Set(requestedLocales).size !== requestedLocales.length ||
            requestedLocales.some(locale => !translationLocales.some(supported => supported === locale)))) {
            throw new Error("PROMPIX_TRANSLATION_LOCALES must contain distinct supported locale codes");
          }
          const locales = (requestedLocales as (typeof translationLocales)[number][] | undefined) ??
            [...translationLocales.slice(offset), ...translationLocales.slice(0, offset)];
          const prior = await json<TranslationRunReport | undefined>(ledgerPath, undefined);
          const maxOutputTokens = 24000;
          const provider = providerName === "codex" ? codexTranslationProvider(environment.PROMPIX_CODEX ?? "codex", maxOutputTokens, model) : openAITranslationProvider(environment.OPENAI_API_KEY ?? "", maxOutputTokens);
          report = await runTranslations({ items: prepared, cache, provider, providerName, model, locales, fairLocales: true,
            maxRequests: Number(environment.PROMPIX_TRANSLATION_MAX_REQUESTS ?? "36"), maxUSD: Number(environment.PROMPIX_TRANSLATION_MAX_USD ?? "2"), maxOutputTokens,
            persist: async (state, progress) => { await atomic(cachePath, state); await atomic(ledgerPath, { ...progress, day, model, updatedAt: new Date().toISOString() }); }, prior, reviews });
          status = "updated";
        } catch (reason) { status = "failed"; error = reason instanceof Error ? reason.message : "Translation preparation failed"; }
        finally { await rm(lock, { recursive: true, force: true }); }
      }
    }
  }
  const prompts = attachTranslations(prepared, cache, reviews);
  const coverage = Object.fromEntries(translationLocales.map(locale => [locale, prompts.filter(item => item.localization?.translations[locale]).length]));
  const pendingRecords = Object.fromEntries(translationLocales.map(locale => [locale, prompts.length - coverage[locale]]));
  const result: DailyTranslationStatus = { status, ...(providerName ? { model } : {}), ...(error ? { error } : {}), total: prompts.length, coverage, pendingRecords,
    ...(report ? { attempted: report.attempted, rejected: report.rejected, failed: report.failed, reservedUSD: report.reservedUSD, measuredUSD: report.measuredUSD } : {}) };
  return { prompts, report: result };
}
