import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Catalog, Prompt } from "../packages/schema/catalog.ts";
import { atomic, json } from "./publication.ts";
import { clawHubCandidateIdentity, clawHubID, clawHubSources, collectClawHubSkill, ClawHubHTTPError, isClawHubItem, readClawHub, type ClawHubRead } from "./clawhub.ts";
import type { Candidate } from "./sources.ts";

const hour = 3_600_000;
const record = z.object({ checkedAt: z.iso.datetime(), status: z.enum(["ready", "withheld", "failed"]),
  identity: z.string().regex(/^[a-f0-9]{64}$/).optional(), reason: z.string().max(500).optional() }).strict();
export const clawHubStateSchema = z.object({ schemaVersion: z.literal(1), lastAttemptAt: z.iso.datetime().optional(),
  nextAttemptAfter: z.iso.datetime().optional(), records: z.record(z.string(), record) }).strict()
  .refine(value => Object.keys(value.records).every(id => clawHubSources.some(source => clawHubID(source) === id)), "Unknown ClawHub source identity");
export type ClawHubState = z.infer<typeof clawHubStateSchema>;
export async function readClawHubState(root: string): Promise<ClawHubState> {
  try {
    const bytes = await readFile(join(root, "clawhub", "state.json"));
    if (bytes.length > 50_000) throw new Error("ClawHub state exceeds size limit");
    return clawHubStateSchema.parse(JSON.parse(bytes.toString()));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, records: {} }; throw error; }
}

export function filterClawHubAvailability<T extends Prompt>(items: readonly T[], state: ClawHubState, now = Date.now()) {
  const validated = clawHubStateSchema.parse(state);
  const withheldIDs: string[] = [];
  const prompts = items.filter(item => {
    if (!isClawHubItem(item)) return true;
    const record = validated.records[item.id];
    const age = record ? now - Date.parse(record.checkedAt) : Infinity;
    const ready = record?.status === "ready" && record.identity === clawHubCandidateIdentity(item) && age >= 0 && age < 24 * hour;
    if (!ready) withheldIDs.push(item.id);
    return ready;
  });
  return { prompts, withheldIDs };
}
export async function assertClawHubAvailability(root: string, catalog: Pick<Catalog, "prompts">): Promise<void> {
  if (!catalog.prompts.some(isClawHubItem)) return;
  const { withheldIDs } = filterClawHubAvailability(catalog.prompts, await readClawHubState(root));
  if (withheldIDs.length) throw new Error(`ClawHub source is unavailable, changed or awaiting a fresh check: ${withheldIDs.join(", ")}. Refresh intake and prepare a corrected edition.`);
}

/** Persist Retry-After across invocations. No retries in this collection pass. */
export function clawHubRetryTime(value: string | undefined, now: number): string {
  const requested = value && /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value ?? "");
  return new Date(Math.max(now + hour, Number.isFinite(requested) && requested <= 8.64e15 ? requested : now + hour)).toISOString();
}

/** Caller owns daily.lock. Public, bounded reads only; no paid providers, installs or scripts. */
export async function prepareClawHub(root: string, options: { now?: string; read?: ClawHubRead } = {}) {
  const now = options.now ?? new Date().toISOString(), nowMS = Date.parse(now), read = options.read ?? readClawHub;
  if (!Number.isFinite(nowMS)) throw new Error("Invalid ClawHub collection time");
  const state = await readClawHubState(root);
  const cachePath = join(root, "candidates", "clawhub-community.json");
  const report = { status: "collected", requests: 0, candidates: 0, withheld: 0, cached: false, sources: {} as Record<string, unknown> };
  const nextAllowed = Math.max(state.lastAttemptAt ? Date.parse(state.lastAttemptAt) + 6 * hour : 0, state.nextAttemptAfter ? Date.parse(state.nextAttemptAfter) : 0);
  if (nowMS < nextAllowed) {
    const cached = await json<Candidate[]>(cachePath, []);
    const filtered = filterClawHubAvailability(cached, state, nowMS);
    report.status = "cached"; report.cached = true; report.candidates = filtered.prompts.length; report.withheld = filtered.withheldIDs.length;
    return { candidates: filtered.prompts, state, report };
  }
  const next: ClawHubState = { schemaVersion: 1, lastAttemptAt: now, records: Object.fromEntries(clawHubSources.map(source =>
    [clawHubID(source), { status: "failed" as const, checkedAt: now, reason: "Registry refresh has not completed" }])) };
  // A crash after observing a withdrawal cannot leave an earlier clearance active.
  await atomic(join(root, "clawhub", "state.json"), next);
  const candidates: Candidate[] = [];
  let rateLimited = false;
  const boundedRead: ClawHubRead = async (url, limit) => {
    if (report.requests >= 10) throw new Error("ClawHub request budget exhausted");
    report.requests++;
    return read(url, limit);
  };
  for (const source of clawHubSources) {
    const id = clawHubID(source);
    if (rateLimited) {
      next.records[id] = { status: "failed", checkedAt: now, reason: "Collection stopped after registry rate limit" };
      report.sources[id] = next.records[id]; report.withheld++; continue;
    }
    try {
      const result = await collectClawHubSkill(source, boundedRead);
      // Raw third-party metadata and content stay in the external content directory.
      await atomic(join(root, "clawhub", "evidence", `${id}.json`), { checkedAt: now, ...result.evidence });
      candidates.push(result.candidate);
      next.records[id] = { status: "ready", checkedAt: now, identity: clawHubCandidateIdentity(result.candidate) };
      report.sources[id] = { status: "ready", revision: result.candidate.source.revision, files: result.candidate.skill!.files!.length };
    } catch (error) {
      if (error instanceof ClawHubHTTPError && error.status === 429) {
        rateLimited = true; next.nextAttemptAfter = clawHubRetryTime(error.retryAfter, nowMS);
      }
      // Never restore an old publicly mirrored version after the public endpoint
      // stops serving it, changes its identity, or reports a non-clean scan.
      const reason = error instanceof ClawHubHTTPError ? error.message : error instanceof z.ZodError ? "ClawHub response schema mismatch" : String(error).slice(0, 500);
      next.records[id] = { status: error instanceof ClawHubHTTPError ? "failed" : "withheld", checkedAt: now, reason };
      report.sources[id] = next.records[id]; report.withheld++;
    }
    await atomic(join(root, "clawhub", "state.json"), next);
  }
  // Refreshing current status invalidates stale cache identities before exposing the new cache.
  await atomic(join(root, "clawhub", "state.json"), clawHubStateSchema.parse(next));
  await atomic(cachePath, candidates);
  report.candidates = candidates.length;
  await atomic(join(root, "clawhub", "status.json"), { ...report, checkedAt: now });
  return { candidates, state: next, report };
}
