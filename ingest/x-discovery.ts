import { join } from "node:path";
import { z } from "zod";
import { atomic, json } from "./publication.ts";
import { lookupX, searchX, xLookupRequest, xSearchFingerprint, xSearchRequest } from "./x.ts";
import { readXIntake } from "./x-intake.ts";

const stateSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // Legacy cursors have no request identity and must not constrain a new query.
  newest: z.string().regex(/^\d+$/).optional(),
  cursors: z.record(z.string().regex(/^[a-f0-9]{64}$/), z.string().regex(/^\d+$/)).default({}),
});
export type XDiscoveryReport = {
  status: "dry-run" | "not-configured" | "daily-limit" | "ok" | "failed";
  operation: "search" | "lookup";
  requests: number; requestedPosts: number; count: number; creators: number;
  queryFingerprint: string; cursorUsed?: string;
  coverage?: Awaited<ReturnType<typeof searchX>>["coverage"]; message?: string;
};

/** Caller owns the daily content lock. Changing a query never resets the paid budget. */
export async function discoverX(root: string, options: {
  publishing: boolean; bearer?: string; now?: Date; search?: typeof searchX;
  lookupIDs?: readonly string[]; lookup?: typeof lookupX;
}) {
  const now = options.now ?? new Date(), day = now.toISOString().slice(0, 10);
  const path = join(root, "x-state.json");
  const state = stateSchema.parse(await json(path, {}));
  const operation = options.lookupIDs === undefined ? "search" : "lookup";
  const since = operation === "search" ? state.cursors[xSearchFingerprint] : undefined;
  const request = options.lookupIDs === undefined ? xSearchRequest(since) : xLookupRequest(options.lookupIDs);
  const report: XDiscoveryReport = { status: "dry-run", requests: 0, requestedPosts: 0, count: 0, creators: 0,
    operation, queryFingerprint: request.fingerprint, ...(since ? { cursorUsed: since } : {}) };
  if (!options.publishing) return { report };
  if (!options.bearer) return { report: { ...report, status: "not-configured" as const } };
  if (state.day === day) return { report: { ...report, status: "daily-limit" as const } };

  // Reacquisition is explicit and limited to known discoveries. Never turn an
  // arbitrary link or an inferred continuation into another paid read.
  const knownAuthors = new Map<string, string>();
  if (options.lookupIDs) {
    const intake = await readXIntake(root);
    for (const id of options.lookupIDs) {
      const record = intake.records.find(record => record.postID === id);
      if (!record?.authorID) throw new Error("X lookup requires cached discovery IDs with valid author identities");
      knownAuthors.set(id, record.authorID);
    }
  }

  // Commit one global daily reservation before touching a paid endpoint.
  // A timeout, snapshot write failure or uncertain result consumes the attempt.
  await atomic(path, { ...state, day });
  const attemptPath = join(root, "x-search-attempts", `${day}.json`);
  const reservedAt = now.toISOString();
  await atomic(attemptPath, { state: "reserved", reservedAt, operation, request, requests: 1 });
  report.requests = 1; report.requestedPosts = options.lookupIDs?.length ?? 10;
  try {
    const result = options.lookupIDs === undefined
      ? await (options.search ?? searchX)(options.bearer, since)
      : await (options.lookup ?? lookupX)(options.bearer, options.lookupIDs);
    if (result.request.requestFingerprint !== request.requestFingerprint)
      throw new Error("X request identity changed during discovery; cursor unchanged");
    const responseNewest = "newest" in result ? result.newest : undefined;
    if (responseNewest !== undefined && !/^\d+$/.test(responseNewest))
      throw new Error("Invalid X response cursor; cursor unchanged");
    if (options.lookupIDs && (result.posts.length !== options.lookupIDs.length ||
      new Set(result.posts.map(post => post.id)).size !== result.posts.length ||
      result.posts.some(post => !knownAuthors.has(post.id) || knownAuthors.get(post.id) !== post.author_id)))
      throw new Error("X lookup changed cached post identity; cached posts unchanged");
    // Save the complete response before its cursor. An interrupted write can
    // repeat known posts next day, but must never skip unseen source material.
    await atomic(join(root, "x-discovery", `${day}.json`), { ...result, operation, capturedAt: reservedAt, reviewStatus: "draft" });
    const newest = operation === "search" ? responseNewest ?? since : undefined;
    await atomic(path, { ...state, day, cursors: { ...state.cursors, ...(newest ? { [xSearchFingerprint]: newest } : {}) } });
    Object.assign(report, { status: "ok", count: result.posts.length, creators: result.creators.length, coverage: result.coverage });
    await atomic(attemptPath, { state: "completed", reservedAt, request, ...report });
    return { report, result };
  } catch (error) {
    // API adapters report bounded diagnostics and never include authorization.
    const message = (error instanceof Error ? error.message : "X discovery failed").replaceAll(options.bearer, "[redacted]").slice(0, 500);
    Object.assign(report, { status: "failed", message });
    await atomic(attemptPath, { state: "failed", reservedAt, request, ...report });
    return { report };
  }
}
