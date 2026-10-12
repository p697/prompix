import { readTranslationCache } from "./translation-cache.ts";
import { applyTranslationReviews, readTranslationReviews } from "./translation-review.ts";
import { mkdir, realpath, rm, readFile } from "node:fs/promises";
import { join, relative, isAbsolute, resolve } from "node:path";
import { catalogSchema } from "../packages/schema/catalog.ts";
import { atomic, contentRoot, json, repo } from "./publication.ts";
import { attachTranslations, inheritPreviousTranslations, translationLocales, type TranslationCache, type TranslationLocale } from "./translation.ts";
import { codexTranslationProvider, openAITranslationProvider } from "./translation-provider.ts";
import { runTranslations, type TranslationRunReport } from "./translation-runner.ts";

const args = process.argv.slice(2);
const value = (name: string, fallback: string) => { const index = args.indexOf(name); return index === -1 ? fallback : args[index + 1]; };
const input = args[0]?.startsWith("--") ? undefined : args[0];
if (!input) throw new Error("Usage: tsx ingest/translation-cli.ts /external/catalog.json [--provider codex|openai] [--locales en,zh-Hans,...] [--max-requests 500] [--max-usd 5] [--reset-budget]");
const directory = resolve(process.env.PROMPIX_TRANSLATION_DIR ?? join(contentRoot, "translations"));
await mkdir(directory, { recursive: true });
const rel = relative(await realpath(repo), await realpath(directory));
if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("Translations must stay outside repository");
const lock = join(directory, "run.lock");
try { await mkdir(lock); } catch { throw new Error("Another translation run is active; inspect the owner before recovering a stale lock"); }
try {
  await atomic(join(lock, "owner.json"), { pid: process.pid, startedAt: new Date().toISOString() });
  const catalog = catalogSchema.parse(JSON.parse(await readFile(resolve(input), "utf8")));
  const previous = await json<unknown>(join(directory, "catalog.localized.json"), undefined);
  if (previous !== undefined) {
    const parsed = catalogSchema.safeParse(previous);
    if (!parsed.success) throw new Error("Previous localized catalog cannot be read safely");
    catalog.prompts = inheritPreviousTranslations(catalog.prompts, parsed.data.prompts);
  }
  const cachePath = join(directory, "cache.json"), reportPath = join(directory, "report.json");
  const cache = await readTranslationCache(cachePath);
  const reviews = await readTranslationReviews(join(directory, "semantic-rejections.json"));
  applyTranslationReviews(cache, reviews);
  const providerName = value("--provider", "codex");
  if (!["codex", "openai"].includes(providerName)) throw new Error("Unknown translation provider");
  const locales = value("--locales", translationLocales.join(",")).split(",") as TranslationLocale[];
  if (!locales.every(locale => translationLocales.includes(locale))) throw new Error("Unsupported locale");
  const maxOutputTokens = Number(value("--max-output-tokens", "24000"));
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1000 || maxOutputTokens > 64000) throw new Error("Invalid output token cap");
  const prior = args.includes("--reset-budget") ? undefined : await json<(TranslationRunReport & { model?: string; usageTrackedFromRequest?: number }) | undefined>(reportPath, undefined);
  // Earlier validated batches may predate segment-level provenance. Preserve their known provider/model.
  if (!cache.provenance && prior?.model) {
    cache.provenance = Object.fromEntries(Object.entries(cache.segments).map(([locale, segments]) => [locale,
      Object.fromEntries(Object.keys(segments).map(id => [id, { provider: prior.provider, model: prior.model!, generatedAt: "unknown" }]))]));
  }
  const usageTrackedFromRequest = prior?.usageTrackedFromRequest ?? (prior?.attempted ?? 0) + 1;
  const model = providerName === "codex" ? value("--model", "gpt-5.6-luna") : "gpt-6.1-sol";
  const provider = providerName === "codex" ? codexTranslationProvider(process.env.PROMPIX_CODEX ?? "codex", maxOutputTokens, model) : openAITranslationProvider(process.env.OPENAI_API_KEY ?? "", maxOutputTokens);
  const persist = async (state: TranslationCache, report: TranslationRunReport) => {
    await atomic(cachePath, state);
    await atomic(reportPath, { ...report, updatedAt: new Date().toISOString(), catalogVersion: catalog.version, model, usageTrackedFromRequest });
    const localized = attachTranslations(catalog.prompts, state, reviews);
    await atomic(join(directory, "coverage.json"), { catalogVersion: catalog.version, total: catalog.prompts.length, coverage: Object.fromEntries(translationLocales.map(locale => [locale, localized.filter(item => item.localization?.translations[locale]).length])), report });
  };
  const report = await runTranslations({ items: catalog.prompts, cache, provider, providerName, model, persist, locales,
    concurrency: Number(value("--concurrency", "2")), maxRequests: Number(value("--max-requests", "500")), maxUSD: Number(value("--max-usd", "5")),
    maxCharacters: Number(value("--batch-characters", "12000")), maxOutputTokens, prior, reviews });
  const prompts = attachTranslations(catalog.prompts, cache, reviews);
  const output = join(directory, "catalog.localized.json");
  await atomic(output, { ...catalog, prompts });
  const coverage = Object.fromEntries(translationLocales.map(locale => [locale, prompts.filter(item => item.localization?.translations[locale]).length]));
  await atomic(join(directory, "coverage.json"), { catalogVersion: catalog.version, total: prompts.length, coverage, output, report });
  console.log(JSON.stringify({ total: prompts.length, coverage, output, attempted: report.attempted, rejected: report.rejected, failed: report.failed }));
} finally { await rm(lock, { recursive: true, force: true }); }
