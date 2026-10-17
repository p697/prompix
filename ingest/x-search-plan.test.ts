import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildXSearchPlan, readXSearchPlan, runXSearchPlan, boundedSearchQuery, type XSearchPlan } from "./x-search-plan.ts";
import { atomic, json } from "./publication.ts";
import { TwitterAPIClient } from "./twitterapi.ts";
import { XSpendBudget } from "./x-spend.ts";

const at = "2026-10-17T08:00:00.000Z", now = () => new Date(at), sleep = async () => {};
const start = Date.parse("2026-10-17T06:00:00Z") / 1000, end = start + 7200;
const plan = (count = 2, maxPages = 3): XSearchPlan => ({ version: 1, maxPagesPerQuery: maxPages,
  queries: Array.from({ length: count }, (_, n) => ({ id: `query-${n}`, query: "prompt has:images -is:reply", start, end, lane: n ? "recall" : "topic" })) });
const tweet = (id = "101", overrides = {}) => ({ id, text: "Image prompt: Paint an original quiet garden in warm watercolor.",
  createdAt: "Sat Oct 17 07:00:00 +0000 2026", isReply: false, author: { id: "42", userName: "fixture", name: "Fixture" },
  extendedEntities: { media: [{ id_str: "501", type: "photo", media_url_https: "https://pbs.twimg.com/media/fixture.jpg" }] }, ...overrides });
const page = (tweets: unknown[], next?: string) => ({ tweets, has_next_page: !!next, next_cursor: next ?? null });
async function fixture(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "prompix-search-plan-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function client(root: string, send: (url: URL) => unknown | Promise<unknown>, limit = 1) {
  return new TwitterAPIClient("secret-fixture", new XSpendBudget(join(root, "spend"), 20, limit, now), (async url => Response.json(await send(new URL(String(url))))) as typeof fetch);
}

test("planner preserves every existing topic and adds independent visual lanes in exact UTC partitions", () => {
  const p = buildXSearchPlan("2026-07-01T00:00:00Z", "2026-07-01T13:00:00Z");
  assert.equal(p.queries.length, 42);
  assert.equal(p.queries.filter(q => q.lane === "recall").length, 12);
  assert.ok(p.queries.some(q => q.id.startsWith("creative-skills")));
  assert.ok(p.queries.some(q => q.id.startsWith("text")));
  const image = p.queries.filter(q => q.id.startsWith("image-" ) && !q.id.startsWith("image-art") && !q.id.startsWith("image-photo") && !q.id.startsWith("image-design") && !q.id.startsWith("image-style"));
  assert.equal(image.at(-1)!.start, Date.parse("2026-07-01T00:00:00Z") / 1000);
  assert.equal(image[0].start, image[1].end);
  assert.match(boundedSearchQuery(image[0]), /since_time:\d+ until_time:\d+$/);
  for (const [a, b] of [["bad", at], [at, at], ["2026-01-01", at]]) assert.throws(() => buildXSearchPlan(a, b));
});

test("round-robin pagination resumes exactly, deduplicates globally and never writes official acquisitions", async () => fixture(async root => {
  const requests: string[] = [];
  const api = client(root, url => { const cursor = url.searchParams.get("cursor"); requests.push(cursor ?? "first");
    return cursor ? page([tweet("102")]) : page([tweet()], "next"); });
  const directory = join(root, "leads");
  await runXSearchPlan(directory, plan(), { search: api.search.bind(api), maxRequests: 3, now, sleep });
  const final = await runXSearchPlan(directory, plan(), { search: api.search.bind(api), maxRequests: 5, now, sleep });
  assert.deepEqual(requests, ["first", "first", "next", "next"]);
  assert.equal(final.status, "complete"); assert.equal(final.unique, 2); assert.equal(final.duplicates, 2);
  assert.equal(final.publishableAcquisitions, 0); assert.equal(final.globalRecallProven, false);
  assert.equal((await runXSearchPlan(directory, plan(), { search: api.search.bind(api), maxRequests: 5, now, sleep })).requestsThisRun, 0);
  assert.equal((await readdir(root)).includes("x-discovery"), false);
}));

test("local time, media and relationship validation drops bad results without refunding paid entries", async () => fixture(async root => {
  const api = client(root, () => page([tweet(), tweet("102", { createdAt: "Sat Oct 17 08:00:00 +0000 2026" }),
    tweet("103", { extendedEntities: undefined }), tweet("104", { isReply: true, inReplyToId: "90", inReplyToUserId: "42", conversationId: "90" })]));
  const result = await runXSearchPlan(join(root, "leads"), plan(1), { search: api.search.bind(api), maxRequests: 1, now, sleep });
  assert.equal(result.returned, 4); assert.equal(result.unique, 1);
  assert.deepEqual(result.violations.map(v => v.issues[0]), ["after-window", "missing-image", "excluded-reply"]);
  const ledger = await json<any>(join(root, "spend", "2026-10.json"), null);
  assert.equal(ledger.entries[0].accounted, 600);
}));

test("a partial page with a continuation is not terminal and a page cap does not claim completeness", async () => fixture(async root => {
  let calls = 0;
  const api = client(root, () => { calls++; return page(calls === 1 ? [] : [tweet()], `page-${calls}`); });
  const result = await runXSearchPlan(join(root, "leads"), plan(1, 2), { search: api.search.bind(api), maxRequests: 10, now, sleep });
  assert.equal(calls, 2); assert.equal(result.status, "partial"); assert.equal(result.queries[0].status, "page-limit");
}));

test("persisted failed transport prevents repeated paid calls and secrets never enter the checkpoint", async () => fixture(async root => {
  let calls = 0;
  const api = client(root, () => { calls++; throw new Error("secret-fixture"); });
  const directory = join(root, "leads");
  assert.equal((await runXSearchPlan(directory, plan(), { search: api.search.bind(api), maxRequests: 1, now, sleep })).status, "failed");
  assert.equal((await runXSearchPlan(directory, plan(), { search: api.search.bind(api), maxRequests: 4, now, sleep })).status, "unresolved");
  assert.equal(calls, 1); assert.equal((await readFile(join(directory, "progress.json"), "utf8")).includes("secret-fixture"), false);
}));

test("a captured response survives an interrupted checkpoint and replays with zero paid calls", async () => fixture(async root => {
  const directory = join(root, "leads"), p = plan(1);
  const checkpoint = (await readXSearchPlan(directory, p)).state;
  checkpoint.attempts.push({ state: "reserved", at, query: 0, response: "response-00001.json" });
  await atomic(join(directory, "progress.json"), checkpoint);
  await atomic(join(directory, "response-00001.json"), { at, raw: page([tweet()]) });
  const api = client(root, () => { throw new Error("must not send"); });
  const result = await runXSearchPlan(directory, p, { search: api.search.bind(api), maxRequests: 5, now, sleep });
  assert.equal(result.status, "complete"); assert.equal(result.requestsThisRun, 0);
  assert.equal((await json<any>(join(directory, "progress.json"), null)).attempts[0].state, "completed");
}));

test("cursor cycles, modified plans and missing completed evidence fail closed", async () => fixture(async root => {
  let n = 0;
  const api = client(root, () => page([tweet(String(100 + n++))], n === 2 ? "second" : "first"));
  const directory = join(root, "leads");
  assert.equal((await runXSearchPlan(directory, plan(1, 5), { search: api.search.bind(api), maxRequests: 5, now, sleep })).status, "failed");
  assert.equal(n, 3);
  await assert.rejects(readXSearchPlan(directory, plan(2)), /immutable plan/);
  await assert.rejects(readXSearchPlan(directory, plan(1, 5)), /cycle/);
  const fresh = join(root, "fresh"), state = (await readXSearchPlan(fresh, plan(1))).state;
  state.attempts.push({ state: "completed", at, query: 0, response: "response-00001.json" });
  await atomic(join(fresh, "progress.json"), state);
  await assert.rejects(readXSearchPlan(fresh, plan(1)), /missing its evidence/);
}));

test("shared dollar cap stops before HTTP; invalid inputs stop before any request", async () => fixture(async root => {
  let n = 0;
  const api = client(root, () => { n++; return page([tweet()], "next"); }, 0.0001);
  const directory = join(root, "leads");
  const result = await runXSearchPlan(directory, plan(), { search: api.search.bind(api), maxRequests: 3, now, sleep });
  assert.equal(result.status, "budget-limit"); assert.equal(n, 0);
  const invalid = plan(); invalid.queries[1].query += " since_time:1";
  await assert.rejects(runXSearchPlan(join(root, "invalid"), invalid, { search: api.search.bind(api), maxRequests: 1, now, sleep }), /override/);
  assert.equal(n, 0);
}));

test("transient reads retry at most three times, keep every charge, and recover the same cursor", async () => fixture(async root => {
  let time = Date.parse(at), calls = 0;
  const clock = () => new Date(time), wait = async (ms: number) => { time += ms; };
  const budget = new XSpendBudget(join(root, 'spend'), 20, 1, clock);
  const api = new TwitterAPIClient('fixture-key', budget, (async () => {
    calls++;
    return calls === 1 ? new Response('busy', { status: 503 }) : Response.json(page([tweet()]));
  }) as typeof fetch);
  const result = await runXSearchPlan(join(root, 'recovered'), plan(1), { search: api.search.bind(api), maxRequests: 4, now: clock, sleep: wait });
  assert.equal(result.status, 'complete'); assert.equal(calls, 2);
  let ledger = await json<any>(join(root, 'spend', '2026-10.json'), null);
  assert.deepEqual(ledger.entries.map((e: any) => e.accounted), [3000, 150]);
  const failing = new TwitterAPIClient('fixture-key', budget, (async () => { calls++; return new Response('busy', { status: 503 }); }) as typeof fetch);
  const failed = await runXSearchPlan(join(root, 'failed'), plan(1), { search: failing.search.bind(failing), maxRequests: 10, now: clock, sleep: wait });
  assert.equal(failed.status, 'failed'); assert.equal(calls, 5);
  time += 24 * 3600_000;
  const blocked = await runXSearchPlan(join(root, 'failed'), plan(1), { search: failing.search.bind(failing), maxRequests: 10, now: clock, sleep: wait });
  assert.equal(blocked.status, 'unresolved'); assert.equal(calls, 5);
}));

test("large history stops before exceeding checkpoint capacity or buying an unrecordable request", async () => fixture(async root => {
  const directory = join(root, "large-history"), p = plan(1);
  const state = (await readXSearchPlan(directory, p)).state;
  state.attempts = Array.from({ length: 10000 }, (_, i) => ({ state: "budget-blocked" as const, at, query: 0,
    response: `response-${String(i + 1).padStart(5, "0")}.json` }));
  await atomic(join(directory, "progress.json"), state);
  const api = client(root, () => { throw new Error("Checkpoint capacity must stop before HTTP"); });
  const result = await runXSearchPlan(directory, p, { search: api.search.bind(api), maxRequests: 1, now, sleep });
  assert.equal(result.status, "checkpoint-limit"); assert.equal(result.requestsThisRun, 0);
  assert.equal((await readXSearchPlan(directory, p)).state.attempts.length, 10000);
}));
