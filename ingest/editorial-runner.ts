import { z } from "zod";
import type { Prompt } from "../packages/schema/catalog.ts";
import { repositories, fingerprint, type Candidate } from "./sources.ts";
import { skillSources } from "./skills.ts";
import { applyEditorialReviews, editorialMetadataSchema, type Reviews } from "./editorial.ts";
import { isNativeXDraft, nativeXPublicationBlocker } from "./x-intake.ts";

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
  decision: z.enum(["approve", "defer", "reject"]), reason: z.string().trim().min(1).max(500),
  metadata: automaticMetadataSchema.nullable(),
}).strict();
export const editorialOutputSchema = z.object({ decisions: z.array(editorialDecisionSchema).min(1).max(3) }).strict();
export type EditorialDecision = z.infer<typeof editorialDecisionSchema>;
const savedDecisionSchema = editorialDecisionSchema.extend({ reviewedAt: z.iso.datetime(), model: z.string() }).strict();
export const editorialCacheSchema = z.object({ version: z.literal(editorialVersion), decisions: z.record(z.string(), savedDecisionSchema) }).strict().superRefine((cache, context) => {
  for (const [key, decision] of Object.entries(cache.decisions)) if (key !== `${decision.id}:${decision.fingerprint}`)
    context.addIssue({ code: "custom", path: ["decisions", key], message: "Decision cache identity mismatch" });
});
export type EditorialCache = z.infer<typeof editorialCacheSchema>;
export const editorialLedgerSchema = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), requests: z.literal(1),
  model: z.literal(editorialModel), reservedAt: z.iso.datetime(), candidateIDs: z.array(z.string()).min(1).max(3),
  inputCharacters: z.number().int().min(1).max(16000), state: z.enum(["reserved", "completed", "failed"]),
  inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(),
  error: z.string().max(500).optional(),
}).strict();
export type EditorialLedger = z.infer<typeof editorialLedgerSchema>;
export type EditorialInput = ReturnType<typeof editorialInput>;
export type EditorialProvider = (items: EditorialInput[]) => Promise<{ decisions: unknown; inputTokens?: number; outputTokens?: number }>;
export type EditorialReport = { status: "disabled" | "no-pending" | "daily-limit" | "reviewed" | "failed";
  pending: number; eligible: number; requests: number; attemptedCandidates: number; approved: number; deferred: number; rejected: number;
  cachedDecisions: number; preflightDeferred: number; inputCharacters: number; model: string; error?: string };
export const editorialDecisionKey = (item: Pick<Candidate, "id" | "fingerprint">) => `${item.id}:${item.fingerprint}`;

function previewLabel(item: Candidate) {
  return item.contentType === "skill" ? "Skill 使用说明" : ({ text: "提示词主题", image: "来源附图", video: "来源视频", web: "来源网页" } as const)[item.kind];
}
export function editorialInput(item: Candidate) {
  return { id: item.id, fingerprint: item.fingerprint, kind: item.kind, contentType: item.contentType ?? "prompt",
    title: item.title, summary: item.summary, prompt: item.prompt, model: item.model, source: item.source,
    hasImage: !!item.media?.imageURL, hasVideo: !!item.media?.videoURL, hasDemo: !!item.media?.demoURL,
    requiredPreviewLabel: previewLabel(item) };
}
export function automaticReviewEligibility(item: Candidate): string | undefined {
  if (isNativeXDraft(item)) return nativeXPublicationBlocker;
  if (item.fingerprint !== fingerprint(item.prompt)) return "Source fingerprint does not match its complete instructions";
  const revision = item.source.revision;
  if (!revision || !/^[a-f0-9]{40}$/.test(revision)) return "Missing immutable source revision";
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
  if (!community && !youmind && !skill) return "Source is outside the automatic-review allowlist";
  if (item.prompt.trim().length < 20) return "Insufficient complete copyable instructions";
  if (item.kind === "image" && !item.media?.imageURL) return "A real source image is required";
  if (item.kind === "video" && !(item.media?.imageURL && item.media.videoURL)) return "A real source poster and clip are required";
  if (item.kind === "web" && !(item.media?.imageURL && item.media.demoURL)) return "A real webpage preview and demo are required";
  if (JSON.stringify([editorialInput(item)]).length > 16000) return "Complete source exceeds the bounded review input; manual review required";
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
  cache: EditorialCache; ledger?: EditorialLedger; day: string; provider?: EditorialProvider; now?: string;
  persistCache: (cache: EditorialCache) => Promise<void>; persistReviews: (reviews: Reviews) => Promise<void>;
  persistLedger: (ledger: EditorialLedger) => Promise<void>;
}) {
  const now = options.now ?? new Date().toISOString();
  const pending = options.candidates.filter(item => options.reviews[item.id]?.fingerprint !== item.fingerprint);
  const report: EditorialReport = { status: options.provider ? "no-pending" : "disabled", pending: pending.length, eligible: 0,
    requests: 0, attemptedCandidates: 0, approved: 0, deferred: 0, rejected: 0, cachedDecisions: 0, preflightDeferred: 0,
    inputCharacters: 0, model: editorialModel };
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
      cache.decisions[key] = { id: item.id, fingerprint: item.fingerprint, decision: "defer", reason, metadata: null, reviewedAt: now, model: "preflight-v1" };
      report.preflightDeferred++;
    } else eligible.push(item);
  }
  if (report.preflightDeferred) await options.persistCache(cache);
  report.eligible = eligible.length;
  if (options.ledger?.day === options.day) { report.status = "daily-limit"; return { reviews: options.reviews, report }; }
  const selected: Candidate[] = [];
  const rotation = Math.floor(Date.parse(options.day + "T00:00:00Z") / 86400000);
  for (const item of editorialQueue(eligible, options.previous, rotation)) {
    if (selected.length >= 3) break;
    if (JSON.stringify([...selected, item].map(editorialInput)).length <= 16000) selected.push(item);
  }
  if (!selected.length) return { reviews: options.reviews, report };
  const input = selected.map(editorialInput);
  const ledger: EditorialLedger = { day: options.day, requests: 1, model: editorialModel, reservedAt: now,
    candidateIDs: selected.map(item => item.id), inputCharacters: JSON.stringify(input).length, state: "reserved" };
  // A timeout, partial response, process crash or malformed output consumes the
  // UTC day's one attempt. Persist BEFORE any provider call and never auto-retry.
  await options.persistLedger(ledger);
  report.requests = 1; report.attemptedCandidates = selected.length; report.inputCharacters = ledger.inputCharacters;
  let reviews = options.reviews;
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
    for (const decision of decisions) {
      const candidate = selected.find(item => item.id === decision.id)!;
      if (decision.decision === "approve") {
        if (!decision.metadata || decision.metadata.previewLabel !== previewLabel(candidate)) throw new Error("Approval is missing honest editorial metadata");
        const { cover, ...metadata } = decision.metadata;
        const entry = { fingerprint: candidate.fingerprint, reviewedAt: now,
          metadata: editorialMetadataSchema.parse({ ...metadata, ...(cover ? { cover } : {}) }) };
        if (applyEditorialReviews([candidate], { [candidate.id]: entry })[0].reviewStatus !== "candidate") throw new Error("Approval has no complete source preview");
        nextReviews[candidate.id] = entry;
      } else if (decision.metadata !== null) throw new Error("A deferred or rejected review cannot supply publication metadata");
      cache.decisions[editorialDecisionKey(candidate)] = { ...decision, reviewedAt: now, model: editorialModel };
    }
    // Save approvals before their decision cache, so a cache-only success can
    // never prevent an approved record from reaching the existing review gate.
    await options.persistReviews(nextReviews);
    await options.persistCache(cache);
    ledger.state = "completed";
    if (Number.isInteger(result.inputTokens) && result.inputTokens! >= 0) ledger.inputTokens = result.inputTokens;
    if (Number.isInteger(result.outputTokens) && result.outputTokens! >= 0) ledger.outputTokens = result.outputTokens;
    await options.persistLedger(ledger);
    reviews = nextReviews;
    report.status = "reviewed";
    report.approved = decisions.filter(item => item.decision === "approve").length;
    report.deferred = decisions.filter(item => item.decision === "defer").length;
    report.rejected = decisions.filter(item => item.decision === "reject").length;
  } catch (error) {
    report.status = "failed"; report.error = (error instanceof Error ? error.message : "Editorial review failed").slice(0, 500);
    await options.persistLedger({ ...ledger, state: "failed", error: report.error });
  }
  return { reviews, report };
}
