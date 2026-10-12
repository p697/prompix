import { join } from "node:path";
import { z } from "zod";
import type { Prompt } from "../packages/schema/catalog.ts";
import { atomic, json } from "./publication.ts";
import { mergeCreatorCache, type CreatorCache } from "./creators.ts";
import { lookupXUsers } from "./x.ts";

const refreshState = z.object({
  day: z.string().optional(), negativeUntil: z.record(z.string(), z.iso.datetime()).default({}),
});
type RefreshOptions = {
  enabled: boolean; publishing: boolean; bearer?: string; now?: Date;
  lookup?: typeof lookupXUsers;
};
export type CreatorRefreshReport = {
  status: "disabled" | "dry-run" | "not-configured" | "current" | "daily-limit" | "ok" | "failed";
  requests: number; requestedAuthors: number; returnedAuthors: number; missingAuthors: number; error?: string;
};

/** One daily, bounded paid lookup for eligible library authors missing a real X ID. */
export async function refreshCreatorProfiles(items: readonly Prompt[], cache: CreatorCache, root: string, options: RefreshOptions): Promise<{ cache: CreatorCache; report: CreatorRefreshReport }> {
  const report: CreatorRefreshReport = { status: "disabled", requests: 0, requestedAuthors: 0, returnedAuthors: 0, missingAuthors: 0 };
  if (!options.enabled) return { cache, report };
  if (!options.publishing) return { cache, report: { ...report, status: "dry-run" } };
  if (!options.bearer) return { cache, report: { ...report, status: "not-configured" } };
  const now = options.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  const statePath = join(root, "x-creator-state.json");
  const state = refreshState.parse(await json(statePath, {}));
  if (state.day === day) return { cache, report: { ...report, status: "daily-limit" } };
  const usernames = [...new Set(items.flatMap(item => {
    const creator = item.creator;
    if (creator?.platform !== "x" || !creator.username || creator.externalID) return [];
    const name = creator.username.toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(name) || cache[`x-${name}`]?.externalID || Date.parse(state.negativeUntil[name] ?? "") > now.getTime()) return [];
    return [name];
  }))].slice(0, 20);
  if (!usernames.length) return { cache, report: { ...report, status: "current" } };
  // Mark before the request. An interrupted or ambiguous response consumes
  // today's allowance, so an automatic scheduler rerun cannot repeat charges.
  await atomic(statePath, { ...state, day });
  const attemptPath = join(root, "x-creator-attempts", `${day}.json`);
  const attemptedAt = now.toISOString();
  await atomic(attemptPath, { attemptedAt, status: "attempted", usernames, requests: 1 });
  report.requests = 1;
  report.requestedAuthors = usernames.length;
  try {
    const result = await (options.lookup ?? lookupXUsers)(options.bearer, usernames);
    const merged = mergeCreatorCache(cache, result.creators);
    await atomic(join(root, "creators.json"), merged);
    const returned = new Set(result.creators.flatMap(creator => creator.username ? [creator.username.toLowerCase()] : []));
    const missing = usernames.filter(name => !returned.has(name));
    const negativeUntil = { ...state.negativeUntil };
    // Only an explicit not-found response establishes a 30-day negative cache.
    // Other partial API errors may be temporary and must not hide an account.
    const notFound = new Set<string>((result.errors as unknown[]).flatMap(error => {
      if (!error || typeof error !== "object") return [];
      const value = error as { type?: unknown; value?: unknown };
      return typeof value.type === "string" && value.type.endsWith("/resource-not-found") && typeof value.value === "string" ? [value.value.toLowerCase()] : [];
    }));
    for (const name of missing) if (notFound.has(name)) negativeUntil[name] = new Date(now.getTime() + 30 * 86400_000).toISOString();
    for (const name of returned) delete negativeUntil[name];
    await atomic(statePath, { day, negativeUntil });
    Object.assign(report, { status: "ok", returnedAuthors: result.creators.length, missingAuthors: missing.length });
    await atomic(attemptPath, { attemptedAt, completedAt: new Date().toISOString(), ...report, usernames, errors: result.errors });
    return { cache: merged, report };
  } catch (error) {
    Object.assign(report, { status: "failed", error: String(error) });
    await atomic(attemptPath, { attemptedAt, ...report, usernames });
    return { cache, report };
  }
}
