/** A real, unpublished run of the new pipeline for the owner's acceptance: today's X search
 * under the approved rules, the same intake, media mirroring, one review pass and translation
 * into nine languages, all through the configured routes and spend ledgers. Nothing is
 * published; everything lands in content/trials/<run>/ with an acceptance page. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { modelTranslationProvider } from "./translation-provider.ts";
import { runTranslations } from "./translation-runner.ts";
import { attachTranslations, emptyTranslationCache, translationLocales } from "./translation.ts";
import { TwitterAPIClient } from "./twitterapi.ts";
import { pipelineEnvironment } from "./worker-maintenance.ts";
import { xAcquisitionsPerDay } from "./x-collection.ts";
import { convertXDiscovery } from "./x-intake.ts";
import { publishedXIdentities } from "./x-maintenance-admission.ts";
import { creatorRules, perCreatorDaily, portraitShare, ruleQuery, ruleQuotas, xSearchRules, type XSearchRule } from "./x-search-rules.ts";
import { configuredXSpendBudget } from "./x-spend.ts";
import type { CreatorCache } from "./creators.ts";
import type { XMedia, XPost } from "./x-intake.ts";

const dayMs = 24 * 3600000;
type RuleStats = { rule: string; lane: string; kind: string; label: string; quota: number; requests: number; returned: number; admitted: number;
  known: number; capped: number; wrongMedia: number; error?: string };
type Stage = { name: string; startedAt: number; finishedAt?: number };

/** Curated creators: three or more live works, not dominated by portraits, most productive first. */
async function curatedCreators(env: NodeJS.ProcessEnv): Promise<string[]> {
  return withPublisherDatabase(async db => (await db.query<{ username: string }>(`
    select v.card#>>'{creator,username}' as username from prompix.state s
    join prompix.release_entries e on e.release_id = s.active_release join prompix.revisions v on v.id = e.revision_id
    join prompix.content c on c.id = e.content_id
    where s.singleton and c.removed_at is null and v.card#>>'{creator,platform}' = 'x' and v.card#>>'{creator,username}' ~ '^[A-Za-z0-9_]{1,15}$'
    group by 1 having count(*) >= 3
      and avg(case when coalesce(v.card->'facets'->'useCase','[]'::jsonb) ? 'portraits' then 1 else 0 end) <= 0.6
    order by count(*) desc, 1 limit 48`)).rows.map(row => row.username), env);
}

export async function runTrial(options: { env: NodeJS.ProcessEnv; root?: string; now?: number; dailyPosts?: number }) {
  const env = options.env, root = options.root ?? contentRoot, now = options.now ?? Date.now();
  const id = new Date(now).toISOString().replace(/[:.]/g, "-"), directory = join(root, "trials", id), task = `trial:${id}`;
  await mkdir(directory, { recursive: true });
  const stages: Stage[] = [];
  const stage = async <T>(name: string, work: () => Promise<T>) => {
    const entry: Stage = { name, startedAt: Date.now() }; stages.push(entry);
    try { return await work(); } finally { entry.finishedAt = Date.now(); await atomic(join(directory, "stages.json"), stages); }
  };
  const since = Math.floor((now - dayMs) / 1000), until = Math.floor(now / 1000);
  const dailyPosts = options.dailyPosts ?? xAcquisitionsPerDay(env);

  // 1. Search under the approved rules, admitting posts until each rule's quota is met.
  const creators = await stage("creators", () => curatedCreators(env));
  const searchRules: { rule: XSearchRule; creators: string[] }[] = [...xSearchRules.map(rule => ({ rule, creators: [] })), ...creatorRules(creators)];
  const quotas = ruleQuotas(searchRules.map(entry => entry.rule), dailyPosts);
  const known = await stage("known", async () => new Set([...await withPublisherDatabase(publishedXIdentities, env)].map(value => value.replace("x-post-", ""))));
  const budget = configuredXSpendBudget(env);
  if (!budget || !env.TWITTERAPI_IO_KEY) throw new Error("The trial needs the TwitterAPI key and the shared X budget");
  const client = new TwitterAPIClient(env.TWITTERAPI_IO_KEY, budget);
  const stats: RuleStats[] = [], admitted = new Map<string, { post: XPost; rule: string }>(), metrics = new Map<string, { likes?: number; views?: number }>();
  const media = new Map<string, XMedia>(), profiles = new Map<string, unknown>(), perCreator = new Map<string, number>();
  await stage("search", async () => {
    for (const { rule, creators: group } of searchRules) {
      const entry: RuleStats = { rule: rule.id, lane: rule.lane, kind: rule.kind, label: rule.label, quota: quotas.get(rule.id) ?? 0,
        requests: 0, returned: 0, admitted: 0, known: 0, capped: 0, wrongMedia: 0 };
      stats.push(entry);
      let cursor: string | undefined;
      try {
        for (let page = 0; page < 3 && entry.admitted < entry.quota; page++) {
          const { result } = await client.search(ruleQuery(rule, since, until, group), cursor, async raw => {
            for (const tweet of (raw as { tweets?: { id?: string; likeCount?: number; viewCount?: number }[] }).tweets ?? [])
              if (tweet.id) metrics.set(tweet.id, { likes: tweet.likeCount, views: tweet.viewCount });
          });
          entry.requests++; entry.returned += result.posts.length;
          for (const item of result.media) media.set(item.media_key, item);
          for (const creator of result.creators) profiles.set(creator.externalID ?? creator.id, creator);
          for (const post of result.posts) {
            if (entry.admitted >= entry.quota) break;
            if (known.has(post.id) || admitted.has(post.id)) { entry.known++; continue; }
            const kinds = (post.attachments?.media_keys ?? []).map(key => media.get(key)?.type);
            if (!kinds.some(kind => rule.kind === "video" ? kind === "video" : kind === "photo")) { entry.wrongMedia++; continue; }
            if ((perCreator.get(post.author_id) ?? 0) >= perCreatorDaily) { entry.capped++; continue; }
            perCreator.set(post.author_id, (perCreator.get(post.author_id) ?? 0) + 1);
            admitted.set(post.id, { post, rule: rule.id }); entry.admitted++;
          }
          cursor = result.nextToken;
          if (!cursor) break;
        }
      } catch (error) { entry.error = (error as Error).message.slice(0, 200); }
      await atomic(join(directory, "search.json"), stats);
    }
  });

  // 2. The same intake as the daily pipeline: prompt boundaries, modality, attribution.
  const posts = [...admitted.values()].map(entry => entry.post);
  const snapshots = [];
  for (let offset = 0; offset < posts.length; offset += 100) {
    const batch = posts.slice(offset, offset + 100), keys = new Set(batch.flatMap(post => post.attachments?.media_keys ?? []));
    const data = { provider: "twitterapi", capturedAt: new Date(now).toISOString(), posts: batch, media: [...media.values()].filter(item => keys.has(item.media_key)),
      creators: [...profiles.values()].filter(creator => batch.some(post => (creator as { externalID?: string }).externalID === post.author_id)) };
    const name = `trial-${String(offset / 100 + 1).padStart(3, "0")}.json`;
    await atomic(join(directory, "x-discovery", name), data);
    snapshots.push({ name, data });
  }
  const intake = convertXDiscovery(snapshots, await json<CreatorCache>(join(root, "creators.json"), {}));
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
    search: stats, intake: { drafted: intake.candidates.length, blocked: intake.report.blocked, reasons: intake.report.reasons },
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
  const result = await runTrial({ env: await pipelineEnvironment() });
  await writeFile(join(result.directory, "done"), "");
  console.log(JSON.stringify({ event: "trial_finished", directory: result.directory, counts: result.summary.counts }));
}
