import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomic } from "./publication.ts";
import { collectXFeeds, xFeeds, xFeedLimits } from "./x-feed.ts";
import { parseXSearchResponse, xFeedRequest } from "./x.ts";
import { readXIntake } from "./x-intake.ts";
import { discoverX } from "./x-discovery.ts";

const date = new Date("2026-10-13T03:00:00Z"), now = () => date;
const read = async (root: string, file: string) => JSON.parse(await readFile(join(root, file), "utf8"));
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "prompix-feeds-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function response(request: ReturnType<typeof xFeedRequest>, id = "200", nextToken?: string) {
  return { ...parseXSearchResponse({ data: [{ id, author_id: "99", text: "Text prompt: Write a short original story about a gardener and a lantern." }],
    meta: { result_count: 1, newest_id: id, oldest_id: id, ...(nextToken ? { next_token: nextToken } : {}) } }, request.since, request.limit), request };
}

test("independent discovery rotates topics, persists every page, and shares the existing budget", () => fixture(async root => {
  await atomic(join(root, "x-state.json"), { day: "2026-10-13", cursors: {} });
  const calls: string[] = [];
  const run = await collectXFeeds(root, { enabled: true, bearer: "secret", now, search: async (_key, request) => {
    const ledger = await read(root, "x-feed-attempts/2026-10-13.json");
    assert.equal(ledger.attempts.at(-1).state, "reserved");
    assert.equal((await read(root, "x-state.json")).day, "2026-10-13");
    calls.push(request.query); return response(request, String(200 + calls.length));
  } });
  assert.equal(run.status, "ok"); assert.equal(run.requests, 3); assert.equal(run.dailyRequests, 4);
  assert.equal(run.reservedPosts, 160); assert.deepEqual(calls, xFeeds.slice(0, 3).map(f => f.query));
  assert.equal((await readXIntake(root)).report.discovered, 3);
  assert.equal((await collectXFeeds(root, { enabled: true, bearer: "secret", now })).status, "daily-limit");
  assert.equal((await discoverX(root, { publishing: true, bearer: "secret", now: date })).report.status, "daily-limit");
}));

test("pagination never advances the high-water mark before older pages are collected", () => fixture(async root => {
  const first = xFeedRequest(xFeeds[0].query, { limit: 50 }).fingerprint;
  await atomic(join(root, "x-feed-state.json"), { nextFeed: 0, cursors: { [first]: { since: "100" } } });
  let calls = 0;
  const run = await collectXFeeds(root, { enabled: true, bearer: "secret", now, limits: { requests: 6, posts: 300 }, search: async (_key, request) => {
    calls++;
    if (calls === 1) { assert.equal(request.since, "100"); return response(request, "200", "older-page"); }
    if (calls === 6) {
      assert.equal(request.since, "100"); assert.equal(request.nextToken, "older-page");
      assert.equal((await read(root, "x-feed-state.json")).cursors[first].since, "100");
      return response(request, "150");
    }
    return response(request, String(200 + calls));
  } });
  assert.equal(run.count, 6); assert.equal((await read(root, "x-feed-state.json")).cursors[first].since, "200");
  assert.equal((await read(root, "x-feed-state.json")).cursors[first].nextToken, undefined);
  assert.equal((await readXIntake(root)).report.snapshots, 6);
}));

test("failed paid read stops the day's loop without leaking credentials or losing its cursor", () => fixture(async root => {
  let calls = 0;
  const options = { enabled: true, bearer: "fixture-secret", now, search: async () => { calls++; throw new Error("timeout fixture-secret"); } };
  const result = await collectXFeeds(root, options);
  assert.equal(result.status, "failed"); assert.equal(result.requests, 1);
  assert.equal(result.message?.includes("fixture-secret"), false);
  assert.equal((await collectXFeeds(root, options)).status, "daily-limit"); assert.equal(calls, 1);
  await assert.rejects(read(root, "x-feed-state.json"), { code: "ENOENT" });
}));

test("budget changes and restarts preserve prior reservations", () => fixture(async root => {
  await atomic(join(root, "x-feed-attempts/2026-10-13.json"), { legacyRequests: 0, legacyPosts: 0,
    attempts: [{ feed: "image", request: "digest", reservedPosts: 50, state: "reserved" }] });
  let called = false;
  const report = await collectXFeeds(root, { enabled: true, bearer: "secret", now, limits: { requests: 20, posts: 1000 },
    search: async (_key, request) => { called = true; return response(request); } });
  assert.equal(report.status, "daily-limit"); assert.equal(report.reservedPosts, 50); assert.equal(called, false);
}));

test("dry-run, missing credentials and disabled budgets never contact X", () => fixture(async root => {
  const search = async () => { throw new Error("Unexpected API call"); };
  assert.equal((await collectXFeeds(root, { enabled: false, bearer: "secret", now, search })).status, "dry-run");
  assert.equal((await collectXFeeds(root, { enabled: true, now, search })).status, "not-configured");
  assert.equal((await collectXFeeds(root, { enabled: true, bearer: "secret", now, search, limits: { requests: 0, posts: 0 } })).status, "daily-limit");
  await assert.rejects(read(root, "x-feed-attempts/2026-10-13.json"), { code: "ENOENT" });
}));

test("midnight stops further paid requests instead of silently resetting the budget", () => fixture(async root => {
  let calls = 0;
  const clock = () => calls ? new Date("2026-10-14T00:00:00Z") : date;
  const report = await collectXFeeds(root, { enabled: true, bearer: "secret", now: clock,
    search: async (_key, request) => { calls++; return response(request); } });
  assert.equal(report.requests, 1); assert.equal(calls, 1);
}));

test("page validation scales to fifty complete posts, while the legacy API remains capped at ten", () => {
  const body = { data: Array.from({ length: 50 }, (_, index) => ({ id: String(200 - index), text: "Synthetic prompt" })),
    meta: { result_count: 50, newest_id: "200", oldest_id: "151" } };
  assert.equal(parseXSearchResponse(body, undefined, 50).posts.length, 50);
  assert.throws(() => parseXSearchResponse(body), /invalid response/);
  assert.throws(() => xFeedLimits({ PROMPIX_X_MAX_REQUESTS: "30" }), /Invalid/);
  const first = xFeedRequest(xFeeds[0].query, { limit: 50 });
  assert.equal(first.fingerprint, xFeedRequest(xFeeds[0].query, { limit: 20, since: "123", nextToken: "abc" }).fingerprint);
  assert.notEqual(first.fingerprint, xFeedRequest(xFeeds[1].query, { limit: 50 }).fingerprint);
});

test("expired page tokens restart at the committed boundary, never at the unfinished newest ID", () => fixture(async root => {
  const key = xFeedRequest(xFeeds[0].query, { limit: 50 }).fingerprint;
  await atomic(join(root, "x-feed-state.json"), { nextFeed: 0, cursors: { [key]: {
    since: "100", newest: "300", nextToken: "expired", startedAt: "2026-10-10T00:00:00Z",
  } } });
  await collectXFeeds(root, { enabled: true, bearer: "secret", now, limits: { requests: 1, posts: 50 }, search: async (_key, request) => {
    assert.equal(request.since, "100"); assert.equal(request.nextToken, undefined);
    return response(request, "250");
  } });
  assert.equal((await read(root, "x-feed-state.json")).cursors[key].since, "250");
}));
