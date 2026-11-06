/** Add already collected history items that an earlier semantic review held back.
 * Repeatable and bounded; no search and no new acquisition. In order:
 *   retranslate  translate again, into Simplified Chinese only, giving the translator each held item's
 *                review findings (provider layer, default anthropic-api claude-sonnet-5-5; same validators)
 *   semantic     a separate, independent semantic review of the new translations (same instructions and checks)
 *   select       approved retranslations not live yet, deduplicated against the live edition and each other
 *   recheck      confirm the candidates' sources are still online (third-party lookup, bounded requests)
 *   (2.0 review) enrich-catalog review --catalog <work>/candidates.json --work <work>
 *   publish      history publisher: original evidence re-verified, people flags and unreviewed items held back
 */
import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import type { Prompt } from "../packages/schema/catalog.ts";
import { withPublisherDatabase } from "../ingest/database-publication.ts";
import { prepareDailyStaging } from "../ingest/daily-publication.ts";
import { withDailyStatus } from "../ingest/daily-status.ts";
import { applyEnrichment, needsPeopleReview, type EnrichmentOutcome } from "../ingest/enrichment-review.ts";
import { readHistoryAllowance } from "../ingest/history-allowance.ts";
import { uniqueHistoryItems } from "../ingest/history-cohort.ts";
import { readHistoryAvailability } from "../ingest/history-freshness.ts";
import { historyPublicationRun, publishQualifiedHistory, type HistoryPublicationReport } from "../ingest/history-publication.ts";
import { limitNewPublications } from "../ingest/publication-quota.ts";
import { atomic, contentRoot, json, lockContent, moderationSchema } from "../ingest/publication.ts";
import { applyQualityHolds, readQualityHolds } from "../ingest/quality-holds.ts";
import { configuredRecheck, filterXAvailability, readXAvailability } from "../ingest/x-availability.ts";
import { readTranslationCache } from "../ingest/translation-cache.ts";
import { modelTranslationProvider } from "../ingest/translation-provider.ts";
import { createProvider, isProviderId, modelEnvironment } from "../ingest/models/registry.ts";
import { appendEvent, pipelineRoot } from "../ingest/pipeline-control.ts";
import { runTranslations } from "../ingest/translation-runner.ts";
import { attachTranslations, emptyTranslationCache } from "../ingest/translation.ts";
import { reviewTranslationSemanticsWith } from "../ingest/translation-semantic.ts";
import { completeHistoryItem } from "../ingest/history-cohort.ts";
import { hasRequiredTranslations, requiredIngestLocales } from "../ingest/ingest-language-policy.ts";
import { verifyReviewedHistory } from "../ingest/history-stage-verification.ts";
import { recheckXStandalone } from "../ingest/x-recheck.ts";
import { readXIntake } from "../ingest/x-intake.ts";
import type { Candidate } from "../ingest/sources.ts";
import type { Palette } from "../packages/schema/enrichment.ts";

process.umask(0o077);
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  campaign: { type: "string" }, work: { type: "string" }, run: { type: "string" }, "max-jobs": { type: "string" }, "max-requests": { type: "string" },
  concurrency: { type: "string" }, limit: { type: "string" }, provider: { type: "string" }, model: { type: "string" },
} });
const [command] = positionals;
const campaign = values.campaign, work = values.work;
if (!campaign || !isAbsolute(campaign) || !work || !isAbsolute(work)) throw new Error("--campaign and --work must be absolute external directories");
const run = await historyPublicationRun(contentRoot, campaign);
const candidatesPath = join(work, "candidates.json");
/** What the 2.0 review saw; publication may refresh only source check times. */
const reviewedContent = (item: Prompt) => createHash("sha256").update(JSON.stringify({ id: item.id, title: item.title, summary: item.summary,
  prompt: item.prompt, model: item.model, media: item.media, revision: item.source.revision })).digest("hex");


type Finding = { field: string; sourceQuote?: string; translatedQuote?: string; reason: string };
/** Latest semantic verdict per item across the campaign, with the batch each item came from. */
async function heldBySemanticReview() {
  const latest = new Map<string, { directory: string; start: number; attempt: number; verdict: string; issues: Finding[] }>();
  for (const batch of await readdir(join(campaign!, run))) {
    const directory = join(campaign!, run, batch), semantic = join(directory, "semantic");
    for (const name of await readdir(semantic).catch(() => [] as string[])) {
      const [start, attempt] = name.split("-").map(Number);
      const result = await json<{ reviews?: { id: string; verdict: string; issues: Finding[] }[] }>(join(semantic, name, "result.json"), {});
      for (const review of result.reviews ?? []) {
        const previous = latest.get(review.id);
        if (!previous || previous.directory !== directory || attempt > previous.attempt) latest.set(review.id, { directory, start, attempt, verdict: review.verdict, issues: review.issues });
      }
    }
  }
  return latest;
}
const intakeTranslations = join(work, "translations");
/** Translation and its semantic check use the provider layer; every call is summarized in the control log. */
async function routedProvider() {
  const id = values.provider ?? "anthropic-api";
  if (!isProviderId(id)) throw new Error(`Unknown provider ${id}`);
  return createProvider(id, values.model ?? "claude-sonnet-5-5", (await modelEnvironment()).env);
}
const record = (task: string) => (summary: Parameters<typeof appendEvent>[3]) => appendEvent(pipelineRoot(), "claude-code", "model.call", { ...summary, task }).then(() => undefined);

async function live(): Promise<Prompt[]> {
  const prepared = await prepareDailyStaging(contentRoot);
  if (!prepared.previous) throw new Error("Published edition unavailable");
  return prepared.previous.authoritative.prompts;
}

switch (command) {
  case "retranslate": {
    const held = await heldBySemanticReview(), published = await live();
    const liveIDs = new Set(published.map(item => item.id)), removedIDs = new Set(moderationSchema.parse(await json(join(contentRoot, "moderation.json"), { removedIDs: [] })).removedIDs);
    const items: Prompt[] = [], findings = new Map<string, Finding[]>();
    const catalogs = new Map<string, Prompt[]>();
    for (const [id, verdict] of held) {
      if (verdict.verdict === "pass" || liveIDs.has(id) || removedIDs.has(id)) continue;
      if (!catalogs.has(verdict.directory)) catalogs.set(verdict.directory, (await json<{ prompts: Prompt[] }>(join(verdict.directory, "complete.json"), { prompts: [] })).prompts);
      const item = catalogs.get(verdict.directory)!.find(value => value.id === id);
      if (!item?.localization) continue;
      // Drop only the rejected Simplified Chinese text; other languages and the original stay as they were.
      const { "zh-Hans": _rejected, ...others } = item.localization.translations;
      items.push({ ...item, localization: { ...item.localization, translations: others } });
      findings.set(id, verdict.issues);
      if (items.length >= Number(values.limit ?? Infinity)) break;
    }
    await mkdir(intakeTranslations, { recursive: true });
    const cachePath = join(intakeTranslations, "cache.json"), cache = await readTranslationCache(cachePath).catch(() => emptyTranslationCache());
    // Attach each finding to the segment it quotes, or to all segments of a short item when no quote matches.
    const routed = await routedProvider();
    const base = modelTranslationProvider(routed, 24000, record("history-intake:translate"));
    const provider: typeof base = (locale, segments) => base(locale, segments.map(segment => {
      const source = segment.sourceText ?? segment.text, notes: string[] = [];
      for (const item of items) for (const finding of findings.get(item.id) ?? []) {
        const quote = (finding.sourceQuote ?? "").replace(/^[“”"'\s]+|[“”"'\s]+$/g, "").slice(0, 40);
        if (quote.length >= 6 ? source.includes(quote) : false)
          notes.push(`An independent reviewer rejected the previous translation of this text: ${finding.reason}${finding.translatedQuote ? ` (rejected wording: ${finding.translatedQuote})` : ""}. Correct it; keep everything else faithful and preserve every opaque token exactly once.`);
      }
      return notes.length ? { ...segment, reviewFeedback: [...new Set([...(segment.reviewFeedback ?? []), ...notes])] } : segment;
    }));
    const report = await runTranslations({ items, cache, provider, providerName: routed.id, model: routed.model, locales: ["zh-Hans"],
      concurrency: Number(values.concurrency ?? 3), maxRequests: 1000, maxUSD: 5, maxCharacters: 12000, maxOutputTokens: 24000,
      persist: async state => { await atomic(cachePath, state); } });
    const localized = attachTranslations(items, cache).filter(item => item.localization?.translations["zh-Hans"]);
    await atomic(join(work, "retranslated.json"), { schemaVersion: 1, version: "history-retranslated", prompts: localized });
    await atomic(join(work, "retranslate-origins.json"), Object.fromEntries(items.map(item => [item.id, held.get(item.id)!.directory])));
    console.log(JSON.stringify({ held: items.length, translated: localized.length, attempted: report.attempted, rejected: report.rejected, failed: report.failed, pendingSegments: report.pendingSegments, failures: report.failures?.slice(0, 4) }));
    break;
  }
  case "semantic": {
    const items = (await json<{ prompts: Prompt[] }>(join(work, "retranslated.json"), { prompts: [] })).prompts
      .filter(item => completeHistoryItem({ ...item, source: { ...item.source, post: item.source.post && { ...item.source.post, checkedAt: new Date().toISOString() } } }, Date.now(), requiredIngestLocales));
    const directory = join(work, "semantic"), passed: Prompt[] = [], reviewer = await routedProvider();
    const groups = Array.from({ length: Math.ceil(items.length / 4) }, (_, index) => items.slice(index * 4, index * 4 + 4));
    let next = 0, held = 0;
    await Promise.all(Array.from({ length: Math.min(Number(values.concurrency ?? 3), groups.length) }, async () => {
      while (next < groups.length) {
        const index = next++, group = groups[index], output = join(directory, String(index));
        const existing = await json<{ reviews?: { id: string; verdict: string }[] } | null>(join(output, "result.json"), null);
        const review = existing?.reviews?.length === group.length ? existing
          : await reviewTranslationSemanticsWith(reviewer, group, "zh-Hans", output, "high", record("history-intake:semantic"));
        if (!existing) await atomic(join(output, "result.json"), review);
        const approved = new Set(review.reviews!.filter(value => value.verdict === "pass").map(value => value.id));
        for (const item of group) if (approved.has(item.id)) passed.push(item); else held++;
      }
    }));
    await atomic(join(work, "semantic-passed.json"), { schemaVersion: 1, version: "history-semantic-passed", prompts: passed });
    console.log(JSON.stringify({ reviewed: items.length, passed: passed.length, held }));
    break;
  }
  case "select": {
    // Retranslated items that passed the new semantic review, deduplicated against the live edition and each other.
    const passed = (await json<{ prompts: Prompt[] }>(join(work, "semantic-passed.json"), { prompts: [] })).prompts;
    const moderation = moderationSchema.parse(await json(join(contentRoot, "moderation.json"), { removedIDs: [] }));
    const removed = new Set(moderation.removedIDs);
    const candidates = uniqueHistoryItems(applyQualityHolds(passed, await readQualityHolds(contentRoot)).prompts.filter(item => !removed.has(item.id)), await live());
    await atomic(candidatesPath, { schemaVersion: 1, version: "history-intake", prompts: candidates });
    const all = await json<Record<string, string>>(join(work, "retranslate-origins.json"), {});
    await atomic(join(work, "origins.json"), Object.fromEntries(candidates.map(item => [item.id, all[item.id]])));
    console.log(JSON.stringify({ passed: passed.length, candidates: candidates.length, kinds: Object.fromEntries(["image", "video", "text"].map(kind => [kind, candidates.filter(item => item.kind === kind).length])) }));
    break;
  }
  case "recheck": {
    // Same ledger, pacing and exact-revision comparison as maintenance; records go to the campaign's revalidation state.
    const recheck = configuredRecheck();
    if (!recheck) throw new Error("A third-party recheck provider must be configured");
    const maxRequests = Number(values["max-requests"] ?? 16);
    const selected: Prompt[] = (await json<{ prompts: Prompt[] }>(candidatesPath, { prompts: [] })).prompts;
    const origins = await json<Record<string, string>>(join(work, "origins.json"), {});
    const candidates: Candidate[] = [];
    for (const directory of new Set(Object.values(origins))) {
      const intake = (await readXIntake(directory)).candidates;
      for (const item of selected) if (origins[item.id] === directory) {
        const original = intake.find(value => value.id === item.id && value.source.revision === item.source.revision);
        if (original && original.source.post && !original.source.context && !original.source.post.parentID && !original.source.mediaPostID) candidates.push(original);
      }
    }
    const root = join(campaign, "source-revalidation"), now = new Date().toISOString();
    const unlock = await lockContent(contentRoot);
    try {
      const state = await readXAvailability(root);
      const report = await recheckXStandalone(root, candidates, { ...recheck, maxRequests, dailyRequestCeiling: Math.max(maxRequests, recheck.dailyRequestCeiling ?? 40),
        now, excerpts: await json(join(contentRoot, "x-excerpt-reviews.json"), {}), apply: async (matched, unresolved, result) => {
          for (const item of matched) state[item.id] = { checkedAt: now, status: "ready", revision: item.source.revision, checkedBy: result.provider };
          // Omission never proves deletion; an unconfirmed source is withheld, not removed.
          for (const item of unresolved) state[item.id] = { checkedAt: now, status: "withheld", checkedBy: result.provider };
          await atomic(join(root, "x-availability", "state.json"), state);
        } });
      console.log(JSON.stringify({ selected: selected.length, standalone: candidates.length, ...report }));
    } finally { await unlock(); }
    break;
  }
  case "publish": {
    if (!values.run) throw new Error("--run <enrichment run> is required");
    const outcomes = join(work, "runs", values.run, "outcomes");
    const report: HistoryPublicationReport & { enriched?: number; peopleReview?: string[]; unreviewed?: number } = { startedAt: new Date().toISOString(), published: false };
    const allowance = await readHistoryAllowance();
    const reviewed = new Map((await json<{ prompts: Prompt[] }>(candidatesPath, { prompts: [] })).prompts.map(item => [item.id, reviewedContent(item)]));
    await withDailyStatus(contentRoot, report, async () => {
      const origins = await json<Record<string, string>>(join(work, "origins.json"), {});
      await publishQualifiedHistory(contentRoot, campaign, run, report, {
        // These items left the queue at semantic review; re-verify their original evidence here instead.
        ready: async () => {
          const availability = await readHistoryAvailability(campaign, contentRoot);
          const fresh = filterXAvailability((await json<{ prompts: Prompt[] }>(candidatesPath, { prompts: [] })).prompts, availability).prompts;
          const verified: Prompt[] = [];
          for (const directory of new Set(fresh.map(item => origins[item.id]))) {
            const group = fresh.filter(item => origins[item.id] === directory);
            await verifyReviewedHistory(directory, contentRoot, group, availability);
            verified.push(...group);
          }
          if (verified.some(item => !completeHistoryItem(item, Date.now(), requiredIngestLocales) || !hasRequiredTranslations(item))) throw new Error("Retranslated history quality invalid");
          return verified;
        },
        // The publisher has already applied removals, holds, deduplication and source availability.
        limit: async items => {
          const accepted: Prompt[] = [], people: string[] = [];
          let unreviewed = 0;
          for (const item of items) {
            const outcome = await json<EnrichmentOutcome | null>(join(outcomes, `${item.id}.json`), null);
            const media = await json<{ palette?: Palette; video?: { durationSeconds: number; hasAudio: boolean } } | null>(join(work, "media", item.id, "prepared.json"), null);
            if (!outcome?.ok || !media || reviewed.get(item.id) !== reviewedContent(item)) { unreviewed++; continue; }
            if (needsPeopleReview(outcome.evidence)) { people.push(item.id); continue; }
            // The earlier full-gallery visual label stands unless the new review is stricter.
            const enriched = applyEnrichment(item, outcome, { palette: media.palette, video: media.video, policy: "stricter-only" });
            // A new item is added only with a settled, publishable label.
            if (enriched.presentation !== "general" && enriched.presentation !== "suggestive") { unreviewed++; continue; }
            accepted.push(enriched);
          }
          report.enriched = accepted.length; report.peopleReview = people; report.unreviewed = unreviewed;
          await atomic(join(work, "people-review.json"), people);
          return withPublisherDatabase(db => limitNewPublications(db, accepted, new Date(), allowance));
        },
      });
      await atomic(join(work, "publication-report.json"), report);
    });
    console.log(JSON.stringify(report, null, 2));
    break;
  }
  default: throw new Error("Usage: add-history-items retranslate|semantic|select|recheck|publish --campaign /abs --work /abs [--run name]");
}

