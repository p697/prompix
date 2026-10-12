import { join } from "node:path";
import { z } from "zod";
import { atomic, json } from "./publication.ts";
import { collectPublisherSkills, skillPublishers } from "./publisher-skills.ts";
import { type Candidate } from "./sources.ts";
import { promptSchema } from "../packages/schema/catalog.ts";
const candidateSchema = promptSchema.safeExtend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  featured: z.boolean(), reviewStatus: z.enum(["candidate", "draft"]), editorialRank: z.number().optional() });

const stateSchema = z.record(z.string(), z.object({ attemptedAt: z.iso.datetime() }).strict());
/** Caller holds the content lock. Each publisher is independently cached for six hours. */
export async function preparePublisherSkills(root: string, options: { now?: string; collect?: typeof collectPublisherSkills } = {}) {
  const now = options.now ?? new Date().toISOString(), nowMS = Date.parse(now);
  if (!Number.isFinite(nowMS)) throw new Error("Invalid publisher collection time");
  const statePath = join(root, "publisher-skills", "state.json");
  const state = stateSchema.parse(await json(statePath, {}));
  const candidates: Candidate[] = [], report: Record<string, unknown> = {};
  for (const publisher of skillPublishers) {
    const cachePath = join(root, "candidates", `publisher-skills-${publisher.id}.json`);
    const cached = z.array(candidateSchema).max(64).parse(await json(cachePath, []));
    const attempted = state[publisher.id]?.attemptedAt;
    if (attempted && nowMS - Date.parse(attempted) < 6 * 3600_000) {
      candidates.push(...cached); report[publisher.id] = { status: "cached", count: cached.length }; continue;
    }
    state[publisher.id] = { attemptedAt: now }; await atomic(statePath, state);
    try {
      const result = await (options.collect ?? collectPublisherSkills)(publisher);
      // Preserve the previous candidate for an individual failed package; its
      // immutable source revision and approval remain distinct from the new one.
      const failed = new Set(result.deferred.map(value => value.id));
      const next = [...result.candidates, ...cached.filter(value => failed.has(value.id))];
      await atomic(join(root, "publisher-skills", "evidence", `${publisher.id}-${result.revision}.json`), { capturedAt: now, ...result });
      await atomic(cachePath, next);
      candidates.push(...next); report[publisher.id] = { status: "collected", count: result.candidates.length,
        retainedDrafts: next.length - result.candidates.length, revision: result.revision, deferred: result.deferred };
    } catch (error) {
      candidates.push(...cached); report[publisher.id] = { status: "failed", count: cached.length,
        reason: error instanceof Error ? error.message : "Publisher collection failed" };
    }
  }
  return { candidates, report };
}
