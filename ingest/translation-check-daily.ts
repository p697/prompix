import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { Prompt } from "../packages/schema/catalog.ts";
import type { ModelCallSummary } from "./models/call.ts";
import { ModelProviderError, type Effort, type ModelProvider } from "./models/types.ts";
import { atomic, json } from "./publication.ts";
import { reviewTranslationSemanticsWith } from "./translation-semantic.ts";
import { translationFingerprint, translationLocales, type TranslationLocale } from "./translation.ts";

export type TranslationCheckOptions = { provider?: ModelProvider; effort?: Effort; record?: (summary: ModelCallSummary) => Promise<void>;
  maxRequests?: number; concurrency?: number; review?: typeof reviewTranslationSemanticsWith };
export type TranslationCheckReport = { status: "reviewed" | "cached" | "stopped"; provider?: string; model?: string; pending: number;
  requests: number; failedRequests: number; passed: number; held: number; withheld: number; stopped?: string };

const ledgerSchema = z.record(z.string().regex(/^[a-f0-9]{64}$/), z.enum(["pass", "held"]));
const batchSize = 4;
/** A verdict covers one translation of one source revision. */
const ledgerKey = (item: Prompt, locale: TranslationLocale, text: unknown) =>
  createHash("sha256").update(JSON.stringify([item.id, locale, translationFingerprint(item), text])).digest("hex");

/** Every translation that enters an edition for the first time passes an independent review on
 * the translationCheck route; text already live is not reviewed again. A held translation, and
 * one not reviewed yet, leaves this edition for that locale only: the item still publishes and
 * readers see the original. Refusals hold for good; other failures wait for a later run.
 * Without a provider (dry run) only recorded verdicts are used. Caller holds daily.lock. */
export async function checkNewTranslations(items: readonly Prompt[], previous: readonly Prompt[], directory: string, options: TranslationCheckOptions = {}) {
  const ledgerPath = join(directory, "semantic-ledger.json");
  const ledger = ledgerSchema.parse(await json(ledgerPath, {}));
  const live = new Map(previous.map(item => [item.id, item]));
  const report: TranslationCheckReport = { status: options.provider ? "reviewed" : "cached", pending: 0, requests: 0, failedRequests: 0,
    passed: 0, held: 0, withheld: 0, ...(options.provider ? { provider: options.provider.id, model: options.provider.model } : {}) };
  const isLive = (item: Prompt, locale: TranslationLocale) => {
    const before = live.get(item.id);
    return !!before && translationFingerprint(before) === translationFingerprint(item) &&
      JSON.stringify(before.localization?.translations[locale]) === JSON.stringify(item.localization?.translations[locale]);
  };
  const pending = new Map<TranslationLocale, Prompt[]>();
  for (const item of items) for (const locale of translationLocales) {
    const text = item.localization?.translations[locale];
    if (!text || isLive(item, locale) || ledger[ledgerKey(item, locale, text)]) continue;
    pending.set(locale, [...(pending.get(locale) ?? []), item]);
    report.pending++;
  }
  if (options.provider && report.pending) {
    const provider = options.provider, review = options.review ?? reviewTranslationSemanticsWith;
    // New items first, Simplified Chinese first: a capped run spends its reviews where readers see them first.
    const rank = (item: Prompt, locale: TranslationLocale) => (live.has(item.id) ? 2 : 0) + (locale === "zh-Hans" ? 0 : 1);
    const queue = [...pending].flatMap(([locale, group]) => {
      const ordered = [...group].sort((a, b) => rank(a, locale) - rank(b, locale));
      return Array.from({ length: Math.ceil(ordered.length / batchSize) }, (_, index) => ({ locale, batch: ordered.slice(index * batchSize, index * batchSize + batchSize) }));
    }).sort((a, b) => rank(a.batch[0], a.locale) - rank(b.batch[0], b.locale)).slice(0, options.maxRequests ?? 10);
    const record = async () => atomic(ledgerPath, ledger);
    await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 3, queue.length) }, async () => {
      while (queue.length) {
        const { locale, batch } = queue.shift()!;
        report.requests++;
        try {
          const result = await review(provider, batch, locale, join(directory, "semantic-daily", ledgerKey(batch[0], locale, batch.map(item => item.id))),
            options.effort ?? "medium", options.record);
          for (const item of batch) {
            const verdict = result.reviews.find(value => value.id === item.id)?.verdict === "pass" ? "pass" : "held";
            ledger[ledgerKey(item, locale, item.localization!.translations[locale])] = verdict;
          }
          await record();
        } catch (error) {
          report.failedRequests++;
          const code = error instanceof ModelProviderError ? error.code : "failed";
          // A declined review is final for this text; no other model is asked.
          if (code === "refused") { for (const item of batch) ledger[ledgerKey(item, locale, item.localization!.translations[locale])] = "held"; await record(); }
          else if (code === "unavailable" || code === "rate_limited") { report.status = "stopped"; report.stopped = `${code}: ${(error as Error).message.slice(0, 200)}`; queue.length = 0; }
        }
      }
    }));
  }
  const prompts = items.map(item => {
    const translations = item.localization?.translations;
    if (!translations) return item;
    const kept: typeof translations = {};
    for (const locale of translationLocales) {
      const text = translations[locale];
      if (!text) continue;
      const verdict = isLive(item, locale) ? "pass" : ledger[ledgerKey(item, locale, text)];
      if (verdict === "pass") { kept[locale] = text; if (!isLive(item, locale)) report.passed++; }
      else if (verdict === "held") report.held++;
      else report.withheld++;
    }
    return { ...item, localization: { ...item.localization!, translations: kept } };
  });
  return { prompts, report };
}
