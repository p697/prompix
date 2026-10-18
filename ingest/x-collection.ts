import { join } from "node:path";
import { z } from "zod";
import { atomic, json } from "./publication.ts";
import { collectXFeeds, xFeeds } from "./x-feed.ts";
import { buildXSearchPlan, runXSearchPlan, searchPlanSchema, type XSearchPlan } from "./x-search-plan.ts";
import { admitXSearchLeads } from "./x-search-admission.ts";
import { syncLiveXLeadQueue, acquireXLeadQueue } from "./x-lead-queue.ts";
import { configuredXSpendBudget } from "./x-spend.ts";
import { TwitterAPIClient } from "./twitterapi.ts";
import { windowBudget } from "./discovery-budget.ts";

import { thirdPartyFeedSearch } from "./x-third-party.ts";

const attemptSchema = z.object({ window: z.string(), state: z.enum(["reserved", "completed", "failed"]),
  allowance: z.number().int().min(0).max(40), used: z.number().int().min(0).max(40).optional(), retryAfter: z.iso.datetime().optional() }).strict();
const ledgerSchema = z.array(attemptSchema).max(40);

/** Four rotating search lanes per collection window, retaining every topic across the rotation. */
export function currentXSearchPlan(now: Date): XSearchPlan {
  const seconds = Math.floor(now.getTime() / 1000 / 900) * 900 - 900;
  const full = buildXSearchPlan(new Date((seconds - 86400) * 1000).toISOString(), new Date(seconds * 1000).toISOString(),
    { windowHours: 24, maxPagesPerQuery: 10 });
  const slot = Math.floor(now.getTime() / (6 * 3600_000));
  return { ...full, queries: Array.from({ length: 4 }, (_, i) => full.queries[(slot * 4 + i) % full.queries.length]) };
}

// Observed third-party blind spots are concentrated in video; retain independent official video reads.
export const officialSupplementFeeds = xFeeds.flatMap(feed => feed.id === "video" ? [] : [xFeeds[1], feed]);

/** Explicit routing mode. Both acquisition and maintenance retain the actual provider. */
export async function collectXDiscovery(root: string, options: {
  enabled: boolean; bearer?: string; environment?: NodeJS.ProcessEnv; now?: () => Date;
  search?: TwitterAPIClient["search"]; lookup?: Parameters<typeof admitXSearchLeads>[3]["lookup"];
  officialSearch?: Parameters<typeof collectXFeeds>[1]["search"]; sleep?: (ms: number) => Promise<void>;
}) {
  const env = options.environment ?? process.env, mode = env.PROMPIX_X_DISCOVERY_PROVIDER ?? "official";
  if (mode === "official") return collectXFeeds(root, { ...options, search: options.officialSearch });
  if (mode !== "hybrid" && mode !== "third-party") throw new Error("Invalid X discovery provider");
  if (!options.enabled) return { status: "dry-run", mode };
  const budget = configuredXSpendBudget(env);
  if ((mode === "hybrid" && !options.bearer) || !env.TWITTERAPI_IO_KEY || !budget) throw new Error("Hybrid X discovery requires both credentials and a shared dollar budget");
  const now = options.now ?? (() => new Date()), at = now(), day = at.toISOString().slice(0, 10);
  const slot = Math.floor(at.getUTCHours() / 6), window = `${day}-${slot}`;
  const directory = join(root, "x-search-plans", window), path = join(root, "x-search-budgets", `${day}.json`);
  const plan = searchPlanSchema.parse(await json<XSearchPlan>(join(directory, "plan.json"), currentXSearchPlan(at)));
  const ledger = ledgerSchema.parse(await json(path, []));
  const spent = ledger.reduce((sum, attempt) => sum + (attempt.used ?? attempt.allowance), 0);
  const allowance = Math.max(0, windowBudget(40, at) - spent);
  let search: { status: string; requestsThisRun?: number; unique?: number; returned?: number; retryAfter?: string };
  const cooldownPath = join(root, "x-search-cooldown.json");
  const cooldown = z.object({ until: z.iso.datetime().optional() }).strict().parse(await json(cooldownPath, {}));
  if (cooldown.until && Date.parse(cooldown.until) > at.getTime()) search = { status: "failed", retryAfter: cooldown.until };
  else if (ledger.some(a => a.state !== "completed")) search = { status: "prior-attempt-blocked" };
  else if (!allowance) search = { status: "window-limit", requestsThisRun: 0 };
  else {
    const attempt: z.infer<typeof attemptSchema> = { window, state: "reserved", allowance };
    ledger.push(attempt); await atomic(path, ledger);
    try {
      const client = new TwitterAPIClient(env.TWITTERAPI_IO_KEY, budget);
      search = await runXSearchPlan(directory, plan, { search: options.search ?? client.search.bind(client),
        maxRequests: allowance, now, sleep: options.sleep });
      attempt.used = search.requestsThisRun; attempt.state = "completed"; attempt.retryAfter = search.retryAfter;
      if (search.retryAfter) await atomic(cooldownPath, { until: search.retryAfter });
      await atomic(path, ledger);
      // Bounded sampling deliberately leaves pagination available; report that without a false failure alert.
      if (search.status === "partial") search = { ...search, status: "sampled" };
    } catch {
      attempt.state = "failed"; await atomic(path, ledger);
      search = { status: "failed" };
    }
  }
  let admission: Awaited<ReturnType<typeof admitXSearchLeads>>;
  try {
    await syncLiveXLeadQueue(root, at.toISOString());
    admission = await acquireXLeadQueue(root, { enabled: options.enabled, bearer: options.bearer,
      maxPosts: windowBudget(40, at), now: at.toISOString(), lookup: options.lookup, environment: env });
  } catch { admission = { status: "failed", requests: 0, acquired: 0, unavailable: 0, known: 0, pending: 0, needsInspection: 0 }; }
  const supplement = mode === "third-party" ? await collectXFeeds(root, { enabled: true, bearer: "third-party", provider: "twitterapi", now,
    search: thirdPartyFeedSearch(root, env, options.search, undefined, options.sleep), sleep: options.sleep,
    limits: { requests: 3, posts: 60 }, pageSize: 20, replyEvery: 3, feeds: officialSupplementFeeds }) : await collectXFeeds(root, { enabled: true, bearer: options.bearer, now, search: options.officialSearch,
    sleep: options.sleep, limits: { requests: 3, posts: 30 }, pageSize: 10, replyEvery: 3, feeds: officialSupplementFeeds });
  const statuses = [search.status, admission.status, supplement.status];
  const report = { status: statuses.some(s => ["failed", "unresolved", "prior-attempt-blocked", "budget-limit", "checkpoint-limit"].includes(s)) ? "failed" : "ok",
    mode, search, admission, supplement, rawDailyLimit: 800, acquisitionDailyLimit: 40, officialAcquisitionDailyLimit: mode === "third-party" ? 0 : 40,
    officialSupplementDailyLimit: mode === "third-party" ? 0 : 30, globalRecallProven: false };
  await atomic(join(root, "x-hybrid-discovery-status.json"), { at: now().toISOString(), ...report });
  return report;
}
