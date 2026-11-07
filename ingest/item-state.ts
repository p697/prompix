import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Candidate } from "./sources.ts";
import { mergeCandidates, repositories, videoArchive } from "./sources.ts";
import { applyEditorialReviews, reviewsSchema, type Reviews } from "./editorial.ts";
import { automaticReviewEligibility, editorialCacheSchema, editorialDecisionKey, editorialVersion, type EditorialCache } from "./editorial-runner.ts";
import { libraryIssue } from "./library.ts";
import { visualCacheSchema, visualReviewVersion, type VisualCache } from "./visual-review.ts";
import { readExclusions, type Exclusion } from "./exclusion-log.ts";
import { readQualityHolds, type QualityHolds } from "./quality-holds.ts";
import { filterXAvailability, readXAvailability, type XAvailabilityState } from "./x-availability.ts";
import { isNativeXDraft, xSourceLifetime } from "./x-source.ts";
import { atomic, json, moderationSchema } from "./publication.ts";
import { withPublisherDatabase } from "./database-publication.ts";

/**
 * Every collected item is in exactly one state:
 * - live / removed: decided by the database;
 * - excluded: a final "no", with the stage and reason that decided it. A model's deferral or an uncertain visual
 *   verdict counts: both are cached for the exact content and never sent again, and nobody reviews by hand;
 * - waiting: an automatic step will pick it up (editorial, visual review, a publication slot);
 * - stalled: it is not live and not excluded, but no automatic step will ever move it.
 * Stalled items break the rule that the pipeline decides every item, so they are counted and reported.
 */
export type ItemState = "live" | "removed" | "excluded" | "waiting" | "stalled";
export type ItemStage = "source" | "editorial" | "library" | "visual" | "quality" | "enrichment" | "publication";
export type ItemStatus = { id: string; source: string; kind: Candidate["kind"]; state: ItemState; stage?: ItemStage; reason: string; since?: string };

export type ItemStateInput = {
  candidates: readonly { source: string; items: readonly Candidate[] }[];
  live: ReadonlySet<string>; removed: ReadonlySet<string>;
  moderation: { removedIDs: readonly string[]; history?: readonly unknown[] };
  reviews: Reviews; editorial: EditorialCache; visual: VisualCache; enrichmentExclusions: readonly Exclusion[];
  qualityHolds: QualityHolds; xAvailability: XAvailabilityState; now: number;
};

const retiredSources = new Set<string>([...repositories.map(source => source.id), videoArchive.id]);
// Preflight reasons that judge the content itself; any other preflight reason is a defect nobody will repair.
const finalPreflight = [/automatic-review allowlist/, /Insufficient complete copyable instructions/, /A real (source image|source poster|webpage preview)/, /publishable length/];

/** Classifies the daily lane in pipeline order: source, editorial, library rules, visual review, holds, 2.0 review, publication. */
export function classifyItems(input: ItemStateInput): ItemStatus[] {
  const sourceOf = new Map<string, string>();
  for (const group of input.candidates) for (const item of group.items) if (!sourceOf.has(item.id)) sourceOf.set(item.id, group.source);
  const items = mergeCandidates(...input.candidates.map(group => [...group.items]));
  const removedByModeration = new Set(input.moderation.removedIDs);
  const moderationReason = new Map((input.moderation.history ?? []).flatMap(entry => {
    const { id, reason } = (entry ?? {}) as { id?: unknown; reason?: unknown };
    return typeof id === "string" && typeof reason === "string" ? [[id, reason] as const] : [];
  }));
  const xVisible = new Set(filterXAvailability(items, input.xAvailability, input.now).prompts.map(item => item.id));
  const reviewed = new Map(applyEditorialReviews(items, input.reviews).map(item => [item.id, item]));
  const visualByID = new Map<string, VisualCache["decisions"][string]>();
  for (const decision of Object.values(input.visual.decisions)) {
    const current = visualByID.get(decision.id);
    if (!current || decision.reviewedAt > current.reviewedAt) visualByID.set(decision.id, decision);
  }
  const enrichment = new Map<string, Exclusion>();
  for (const entry of input.enrichmentExclusions) enrichment.set(entry.id, entry);
  // The library keeps one item per fingerprint; a copy of a live item is not a pending item.
  const liveFingerprints = new Set(items.filter(item => input.live.has(item.id)).map(item => item.fingerprint));

  return items.map(item => {
    const base = { id: item.id, source: sourceOf.get(item.id) ?? "unknown", kind: item.kind };
    const status = (state: ItemState, reason: string, stage?: ItemStage, since?: string): ItemStatus => ({ ...base, state, reason, ...(stage ? { stage } : {}), ...(since ? { since } : {}) });
    if (input.live.has(item.id)) return status("live", "已上线");
    if (input.removed.has(item.id)) return status("removed", moderationReason.get(item.id) ?? "已下架");
    if (retiredSources.has(base.source)) return status("excluded", "来源已停用，不再发布", "source");
    if (removedByModeration.has(item.id)) return status("excluded", moderationReason.get(item.id) ?? "已被下架处理", "source");
    // A final "no" from any later stage outranks a source check that could still be refreshed.
    const decision = input.editorial.decisions[editorialDecisionKey(item)];
    if (decision?.decision === "reject") return status("excluded", decision.reason, "editorial", decision.reviewedAt);
    const visual = visualByID.get(item.id);
    if (visual?.presentation === "explicit") return status("excluded", "画面露骨", "visual", visual.reviewedAt);
    if (visual?.verdict === "mismatch") return status("excluded", visual.reason, "visual", visual.reviewedAt);
    const hold = input.qualityHolds.holds[item.id];
    if (hold) return status("excluded", hold.reason, "quality");
    const excluded = enrichment.get(item.id);
    if (excluded) return status("excluded", excluded.reason, "enrichment", excluded.at);
    // A cached model deferral is final for this content; refreshing the source would not change it.
    if (decision?.decision === "defer" && decision.model !== "preflight-v1" && reviewed.get(item.id)!.reviewStatus !== "candidate")
      return status("excluded", decision.reason, "editorial", decision.reviewedAt);
    if (isNativeXDraft(item) && !xVisible.has(item.id)) {
      const record = input.xAvailability[item.id];
      if (record?.removed) return status("excluded", "原帖已删除", "source", record.checkedAt);
      // Maintenance rechecks published posts only, so an unpublished draft whose check lapsed is never checked again.
      const lapsed = record && item.source.post ? new Date(Date.parse(record.checkedAt) + xSourceLifetime(item.source.post.createdAt, Date.parse(record.checkedAt))).toISOString() : undefined;
      return status("stalled", record?.status === "withheld" ? "原帖已改动或无法确认，未上线的草稿没有任何环节会再复查"
        : "原帖复查已过期，未上线的草稿没有任何环节会再复查", "source", lapsed);
    }
    const approved = reviewed.get(item.id)!;
    if (approved.reviewStatus !== "candidate") {
      const review = input.reviews[item.id];
      if (review?.fingerprint === item.fingerprint && (!item.source.revision || !review.sourceRevision || review.sourceRevision === item.source.revision))
        return status("stalled", "编辑审核已通过，但来源校验不再通过", "editorial", review.reviewedAt);
      const preflight = automaticReviewEligibility(item);
      if (decision?.model === "preflight-v1" && decision.reason === preflight)
        return finalPreflight.some(pattern => pattern.test(preflight)) ? status("excluded", preflight, "editorial", decision.reviewedAt) : status("stalled", preflight, "editorial", decision.reviewedAt);
      if (preflight) return finalPreflight.some(pattern => pattern.test(preflight)) ? status("excluded", preflight, "editorial") : status("stalled", preflight, "editorial");
      return status("waiting", "等待编辑审核", "editorial");
    }
    if (liveFingerprints.has(item.fingerprint)) return status("excluded", "与线上已有条目重复", "library");
    const rule = libraryIssue(approved, removedByModeration);
    if (rule) return status("excluded", rule, "library");
    if (visual?.verdict === "uncertain") return status("excluded", visual.reason, "visual", visual.reviewedAt);
    if (!visual && approved.media?.imageURL && approved.kind !== "web") return status("waiting", "等待图片审核", "visual");
    return status("waiting", "等待发布名额", "publication");
  });
}

export type FunnelSummary = { at: string; total: number; counts: Record<ItemState, number>;
  bySource: Record<string, Record<ItemState, number>>;
  stalled: { reason: string; stage?: ItemStage; count: number }[]; newlyStalled: number };

const emptyCounts = (): Record<ItemState, number> => ({ live: 0, removed: 0, excluded: 0, waiting: 0, stalled: 0 });
// Model wording varies per item; group stalled items by what a fix would target.
function stalledGroup(item: ItemStatus): string {
  if (item.stage === "editorial" && /expectedOutputKind|outputKind|catalog kind|与 .{0,20}不一致|不一致/.test(item.reason)) return "编辑审核暂缓：内容类型对不上";
  if (item.stage === "editorial" && /截断|truncat/i.test(item.reason)) return "编辑审核暂缓：正文被截断";
  if (item.stage === "editorial" && !/^[\x20-\x7e]+$/.test(item.reason)) return "编辑审核暂缓：其他原因";
  if (item.stage === "editorial" && /manual review required/.test(item.reason)) return "原文超出审核输入上限，写着待人工，但没有人工环节";
  if (item.stage === "visual") return "图片审核存疑";
  return item.reason;
}

export function summarizeFunnel(statuses: readonly ItemStatus[], now: number, window = 24 * 3600_000): FunnelSummary {
  const counts = emptyCounts(), bySource: FunnelSummary["bySource"] = {}, groups = new Map<string, { stage?: ItemStage; count: number }>();
  let newlyStalled = 0;
  for (const item of statuses) {
    counts[item.state]++;
    (bySource[item.source] ??= emptyCounts())[item.state]++;
    if (item.state !== "stalled") continue;
    const key = stalledGroup(item), group = groups.get(key) ?? { stage: item.stage, count: 0 };
    group.count++; groups.set(key, group);
    if (item.since && now - Date.parse(item.since) < window && Date.parse(item.since) <= now) newlyStalled++;
  }
  return { at: new Date(now).toISOString(), total: statuses.length, counts, bySource, newlyStalled,
    stalled: [...groups].map(([reason, group]) => ({ reason, ...group })).sort((a, b) => b.count - a.count) };
}

/** Reads every store the daily lane decides from; the database is the authority for live and removed items. */
export async function collectItemStates(root: string, environment: NodeJS.ProcessEnv, now = Date.now()): Promise<ItemStatus[]> {
  const directory = join(root, "candidates");
  const files = (await readdir(directory)).filter(name => name.endsWith(".json")).sort();
  const candidates = await Promise.all(files.map(async name => ({ source: basename(name, ".json"), items: await json<Candidate[]>(join(directory, name), []) })));
  const { live, removed } = await withPublisherDatabase(async db => {
    const rows = (await db.query<{ id: string; removed: boolean }>("select id, removed_at is not null as removed from prompix.content where first_published_at is not null")).rows;
    return { live: new Set(rows.filter(row => !row.removed).map(row => row.id)), removed: new Set(rows.filter(row => row.removed).map(row => row.id)) };
  }, environment);
  return classifyItems({ candidates, live, removed, now,
    moderation: moderationSchema.parse(await json(join(root, "moderation.json"), { removedIDs: [] })),
    reviews: reviewsSchema.parse(await json(join(root, "editorial.json"), {})),
    editorial: editorialCacheSchema.parse(await json(join(root, "editorial", "decisions.json"), { version: editorialVersion, decisions: {} })),
    visual: visualCacheSchema.parse(await json(join(root, "visual-review", "decisions.json"), { version: visualReviewVersion, decisions: {} })),
    enrichmentExclusions: await readExclusions(join(root, "enrichment", "exclusions.jsonl")),
    qualityHolds: await readQualityHolds(root), xAvailability: await readXAvailability(root) });
}

export const funnelSnapshotFile = "funnel.json";
export async function saveFunnelSnapshot(pipelineDirectory: string, summary: FunnelSummary) {
  await atomic(join(pipelineDirectory, funnelSnapshotFile), summary);
}
export async function readFunnelSnapshot(pipelineDirectory: string): Promise<FunnelSummary | undefined> {
  return json<FunnelSummary | undefined>(join(pipelineDirectory, funnelSnapshotFile), undefined);
}
