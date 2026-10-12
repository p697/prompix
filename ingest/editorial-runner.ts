import { createHash } from "node:crypto";
import { isPublisherSkill, publisherSkillIssue } from "./publisher-skills.ts";
import { z } from "zod";
import type { Prompt } from "../packages/schema/catalog.ts";
import { repositories, fingerprint, type Candidate } from "./sources.ts";
import { skillSources } from "./skills.ts";
import { clawHubReviewEligibility, isClawHubItem } from "./clawhub.ts";
import { applyEditorialReviews, editorialMetadataSchema, type Reviews } from "./editorial.ts";
import { isNativeXDraft, nativeXSourceIssue, nativeXSourceDigest } from "./x-source.ts";
import { appendReviewAttempt, replaceReviewAttempt, reviewLedgerSchema, reviewRequestLimit } from "./review-budget.ts";

export const editorialVersion = 1;
export const editorialModel = "gpt-5.6-luna";
export const automaticMetadataSchema = z.object({
  title: z.string().trim().min(1).max(80), summary: z.string().trim().min(1).max(500),
  example: z.string().trim().min(1).max(1200).regex(/^使用建议：/),
  tags: z.array(z.string().trim().min(1).max(40)).min(1).max(6),
  previewLabel: z.enum(["提示词主题", "来源附图", "来源视频", "来源网页", "Skill 使用说明"]),
  cover: z.object({ text: z.string().trim().min(1).max(100), eyebrow: z.string().trim().min(1).max(40),
    tone: z.enum(["sage", "clay", "ink", "sky", "cream"]) }).strict().nullable(),
}).strict();
export const editorialDecisionSchema = z.object({
  id: z.string(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  outputKind: z.enum(["text", "image", "video", "web", "skill", "unknown"]),
  decision: z.enum(["approve", "defer", "reject"]), reason: z.string().trim().min(1).max(500),
  metadata: automaticMetadataSchema.nullable(),
}).strict();
export const editorialOutputSchema = z.object({ decisions: z.array(editorialDecisionSchema).min(1).max(3) }).strict();
export type EditorialDecision = z.infer<typeof editorialDecisionSchema>;
const savedDecisionSchema = editorialDecisionSchema.partial({ outputKind: true }).extend({ reviewedAt: z.iso.datetime(), model: z.string(), sourceRevision: z.string().min(1).max(200).optional(), reviewContext: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const editorialCacheSchema = z.object({ version: z.literal(editorialVersion), decisions: z.record(z.string(), savedDecisionSchema) }).strict().superRefine((cache, context) => {
  for (const [key, decision] of Object.entries(cache.decisions)) if (key !== `${decision.id}:${decision.fingerprint}${decision.sourceRevision ? `:${decision.sourceRevision}` : ""}${decision.reviewContext ? `:${decision.reviewContext}` : ""}`)
    context.addIssue({ code: "custom", path: ["decisions", key], message: "Decision cache identity mismatch" });
});
export type EditorialCache = z.infer<typeof editorialCacheSchema>;
export const editorialAttemptSchema = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), requests: z.literal(1),
  model: z.literal(editorialModel), reservedAt: z.iso.datetime(), candidateIDs: z.array(z.string()).min(1).max(3),
  inputCharacters: z.number().int().min(1).max(36000), state: z.enum(["reserved", "completed", "failed"]),
  inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(),
  error: z.string().max(500).optional(),
}).strict();
export const editorialLedgerSchema = reviewLedgerSchema(editorialAttemptSchema);
export type EditorialAttempt = z.infer<typeof editorialAttemptSchema>;
export type EditorialLedger = z.output<typeof editorialLedgerSchema>;
export type EditorialInput = ReturnType<typeof editorialInput>;
export type EditorialProvider = (items: EditorialInput[]) => Promise<{ decisions: unknown; inputTokens?: number; outputTokens?: number }>;
export type EditorialReport = { status: "disabled" | "no-pending" | "daily-limit" | "reviewed" | "failed";
  pending: number; eligible: number; requests: number; dailyRequests: number; maxRequests: number; attemptedCandidates: number; approved: number; deferred: number; rejected: number;
  cachedDecisions: number; preflightDeferred: number; inputCharacters: number; model: string; error?: string };
type ReviewIdentityInput = Pick<Candidate, "id" | "fingerprint"> & Partial<Pick<Candidate, "source" | "skill">>;
export function editorialReviewContext(item: ReviewIdentityInput): string | undefined {
  if (!item.source || !isPublisherSkill({ id: item.id, source: item.source })) return;
  return createHash("sha256").update(JSON.stringify(["publisher-package-2", item.skill ?? null])).digest("hex");
}
export const editorialDecisionKey = (item: ReviewIdentityInput) => {
  const bound = (item.source && isPublisherSkill({ id: item.id, source: item.source })) || item.id.startsWith("skill-publisher-") ||
    item.id.startsWith("skill-clawhub-") || item.source?.name === "ClawHub" || item.source?.name === "X";
  const context = editorialReviewContext(item);
  return `${item.id}:${item.fingerprint}${bound && item.source?.revision ? `:${item.source.revision}` : ""}${context ? `:${context}` : ""}`;
};

function previewLabel(item: Candidate) {
  return item.contentType === "skill" ? "Skill 使用说明" : ({ text: "提示词主题", image: "来源附图", video: "来源视频", web: "来源网页" } as const)[item.kind];
}
export function editorialInput(item: Candidate) {
  return { id: item.id, fingerprint: item.fingerprint, kind: item.kind, contentType: item.contentType ?? "prompt",
    expectedOutputKind: item.contentType === "skill" ? "skill" : item.kind,
    title: item.title, summary: item.summary, prompt: item.prompt, model: item.model, source: item.source,
    hasImage: !!item.media?.imageURL, hasVideo: !!item.media?.videoURL, hasDemo: !!item.media?.demoURL,
    requiredPreviewLabel: previewLabel(item),
    ...(item.skill ? { skillPackage: { ...item.skill, revision: item.source.revision } } : {}) };
}
export function automaticReviewEligibility(item: Candidate): string | undefined {
  const nativeX = isNativeXDraft(item);
  if (nativeX) {
    const issue = nativeXSourceIssue(item); if (issue) return issue;
    if (nativeXSourceDigest(item) !== item.source.revision) return "X source revision does not match its captured post";
  }
  if (item.fingerprint !== fingerprint(item.prompt)) return "Source fingerprint does not match its complete instructions";
  const revision = item.source.revision;
  const registry = isClawHubItem(item);
  if (registry) { const reason = clawHubReviewEligibility(item); if (reason) return reason; }
  else if (!nativeX && (!revision || !/^[a-f0-9]{40}$/.test(revision))) return "Missing immutable source revision";
  const community = item.source.name === "prompts.chat" && item.source.license === "CC0-1.0"
    && item.source.url === `https://github.com/f/prompts.chat/blob/${revision}/prompts.csv`;
  const youmind = item.source.name === "YouMind OpenLab" && item.source.license === "CC-BY-4.0"
    && repositories.some(source => item.source.repository === `https://github.com/${source.repo}` && item.id.startsWith(source.id + "-"));
  const skill = item.contentType === "skill" && item.source.license === "Apache-2.0" && skillSources.some(source => {
    const repository = `https://github.com/${source.repo}`;
    return item.id === `skill-${source.id}` && item.source.name === `${source.publisher} Skills`
      && item.source.repository === repository && item.skill?.repository === repository && item.skill.directory === source.directory
      && item.source.url === `${repository}/blob/${revision}/${source.directory}/SKILL.md`;
  });
  const publisher = isPublisherSkill(item);
  if (publisher) { const issue = publisherSkillIssue(item); if (issue) return issue; }
  if (!community && !youmind && !skill && !registry && !nativeX && !publisher) return "Source is outside the automatic-review allowlist";
  if (item.prompt.trim().length < 20) return "Insufficient complete copyable instructions";
  if (item.kind === "image" && !item.media?.imageURL) return "A real source image is required";
  if (item.kind === "video" && !(item.media?.imageURL && item.media.videoURL)) return "A real source poster and clip are required";
  if (item.kind === "web" && !(item.media?.imageURL && item.media.demoURL)) return "A real webpage preview and demo are required";
  if (JSON.stringify([editorialInput(item)]).length > 36000) return "Complete source exceeds the bounded review input; manual review required";
}

/** Published edits first, then stable round-robin across source/modality shelves. */
export function editorialQueue(items: readonly Candidate[], previous: readonly Prompt[], rotation = 0): Candidate[] {
  const published = new Set(previous.map(item => item.id));
  const edited = items.filter(item => published.has(item.id)).sort((a, b) => a.id.localeCompare(b.id));
  const shelves = new Map<string, Candidate[]>();
  for (const item of items.filter(item => !published.has(item.id))) {
    const key = `${item.source.name}:${item.contentType === "skill" ? "skill" : item.kind}`;
    const shelf = shelves.get(key) ?? []; shelf.push(item); shelves.set(key, shelf);
  }
  const sortedGroups = [...shelves.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, values]) =>
    values.sort((a, b) => Number(b.featured) - Number(a.featured) || a.id.localeCompare(b.id)));
  const offset = sortedGroups.length ? rotation % sortedGroups.length : 0;
  const groups = [...sortedGroups.slice(offset), ...sortedGroups.slice(0, offset)];
  const queue = [...edited];
  for (let index = 0; groups.some(group => index < group.length); index++) for (const group of groups) if (group[index]) queue.push(group[index]);
  return queue;
}

export async function runEditorialReview(options: { candidates: readonly Candidate[]; previous: readonly Prompt[]; reviews: Reviews;
  cache: EditorialCache; ledger?: EditorialLedger | EditorialAttempt; day: string; provider?: EditorialProvider; now?: string; maxRequests?: number;
  persistCache: (cache: EditorialCache) => Promise<void>; persistReviews: (reviews: Reviews) => Promise<void>;
  persistLedger: (ledger: EditorialLedger) => Promise<void>;
}) {
  const now = options.now ?? new Date().toISOString();
  const maxRequests = reviewRequestLimit(options.maxRequests);
  const savedLedger = options.ledger === undefined ? undefined : editorialLedgerSchema.parse(options.ledger);
  let ledger = savedLedger?.day === options.day ? savedLedger : undefined;
  const pending = options.candidates.filter(item => options.reviews[item.id]?.fingerprint !== item.fingerprint
    || ((isPublisherSkill(item) || isClawHubItem(item) || isNativeXDraft(item)) && options.reviews[item.id]?.sourceRevision !== item.source.revision));
  const report: EditorialReport = { status: options.provider ? "no-pending" : "disabled", pending: pending.length, eligible: 0,
    requests: 0, dailyRequests: ledger?.requests ?? 0, maxRequests, attemptedCandidates: 0, approved: 0, deferred: 0, rejected: 0,
    cachedDecisions: 0, preflightDeferred: 0, inputCharacters: 0, model: editorialModel };
  if (!options.provider) return { reviews: options.reviews, report };
  const cache = structuredClone(options.cache);
  const eligible: Candidate[] = [];
  for (const item of pending) {
    const key = editorialDecisionKey(item);
    const reason = automaticReviewEligibility(item);
    const cached = cache.decisions[key];
    if (cached && (cached.model !== "preflight-v1" || cached.reason === reason)) { report.cachedDecisions++; continue; }
    if (cached) delete cache.decisions[key];
    if (reason) {
      cache.decisions[key] = { id: item.id, fingerprint: item.fingerprint, decision: "defer", reason, metadata: null, reviewedAt: now, model: "preflight-v1",
        ...(editorialReviewContext(item) ? { reviewContext: editorialReviewContext(item) } : {}),
        ...((isPublisherSkill(item) || isClawHubItem(item) || isNativeXDraft(item)) ? { sourceRevision: item.source.revision } : {}) };
      report.preflightDeferred++;
    } else eligible.push(item);
  }
  if (report.preflightDeferred) await options.persistCache(cache);
  report.eligible = eligible.length;
  if ((ledger?.requests ?? 0) >= maxRequests || ledger?.attempts.some(attempt => attempt.state !== "completed")) {
    report.status = "daily-limit"; return { reviews: options.reviews, report };
  }
  // A completed reservation remains spent even if its cache or approvals are later missing.
  const attemptedIDs = new Set(ledger?.attempts.flatMap(attempt => attempt.candidateIDs) ?? []);
  const rotation = Math.floor(Date.parse(options.day + "T00:00:00Z") / 86400000);
  let queue = editorialQueue(eligible, options.previous, rotation).filter(item => !attemptedIDs.has(item.id));
  let reviews = options.reviews;
  while (queue.length && (ledger?.requests ?? 0) < maxRequests) {
    const selected: Candidate[] = [];
    for (const item of queue) {
      if (selected.length >= 3) break;
      if (JSON.stringify([...selected, item].map(editorialInput)).length <= 36000) selected.push(item);
    }
    if (!selected.length) break;
    const selectedIDs = new Set(selected.map(item => item.id));
    queue = queue.filter(item => !selectedIDs.has(item.id));
    const input = selected.map(editorialInput);
    const attempt: EditorialAttempt = { day: options.day, requests: 1, model: editorialModel, reservedAt: now,
      candidateIDs: selected.map(item => item.id), inputCharacters: JSON.stringify(input).length, state: "reserved" };
    const reserved = appendReviewAttempt(ledger, attempt);
    // Reserve before calling. An ambiguous/failed attempt blocks the rest of this UTC day.
    await options.persistLedger(reserved);
    ledger = reserved;
    report.requests++; report.dailyRequests = ledger.requests;
    report.attemptedCandidates += selected.length; report.inputCharacters += attempt.inputCharacters;
    try {
      const result = await options.provider(input);
      const decisions = editorialOutputSchema.parse({ decisions: result.decisions }).decisions;
      const missing = selected.filter(item => !decisions.some(value => value.id === item.id)).map(item => item.id);
      const unexpected = decisions.filter(item => !selected.some(value => value.id === item.id)).map(item => item.id);
      const mismatch = decisions.filter(item => selected.some(value => value.id === item.id && value.fingerprint !== item.fingerprint)).map(item => item.id);
      const duplicates = decisions.filter((item, index) => decisions.findIndex(value => value.id === item.id) !== index).map(item => item.id);
      if (missing.length || unexpected.length || mismatch.length || duplicates.length || decisions.length !== selected.length)
        throw new Error(`Review identity mismatch: missing=${missing.join(",")}; unexpected=${unexpected.join(",")}; fingerprint=${mismatch.join(",")}; duplicate=${duplicates.join(",")}`);
      const nextReviews = { ...reviews };
      const nextDecisions = { ...cache.decisions };
      for (const decision of decisions) {
        const candidate = selected.find(item => item.id === decision.id)!;
        const expectedKind = candidate.contentType === "skill" ? "skill" : candidate.kind;
        if (decision.decision === "approve" && decision.outputKind !== expectedKind) {
          decision.decision = "defer";
          decision.reason = `Output modality ${decision.outputKind} does not match catalog kind ${expectedKind}; source classification and preview need review`;
          decision.metadata = null;
        }
        if (decision.decision === "approve") {
          if (!decision.metadata || decision.metadata.previewLabel !== previewLabel(candidate)) throw new Error("Approval is missing honest editorial metadata");
          const { cover, ...metadata } = decision.metadata;
          const entry = { fingerprint: candidate.fingerprint, reviewedAt: now,
            ...((isPublisherSkill(candidate) || isClawHubItem(candidate) || isNativeXDraft(candidate)) ? { sourceRevision: candidate.source.revision } : {}),
            metadata: editorialMetadataSchema.parse({ ...metadata, ...(cover ? { cover } : {}) }) };
          if (applyEditorialReviews([candidate], { [candidate.id]: entry })[0].reviewStatus !== "candidate") throw new Error("Approval has no complete source preview");
          nextReviews[candidate.id] = entry;
        } else if (decision.metadata !== null) throw new Error("A deferred or rejected review cannot supply publication metadata");
        nextDecisions[editorialDecisionKey(candidate)] = { ...decision, reviewedAt: now, model: editorialModel,
            ...(editorialReviewContext(candidate) ? { reviewContext: editorialReviewContext(candidate) } : {}),
          ...((isPublisherSkill(candidate) || isClawHubItem(candidate) || isNativeXDraft(candidate)) ? { sourceRevision: candidate.source.revision } : {}) };
      }
      // Save approvals before their decision cache, so a cache-only success can
      // never prevent an approved record from reaching the existing review gate.
      await options.persistReviews(nextReviews);
      await options.persistCache({ ...cache, decisions: nextDecisions });
      const completed = { ...attempt, state: "completed" as const };
      if (Number.isInteger(result.inputTokens) && result.inputTokens! >= 0) completed.inputTokens = result.inputTokens;
      if (Number.isInteger(result.outputTokens) && result.outputTokens! >= 0) completed.outputTokens = result.outputTokens;
      const nextLedger = replaceReviewAttempt(ledger, completed);
      await options.persistLedger(nextLedger);
      ledger = nextLedger; reviews = nextReviews; cache.decisions = nextDecisions;
      report.status = "reviewed";
      report.approved += decisions.filter(item => item.decision === "approve").length;
      report.deferred += decisions.filter(item => item.decision === "defer").length;
      report.rejected += decisions.filter(item => item.decision === "reject").length;
    } catch (error) {
      report.status = "failed"; report.error = (error instanceof Error ? error.message : "Editorial review failed").slice(0, 500);
      await options.persistLedger(replaceReviewAttempt(ledger, { ...attempt, state: "failed", error: report.error }));
      break;
    }
  }
  return { reviews, report };
}
