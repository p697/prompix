import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { atomic, json } from "./publication.ts";
import { auditPilotSearch } from "./x-pilot.ts";
import { parseTwitterAPI, type TwitterAPIClient, type TwitterAPIResult } from "./twitterapi.ts";
import { xFeeds } from "./x-feed.ts";
import { XBudgetExceeded } from "./x-spend.ts";
import { TransientXReadError } from "./x.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const boundary = z.number().int().nonnegative().max(4_102_444_800);
const querySchema = z.object({ id: z.string().regex(/^[a-z0-9-]{1,80}$/), query: z.string().min(1).max(1000),
  start: boundary, end: boundary, lane: z.enum(["topic", "recall"]) }).strict().refine(q => q.start < q.end);
export const searchPlanSchema = z.object({ version: z.literal(1), queries: z.array(querySchema).min(1).max(5000),
  maxPagesPerQuery: z.number().int().min(1).max(100) }).strict().refine(p => new Set(p.queries.map(q => q.id)).size === p.queries.length);
export type XSearchPlan = z.infer<typeof searchPlanSchema>;

/** Broader independent lanes avoid requiring a model name AND a prompt marker in the search index. */
export const xRecallFeeds = [
  { id: "recall-image", query: "(prompt OR 提示词 OR プロンプト) has:images -is:retweet -is:reply -is:quote" },
  { id: "recall-video", query: "(prompt OR 提示词 OR プロンプト) has:videos -is:retweet -is:reply -is:quote" },
  { id: "recall-model-video", query: "(seedance OR veo OR sora OR kling OR runway) has:videos -is:retweet -is:reply -is:quote" },
  { id: "recall-design", query: "(midjourney OR flux OR \"nano banana\") has:images -is:retweet -is:reply -is:quote" },
] as const;

/** Exact UTC half-open windows. History uses the same resumable engine as current discovery. */
export function buildXSearchPlan(start: string, end: string, options: { windowHours?: number; maxPagesPerQuery?: number } = {}): XSearchPlan {
  const from = Date.parse(start) / 1000, until = Date.parse(end) / 1000;
  const hours = options.windowHours ?? 6;
  if (!Number.isInteger(from) || !Number.isInteger(until) || from < 0 || from >= until ||
      !Number.isInteger(hours) || hours < 1 || hours > 24 || until - from > 31 * 86400) throw new Error("Invalid bounded X search window");
  const queries: XSearchPlan["queries"] = [];
  // Newest windows first; alternate topic and recall lanes rather than exhausting text or one creator.
  const feeds = xFeeds.flatMap((feed, index) => [{ ...feed, lane: "topic" as const },
    ...(index < xRecallFeeds.length ? [{ ...xRecallFeeds[index], lane: "recall" as const }] : [])]);
  for (let stop = until; stop > from; stop -= hours * 3600) {
    const begin = Math.max(from, stop - hours * 3600);
    for (const feed of feeds) queries.push({ ...feed, id: `${feed.id}-${begin}`, start: begin, end: stop });
  }
  return searchPlanSchema.parse({ version: 1, queries, maxPagesPerQuery: options.maxPagesPerQuery ?? 10 });
}
export function boundedSearchQuery(query: XSearchPlan["queries"][number]) {
  if (/\b(?:since|until)(?:_time)?:/.test(query.query)) throw new Error("Plan query must not override its time boundaries");
  return `${query.query} since_time:${query.start} until_time:${query.end}`;
}

const attemptSchema = z.object({ state: z.enum(["reserved", "failed", "completed", "budget-blocked", "retryable", "retried"]), at: z.iso.datetime(),
  query: z.number().int().nonnegative(), cursor: z.string().min(1).max(2000).optional(),
  response: z.string().regex(/^response-\d{5}\.json$/), error: z.string().max(300).optional(), retryAfter: z.iso.datetime().optional() }).strict();
const progressSchema = z.object({ planID: z.string().regex(/^[a-f0-9]{64}$/), nextQuery: z.number().int().nonnegative(),
  attempts: z.array(attemptSchema).max(10000) }).strict();
const deferralSchema = z.object({ planID: z.string().regex(/^[a-f0-9]{64}$/), query: z.number().int().nonnegative(),
  attemptsSHA256: z.string().regex(/^[a-f0-9]{64}$/), at: z.iso.datetime(), reason: z.string().min(20).max(1000) }).strict();
type Page = { query: number; response: string; at: string; result: TwitterAPIResult };

/** All source evidence is private to this directory: it cannot become a publishable X acquisition. */
export async function readXSearchPlan(directory: string, input: XSearchPlan) {
  const plan = searchPlanSchema.parse(input), planID = hash(plan);
  const state = progressSchema.parse(await json(join(directory, "progress.json"), { planID, nextQuery: 0, attempts: [] }));
  if (state.planID !== planID || state.nextQuery >= plan.queries.length || state.attempts.some(a => a.query >= plan.queries.length))
    throw new Error("X search checkpoint does not match its immutable plan");
  const pages: Page[] = [], pending = new Set<number>();
  const cursors = plan.queries.map(() => ({ cursor: undefined as string | undefined, seen: new Set<string>(), pages: 0, done: false }));
  let recovered = 0;
  for (const attempt of state.attempts) {
    if (attempt.state === "budget-blocked" || attempt.state === "retried") continue;
    const cursor = cursors[attempt.query];
    if (pending.has(attempt.query) || cursor.done || cursor.cursor !== attempt.cursor) throw new Error("Invalid X search checkpoint sequence");
    const capture = await json<{ at: string; raw: unknown } | null>(join(directory, attempt.response), null);
    if (!capture) {
      if (attempt.state === "completed") throw new Error("Completed X search is missing its evidence");
      pending.add(attempt.query); continue;
    }
    // A parser/write interruption can replay captured HTTP evidence, without another paid call.
    let result: TwitterAPIResult;
    try { result = parseTwitterAPI(capture.raw, { search: true }); }
    catch (error) {
      if (attempt.state === "completed") throw error;
      pending.add(attempt.query); continue;
    }
    if (!Number.isFinite(Date.parse(capture.at))) throw new Error("Invalid X search capture time");
    if (result.nextToken && (result.nextToken === attempt.cursor || cursor.seen.has(result.nextToken)))
      throw new Error("X search cursor cycle detected");
    if (result.nextToken) cursor.seen.add(result.nextToken);
    cursor.cursor = result.nextToken; cursor.pages++; cursor.done = !result.nextToken;
    if (attempt.state !== "completed") { attempt.state = "completed"; delete attempt.error; recovered++; }
    pages.push({ query: attempt.query, response: attempt.response, at: capture.at, result });
  }
  const deferred = new Set<number>();
  const deferrals = z.array(deferralSchema).max(5000).parse(await json(join(directory, "owner-deferrals.json"), []));
  for (const deferral of deferrals) {
    const attempts = state.attempts.filter(a => a.query === deferral.query);
    // This is an explicit operator decision to leave a failed query unresolved, not retry or approve it.
    if (deferral.planID !== planID || deferred.has(deferral.query) || !pending.has(deferral.query) ||
        attempts.at(-1)?.state !== "retryable" || attempts.filter(a => a.cursor === attempts.at(-1)?.cursor && a.state !== "budget-blocked").length < 3 ||
        deferral.attemptsSHA256 !== hash(attempts)) throw new Error("X search deferral does not match exhausted transient attempts");
    deferred.add(deferral.query); pending.delete(deferral.query);
  }
  const queries = plan.queries.map((query, index) => ({ id: query.id, lane: query.lane, pages: cursors[index].pages,
    status: deferred.has(index) ? "owner-deferred" : pending.has(index) ? "unresolved" : cursors[index].done ? "complete" : cursors[index].pages >= plan.maxPagesPerQuery ? "page-limit" : "pending" }));
  const unique = new Map<string, { result: TwitterAPIResult; page: Page }>();
  const violations: { id: string; issues: string[]; query: string }[] = [];
  let returned = 0, duplicates = 0;
  for (const page of pages) {
    const query = plan.queries[page.query], issues = auditPilotSearch(boundedSearchQuery(query), page.result);
    const invalid = new Set(issues.map(issue => issue.id));
    violations.push(...issues.map(issue => ({ ...issue, query: query.id })));
    for (const post of page.result.posts) {
      returned++;
      if (invalid.has(post.id)) continue;
      if (unique.has(post.id)) duplicates++;
      unique.set(post.id, { result: { ...page.result, posts: [post], nextToken: undefined }, page });
    }
  }
  return { plan, planID, state, pages, cursors, pending, deferred, recovered, unique,
    report: { planID, status: pending.size ? "unresolved" : queries.every(q => q.status === "complete") ? "complete" : "partial",
      requests: state.attempts.length, returned, unique: unique.size, duplicates, violations, queries,
      // Exhausted pagination is provider completeness only; it does not establish global X recall.
      globalRecallProven: false, publishableAcquisitions: 0 } };
}

/** Schedule only retries already classified by the transport layer, after replaying retained evidence.
 * Unknown failures, malformed captures and exhausted retries still require inspection. */
export function searchPlanReadiness(run: Awaited<ReturnType<typeof readXSearchPlan>>, now = Date.now()):
  "ready" | "backoff" | "blocked" | "complete" {
  if (run.pending.size) {
    if (run.pending.size !== 1) return "blocked";
    const query = [...run.pending][0], attempts = run.state.attempts.filter(a => a.query === query);
    const last = attempts.at(-1);
    if (!last || last.state !== "retryable" || !last.retryAfter ||
        attempts.filter(a => a.cursor === last.cursor && a.state !== "budget-blocked").length >= 3) return "blocked";
    return Date.parse(last.retryAfter) <= now ? "ready" : "backoff";
  }
  return run.report.queries.some(q => q.status === "pending") ? "ready" : "complete";
}

/** Caller holds the plan lock and has inspected the outage. Never edits attempts, captures or spend. */
export async function deferXSearchQuery(directory: string, input: XSearchPlan, query: number, reason: string, at = new Date().toISOString()) {
  const run = await readXSearchPlan(directory, input), attempts = run.state.attempts.filter(a => a.query === query);
  if (!run.pending.has(query) || attempts.at(-1)?.state !== "retryable" ||
      attempts.filter(a => a.cursor === attempts.at(-1)?.cursor && a.state !== "budget-blocked").length < 3)
    throw new Error("Only inspected, exhausted transient queries may be deferred");
  const record = deferralSchema.parse({ planID: run.planID, query, attemptsSHA256: hash(attempts), at, reason });
  const previous = z.array(deferralSchema).parse(await json(join(directory, "owner-deferrals.json"), []));
  await atomic(join(directory, "owner-deferrals.json"), [...previous, record]);
  return record;
}

/** Caller holds the content lock. Every bounded transport retry keeps the earlier charge and reserves again. */
export async function runXSearchPlan(directory: string, input: XSearchPlan, options: {
  search: TwitterAPIClient["search"]; maxRequests: number; sleep?: (ms: number) => Promise<void>; now?: () => Date;
}) {
  if (!Number.isInteger(options.maxRequests) || options.maxRequests < 0 || options.maxRequests > 100)
    throw new Error("Invalid X search invocation limit");
  const now = options.now ?? (() => new Date());
  let run = await readXSearchPlan(directory, input);
  // Validate every query before the first write or request.
  run.plan.queries.forEach(boundedSearchQuery);
  if (run.recovered) await atomic(join(directory, "progress.json"), run.state);
  await atomic(join(directory, "plan.json"), run.plan);
  let calls = 0;
  while (calls < options.maxRequests && run.state.attempts.length < 10000) {
    if (run.pending.size) {
      const retry = run.state.attempts.find(a => a.state === "retryable" && a.retryAfter && Date.parse(a.retryAfter) <= now().getTime()
        && run.state.attempts.filter(other => other.query === a.query && other.cursor === a.cursor && other.state !== "budget-blocked").length < 3);
      if (!retry || run.pending.size > 1) break;
      retry.state = "retried"; run.state.nextQuery = retry.query;
      await atomic(join(directory, "progress.json"), run.state);
      run = await readXSearchPlan(directory, input);
    }
    const index = Array.from({ length: run.plan.queries.length }, (_, n) => (run.state.nextQuery + n) % run.plan.queries.length)
      .find(i => !run.deferred.has(i) && !run.cursors[i].done && run.cursors[i].pages < run.plan.maxPagesPerQuery);
    if (index === undefined) break;
    const attempt: z.infer<typeof attemptSchema> = { state: "reserved", at: now().toISOString(), query: index,
      cursor: run.cursors[index].cursor, response: `response-${String(run.state.attempts.length + 1).padStart(5, "0")}.json` };
    run.state.attempts.push(attempt);
    run.state.nextQuery = (index + 1) % run.plan.queries.length;
    await atomic(join(directory, "progress.json"), run.state);
    calls++;
    try {
      await (options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(6500);
      // Only the captured, validated raw response is authoritative; not a transport adapter's cached result.
      await options.search(boundedSearchQuery(run.plan.queries[index]), attempt.cursor,
        raw => atomic(join(directory, attempt.response), { at: now().toISOString(), raw }));
      const capture = await json(join(directory, attempt.response), null);
      if (!capture) throw new Error("X search did not capture its HTTP response");
      run = await readXSearchPlan(directory, input);
      await atomic(join(directory, "progress.json"), run.state);
    } catch (error) {
      // Deliberately generic: query data, headers and provider errors can contain secrets or untrusted text.
      attempt.state = error instanceof XBudgetExceeded ? "budget-blocked" : error instanceof TransientXReadError ? "retryable" : "failed";
      if (error instanceof TransientXReadError) attempt.retryAfter = new Date(now().getTime() + error.retryAfterMS).toISOString();
      attempt.error = error instanceof XBudgetExceeded ? "Dollar budget reached before HTTP" : "Search failed; inspect captured evidence before retrying";
      await atomic(join(directory, "progress.json"), run.state);
      const report = { ...run.report, status: error instanceof XBudgetExceeded ? "budget-limit" : "failed",
        requests: run.state.attempts.length, requestsThisRun: calls,
        ...(error instanceof TransientXReadError ? { retryAfter: new Date(now().getTime() + error.retryAfterMS).toISOString() } : {}) };
      await atomic(join(directory, "report.json"), report);
      if (error instanceof TransientXReadError && error.retryAfterMS <= 30000 && calls < options.maxRequests &&
          run.state.attempts.filter(a => a.query === attempt.query && a.cursor === attempt.cursor && a.state !== "budget-blocked").length < 3) {
        await (options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(Math.max(1000, error.retryAfterMS));
        run = await readXSearchPlan(directory, input);
        continue;
      }
      return report;
    }
  }
  const report = { ...run.report, requestsThisRun: calls,
    ...(run.state.attempts.length >= 10000 && run.report.status !== "complete" ? { status: "checkpoint-limit" } : {}) };
  await atomic(join(directory, "report.json"), report);
  return report;
}
