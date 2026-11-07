import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { CreatorCache } from "./creators.ts";
import { withPublisherDatabase } from "./database-publication.ts";
import type { ModelCallSummary } from "./models/call.ts";
import type { Effort, ModelProvider } from "./models/types.ts";
import { locatePrompts, unmarkedPosts } from "./prompt-locate.ts";
import { atomic, json } from "./publication.ts";
import { TwitterAPIClient } from "./twitterapi.ts";
import { xAcquisitionsPerDay } from "./x-collection.ts";
import { curatedCreators, searchXDay, xDaySnapshots } from "./x-day-search.ts";
import { readXExcerptReviews } from "./x-excerpts.ts";
import { publishedXIdentities } from "./x-maintenance-admission.ts";
import { japanDay } from "./x-search-rules.ts";
import { configuredXSpendBudget } from "./x-spend.ts";

/** Posts are searched two days late, once likes have settled, deleted posts are gone and
 * authors have posted their reply prompts (owner, 2026-11-07). */
export const searchLagDays = 2;
/** A missed night is caught up on the next run, a few days at most. */
export const maximumCatchUpDays = 3;
const cursorSchema = z.object({ searchedThrough: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();

const japanDate = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const nextDate = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);

/** The Japan days still to search: the day after the last one searched, up to the lagged day. */
export function nightlyDays(searchedThrough: string | undefined, now: number): string[] {
  const target = japanDate(now - searchLagDays * 86400_000);
  if (searchedThrough && searchedThrough >= target) return [];
  const days: string[] = [];
  for (let day = searchedThrough ? nextDate(searchedThrough) : target; day <= target; day = nextDate(day)) days.push(day);
  return days.slice(-maximumCatchUpDays);
}

export type NightlyXReport = { status: "ok" | "failed" | "up-to-date" | "dry-run"; days: { day: string; requests: number; returned: number; admitted: number;
  located?: number; unlocated?: number; error?: string }[] };

/** The nightly X collection: search each pending Japan day under the approved rules, write the
 * admitted posts as intake snapshots, and let the review route find prompts without a heading.
 * Each finished day moves the cursor, so a failure retries only the days it did not finish. */
export async function collectNightlyX(root: string, options: { enabled: boolean; env: NodeJS.ProcessEnv; now?: number;
  locate?: { provider: ModelProvider; effort?: Effort; record?: (summary: ModelCallSummary) => Promise<void> };
  search?: Pick<TwitterAPIClient, "search">; creators?: string[]; known?: Set<string> }): Promise<NightlyXReport> {
  if (!options.enabled) return { status: "dry-run", days: [] };
  const env = options.env, now = options.now ?? Date.now(), cursorPath = join(root, "x-nightly", "cursor.json");
  const cursor = cursorSchema.optional().parse(await json(cursorPath, undefined));
  const days = nightlyDays(cursor?.searchedThrough, now);
  if (!days.length) return { status: "up-to-date", days: [] };
  const budget = configuredXSpendBudget(env);
  if (!options.search && (!budget || !env.TWITTERAPI_IO_KEY)) throw new Error("Nightly X search needs the TwitterAPI key and the shared X budget");
  const client = options.search ?? new TwitterAPIClient(env.TWITTERAPI_IO_KEY!, budget!);
  const creators = options.creators ?? await curatedCreators(env);
  const known = options.known ?? new Set([...await withPublisherDatabase(publishedXIdentities, env)].map(value => value.replace("x-post-", "")));
  const creatorCache = await json<CreatorCache>(join(root, "creators.json"), {});
  const report: NightlyXReport = { status: "ok", days: [] };
  for (const day of days) {
    const entry: NightlyXReport["days"][number] = { day, requests: 0, returned: 0, admitted: 0 };
    report.days.push(entry);
    const capturedAt = new Date(now).toISOString();
    const search = await searchXDay(client, { ...japanDay(day), dailyPosts: xAcquisitionsPerDay(env), creators, known });
    entry.requests = search.stats.reduce((sum, rule) => sum + rule.requests, 0);
    entry.returned = search.stats.reduce((sum, rule) => sum + rule.returned, 0);
    entry.admitted = search.admitted.size;
    const failed = search.stats.filter(rule => rule.error);
    // A search that mostly failed is retried on the next run instead of being marked done.
    if (failed.length > search.stats.length / 2) { entry.error = failed[0].error; report.status = "failed"; break; }
    const snapshots = xDaySnapshots(search, capturedAt).map((data, index) =>
      ({ name: `${capturedAt.slice(0, 10)}-feed-${String(index + 1).padStart(3, "0")}-${randomUUID()}.json`, data }));
    for (const { name, data } of snapshots) await atomic(join(root, "x-discovery", name), data);
    for (const post of search.admitted.keys()) known.add(post);
    const pending = unmarkedPosts(snapshots, creatorCache);
    if (pending.length && options.locate) {
      const located = await locatePrompts(options.locate.provider, pending, { effort: options.locate.effort, record: options.locate.record, now: new Date(now) });
      // Read again right before writing: the excerpt store is shared with the source checks.
      await atomic(join(root, "x-excerpt-reviews.json"), { ...await readXExcerptReviews(root), ...located.excerpts });
      entry.located = located.located; entry.unlocated = located.none + located.unmatched + located.failed;
    }
    await atomic(cursorPath, { searchedThrough: day });
  }
  return report;
}
