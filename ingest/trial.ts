/** A real, unpublished run of the new pipeline for the owner's acceptance: today's X search
 * under the approved rules, the same intake, media mirroring, one review pass and translation
 * into nine languages, all through the configured routes and spend ledgers. Nothing is
 * published; everything lands in content/trials/<run>/ with an acceptance page. */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Prompt } from "../packages/schema/catalog.ts";
import { withPublisherDatabase } from "./database-publication.ts";
import { prepareEnrichmentMedia, type PreparedEnrichmentMedia } from "./enrichment-media.ts";
import { packEnrichmentBatches, type EnrichmentCandidate } from "./enrichment-review.ts";
import { prepareJPEG } from "./images.ts";
import { mirrorPromptMediaBatch } from "./mirror-media.ts";
import { routedProvider } from "./model-routes.ts";
import { trustSystemCertificates } from "./models/http.ts";
import { estimateUSD } from "./models/pricing.ts";
import { ModelProviderError, type ModelUsage } from "./models/types.ts";
import { appendEvent, pipelineRoot, readEvents } from "./pipeline-control.ts";
import { atomic, contentRoot, json } from "./publication.ts";
import { applyReview, reviewBatch, reviewBlocker, type ReviewOutcome } from "./review-pass.ts";
import { locatePrompts, unmarkedPosts } from "./prompt-locate.ts";
import { modelTranslationProvider } from "./translation-provider.ts";
import { runTranslations } from "./translation-runner.ts";
import { attachTranslations, emptyTranslationCache, translationLocales } from "./translation.ts";
import { TwitterAPIClient } from "./twitterapi.ts";
import { pipelineEnvironment } from "./worker-maintenance.ts";
import { xAcquisitionsPerDay } from "./x-collection.ts";
import { convertXDiscovery } from "./x-intake.ts";
import { publishedXIdentities } from "./x-maintenance-admission.ts";
import { japanDay, portraitShare } from "./x-search-rules.ts";
import { curatedCreators, searchXDay, xDaySnapshots, type XDaySearch, type XRuleStats } from "./x-day-search.ts";
import { configuredXSpendBudget } from "./x-spend.ts";
import type { CreatorCache } from "./creators.ts";
import type { XPost } from "./x-intake.ts";

const dayMs = 24 * 3600000;
type Stage = { name: string; startedAt: number; finishedAt?: number };

/** Posts already searched by an earlier trial, so a rule change can be judged on the same day. */
async function replayedSearch(directory: string) {
  const names = (await readdir(join(directory, "x-discovery"))).filter(name => name.endsWith(".json")).sort();
  const snapshots = await Promise.all(names.map(async name => ({ name, data: JSON.parse(await readFile(join(directory, "x-discovery", name), "utf8")) })));
  // Trials before rules.json kept each drafted post's rule and engagement in results.json.
  const earlier = await json<{ id: string; rule: string; likes?: number; views?: number }[]>(join(directory, "results.json"), []);
  const rules = await json<Record<string, string>>(join(directory, "rules.json"), Object.fromEntries(earlier.map(row => [row.id.replace("x-post-", ""), row.rule])));
  return { snapshots, rules, metrics: earlier.map(row => [row.id.replace("x-post-", ""), { likes: row.likes, views: row.views }] as const), stats: await json<XRuleStats[]>(join(directory, "search.json"), []),
    summary: await json<{ window: { since: string; until: string } } | null>(join(directory, "summary.json"), null) };
}

export async function runTrial(options: { env: NodeJS.ProcessEnv; root?: string; now?: number; dailyPosts?: number; replay?: string; day?: string }) {
  const env = options.env, root = options.root ?? contentRoot, now = options.now ?? Date.now();
  const id = new Date(now).toISOString().replace(/[:.]/g, "-"), directory = join(root, "trials", id), task = `trial:${id}`;
  await mkdir(directory, { recursive: true });
  const stages: Stage[] = [];
  const stage = async <T>(name: string, work: () => Promise<T>) => {
    const entry: Stage = { name, startedAt: Date.now() }; stages.push(entry);
    try { return await work(); } finally { entry.finishedAt = Date.now(); await atomic(join(directory, "stages.json"), stages); }
  };
  const replay = options.replay ? await replayedSearch(join(root, "trials", options.replay)) : undefined;
  const window = replay?.summary ? { since: Date.parse(replay.summary.window.since) / 1000, until: Date.parse(replay.summary.window.until) / 1000 }
    : options.day ? japanDay(options.day) : { since: Math.floor((now - dayMs) / 1000), until: Math.floor(now / 1000) };
  const { since, until } = window;
  const dailyPosts = options.dailyPosts ?? xAcquisitionsPerDay(env);

  // 1. Search under the approved rules, admitting posts until each rule's quota is met.
  const creators = replay ? [] : await stage("creators", () => curatedCreators(env));
  const known = replay ? new Set<string>() : await stage("known", async () => new Set([...await withPublisherDatabase(publishedXIdentities, env)].map(value => value.replace("x-post-", ""))));
  const budget = configuredXSpendBudget(env);
  if (!replay && (!budget || !env.TWITTERAPI_IO_KEY)) throw new Error("The trial needs the TwitterAPI key and the shared X budget");
  const search: XDaySearch = replay ? { stats: replay.stats, admitted: new Map(), media: new Map(), profiles: new Map(), metrics: new Map() }
    : await stage("search", () => searchXDay(new TwitterAPIClient(env.TWITTERAPI_IO_KEY!, budget!), { since, until, dailyPosts, creators, known,
      progress: stats => atomic(join(directory, "search.json"), stats) }));
  const { stats, admitted, metrics } = search;
  if (!replay) await atomic(join(directory, "rules.json"), Object.fromEntries([...admitted].map(([post, entry]) => [post, entry.rule])));

  // 2. The same intake as the daily pipeline: prompt boundaries, modality, attribution.
  const snapshots = replay?.snapshots ?? [];
  if (replay) await stage("replay", async () => {
    for (const { name, data } of snapshots) await atomic(join(directory, "x-discovery", name), data);
    await atomic(join(directory, "search.json"), stats);
    for (const [post, rule] of Object.entries(replay.rules)) admitted.set(post, { post: { id: post } as XPost, rule });
    for (const [post, value] of replay.metrics) metrics.set(post, value);
    await atomic(join(directory, "rules.json"), replay.rules);
  });
  for (const [index, data] of xDaySnapshots(search, new Date(now).toISOString()).entries()) {
    const name = `trial-${String(index + 1).padStart(3, "0")}.json`;
    await atomic(join(directory, "x-discovery", name), data);
    snapshots.push({ name, data });
  }
  // Posts without a "Prompt:" heading go to the model, which points at the prompt in the author's text.
  const creatorCache = await json<CreatorCache>(join(root, "creators.json"), {});
  const pending = unmarkedPosts(snapshots, creatorCache);
  const locate = await stage("locate", async () => {
    if (!pending.length) return undefined;
    const routed = await routedProvider("review", task);
    return locatePrompts(routed.provider, pending, { effort: routed.effort, record: routed.record, now: new Date(now) });
  });
  const intake = convertXDiscovery(snapshots, creatorCache, locate?.excerpts ?? {});
  const ruleOf = (item: Prompt) => admitted.get(item.id.replace("x-post-", ""))?.rule ?? "unknown";

  // 3. Mirror media, then one review pass with the full gallery and frames.
  const mirrored = await stage("mirror", () => mirrorPromptMediaBatch(intake.candidates, root, 3));
  const ready = mirrored.prompts;
  const prepared = new Map<string, PreparedEnrichmentMedia>();
  await stage("media", async () => {
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < ready.length) { const item = ready[next++]; prepared.set(item.id, await prepareEnrichmentMedia(item, join(directory, "media", item.id), true)); }
    }));
  });
  const candidates: EnrichmentCandidate[] = ready.filter(item => !prepared.get(item.id)?.error).map(item => {
    const value = prepared.get(item.id)!;
    return { item, images: value.images.map(({ sourceRole: _, ...image }) => image), ...(value.video ? { video: value.video } : {}) };
  });
  const outcomes = new Map<string, ReviewOutcome & { model?: string }>();
  await stage("review", async () => {
    const routed = await routedProvider("review", task);
    const queue = packEnrichmentBatches(candidates, 6).map(batch => ({ batch, split: false }));
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (queue.length) {
        const { batch, split } = queue.shift()!;
        try {
          const result = await reviewBatch(routed.provider, batch, { effort: routed.effort, record: routed.record });
          for (const outcome of result.outcomes) outcomes.set(outcome.id, { ...outcome, model: result.model });
        } catch (error) {
          const code = error instanceof ModelProviderError ? error.code : "failed";
          if (code === "invalid_output" && batch.length > 1 && !split) queue.push(...batch.map(candidate => ({ batch: [candidate], split: true })));
          else for (const { item } of batch) outcomes.set(item.id, { id: item.id, ok: false, error: `${code}: ${(error as Error).message.slice(0, 200)}` });
        }
      }
    }));
  });

  // 4. Owner rules after review: the scale and minors gates, then the portrait share.
  type Row = { item: Prompt; rule: string; status: "published" | "rejected" | "deferred" | "failed"; reason?: string; reviewed?: Prompt };
  const rows: Row[] = intake.candidates.map(item => ({ item, rule: ruleOf(item), status: "failed", reason: "media" }));
  for (const row of rows) {
    const mirrorError = mirrored.errors.find(failure => failure.id === row.item.id);
    if (mirrorError) { row.reason = `媒体下载失败：${mirrorError.error}`; continue; }
    if (prepared.get(row.item.id)?.error) { row.reason = `媒体准备失败：${prepared.get(row.item.id)!.error}`; continue; }
    const outcome = outcomes.get(row.item.id);
    if (!outcome) { row.reason = "没有审核结果"; continue; }
    if (!outcome.ok) { row.reason = `审核输出无效：${outcome.error}`; continue; }
    const blocker = reviewBlocker(outcome.fields);
    const mirroredItem = ready.find(item => item.id === row.item.id)!;
    row.reviewed = applyReview(mirroredItem, outcome.fields);
    if (blocker) { row.status = "rejected"; row.reason = blocker; continue; }
    row.status = "published"; row.reason = undefined;
  }
  const accepted = rows.filter(row => row.status === "published");
  const portraitLimit = Math.ceil(accepted.length * portraitShare);
  let portraits = 0;
  for (const row of accepted) {
    const person = row.reviewed!.facets?.useCase.includes("portraits") || row.reviewed!.facets?.subject.includes("person");
    if (person && ++portraits > portraitLimit) { row.status = "deferred"; row.reason = `人像和人物超过当天 ${Math.round(portraitShare * 100)}%`; }
  }

  // 5. Nine languages for what would be published, through the translate route.
  const publishable = rows.filter(row => row.status === "published").map(row => row.reviewed!);
  const cache = emptyTranslationCache();
  const translation = await stage("translate", async () => {
    if (!publishable.length) return undefined;
    const routed = await routedProvider("translate", task);
    return runTranslations({ items: publishable, cache, provider: modelTranslationProvider(routed.provider, 24000, routed.record),
      providerName: "pipeline", model: routed.provider.model, locales: translationLocales, concurrency: 3, maxRequests: 400, maxUSD: 0,
      persist: async state => { await atomic(join(directory, "translations.json"), state); } });
  });
  const localized = new Map(attachTranslations(publishable, cache).map(item => [item.id, item]));

  // 6. Cost and the acceptance page.
  const events = (await readEvents(pipelineRoot(), Number.MAX_SAFE_INTEGER)).filter(event => event.task === task);
  const calls = events.filter(event => event.type === "model.call");
  const xSpend = (await json<{ entries?: { at: string; accounted?: number }[] }>(join(env.PROMPIX_X_SPEND_DIR ?? "", `${new Date(now).toISOString().slice(0, 7)}.json`), {}))
    .entries?.filter(entry => Date.parse(entry.at) >= now).reduce((sum, entry) => sum + (entry.accounted ?? 0), 0) ?? 0;
  const summary = {
    id, window: { since: new Date(since * 1000).toISOString(), until: new Date(until * 1000).toISOString() }, dailyPosts, creators: creators.length,
    search: stats, intake: { drafted: intake.candidates.length, blocked: intake.report.blocked, reasons: intake.report.reasons,
      ...(locate ? { located: { asked: pending.length, found: locate.located, none: locate.none, unmatched: locate.unmatched, failed: locate.failed } } : {}) },
    ...(options.replay ? { replayOf: options.replay } : {}),
    counts: Object.fromEntries((["published", "rejected", "deferred", "failed"] as const).map(status => [status, rows.filter(row => row.status === status).length])),
    stages: stages.map(entry => ({ name: entry.name, minutes: Math.round(((entry.finishedAt ?? Date.now()) - entry.startedAt) / 6000) / 10 })),
    cost: { xUSD: xSpend / 1e6, anthropicUSD: calls.filter(call => call.provider === "anthropic-api").reduce((sum, call) => sum + estimateUSD(String(call.model), call.usage as ModelUsage), 0),
      codexCalls: calls.filter(call => call.provider === "codex-cli").length, fallbacks: events.filter(event => event.type === "route.fallback").length },
    translation: translation ? { attempted: translation.attempted, failed: translation.failed, rejected: translation.rejected } : undefined,
  };
  await atomic(join(directory, "summary.json"), summary);
  const thumbnails = new Map<string, string>();
  for (const row of rows) {
    const source = prepared.get(row.item.id)?.images[0]?.path;
    if (!source) continue;
    const output = join(directory, "thumbs", `${row.item.id}.jpg`);
    await mkdir(join(directory, "thumbs"), { recursive: true });
    try { await prepareJPEG(source, output, 360); thumbnails.set(row.item.id, `data:image/jpeg;base64,${(await readFile(output)).toString("base64")}`); } catch { /* shown without a picture */ }
  }
  const results = rows.map(row => ({ id: row.item.id, rule: row.rule, status: row.status, reason: row.reason, kind: row.item.kind,
    url: row.item.source.url, creator: row.item.creator?.username, likes: metrics.get(row.item.id.replace("x-post-", ""))?.likes,
    views: metrics.get(row.item.id.replace("x-post-", ""))?.views, prompt: row.item.prompt.slice(0, 1200),
    reviewed: row.reviewed && { title: row.reviewed.title, summary: row.reviewed.summary, tags: row.reviewed.tags, model: row.reviewed.model,
      presentation: row.reviewed.presentation, facets: row.reviewed.facets, en: row.reviewed.localization?.en,
      languages: Object.keys(localized.get(row.item.id)?.localization?.translations ?? {}) },
    note: outcomes.get(row.item.id)?.ok ? (outcomes.get(row.item.id) as Extract<ReviewOutcome, { ok: true }>).fields.reasonNote : undefined,
    thumbnail: thumbnails.get(row.item.id) }));
  await atomic(join(directory, "results.json"), results);
  await appendEvent(pipelineRoot(), "worker", "trial.finished", { trial: id, counts: summary.counts });
  return { directory, summary };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  trustSystemCertificates();
  const option = (name: string) => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : undefined; };
  const replay = option("--replay"), day = option("--day");
  const result = await runTrial({ env: await pipelineEnvironment(), ...(replay ? { replay } : {}), ...(day ? { day } : {}) });
  await writeFile(join(result.directory, "done"), "");
  console.log(JSON.stringify({ event: "trial_finished", directory: result.directory, counts: result.summary.counts }));
}
