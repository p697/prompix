import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomic, json } from "./publication.ts";
import { convertXDiscovery } from "./x-intake.ts";
import { XBudgetExceeded } from "./x-spend.ts";
import { unchangedXStandalone, recheckXStandalone } from "./x-recheck.ts";
import { filterXAvailability, prepareXAvailability, configuredRecheck } from "./x-availability.ts";
import type { TwitterAPIResult } from "./twitterapi.ts";

const capturedAt = "2026-10-16T00:00:00.000Z", now = "2026-10-17T01:00:00.000Z";
const creator = { id: "x-id-9", externalID: "9", platform: "x" as const, username: "fixture", displayName: "Fixture", profileURL: "https://x.com/fixture" };
const post = { id: "101", author_id: "9", created_at: capturedAt,
  text: "Image prompt:\nCreate an original watercolor garden with warm morning light, delicate green leaves and a clear focal point.",
  attachments: { media_keys: ["photo1", "photo2"] } };
const media = ["photo1", "photo2"].map(media_key => ({ media_key, type: "photo" as const, url: `https://pbs.twimg.com/media/${media_key}.jpg` }));
const snapshot = { capturedAt, posts: [post], creators: [creator], media };
const candidate = () => convertXDiscovery([{ name: "fixture", data: snapshot }]).candidates[0];
const response = (): TwitterAPIResult => ({ posts: [structuredClone(post)], creators: [structuredClone(creator)], media: structuredClone(media), provider: "twitterapi", unknownIDs: [] });
const sleep = async () => {};
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "prompix-x-recheck-"));
  try { await atomic(join(root, "x-discovery", "2026-10-16.json"), snapshot); await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("exact source, extraction and complete media match; edits, added/removed photos and attribution changes do not", () => {
  const item = candidate(); assert.ok(item);
  assert.equal(unchangedXStandalone(item, response(), now), true);
  const changes: ((r: TwitterAPIResult) => void)[] = [
    r => { r.posts[0].text += " Use blue light."; },
    r => { r.posts[0].text = r.posts[0].text.replace("watercolor", "oil-painted"); },
    r => { r.posts[0].truncated = true; },
    r => { r.posts[0].author_id = "8"; },
    r => { r.posts[0].created_at = "2026-10-16T00:01:00.000Z"; },
    r => { r.media.pop(); r.posts[0].attachments!.media_keys!.pop(); },
    r => { r.media.push({ media_key: "third", type: "photo", url: "https://pbs.twimg.com/media/third.jpg" }); r.posts[0].attachments!.media_keys!.push("third"); },
    r => { r.creators[0].username = "renamed"; r.creators[0].profileURL = "https://x.com/renamed"; },
    r => { r.creators[0].displayName = "Renamed"; },
    r => { r.creators[0].avatarURL = "https://pbs.twimg.com/profile_images/new.jpg"; },
    r => { r.posts[0].referenced_tweets = [{ type: "quoted", id: "99" }]; },
    r => { r.posts = []; r.unknownIDs = [post.id]; },
  ];
  for (const [index, change] of changes.entries()) { const result = response(); change(result); assert.equal(unchangedXStandalone(item, result, now), false, `Mutation ${index}`); }
});

test("unchanged third-party checks preserve official acquisition and approval revision without writing discovery", () => fixture(async root => {
  let official = 0;
  const item = candidate(), before = await json(join(root, "x-discovery", "2026-10-16.json"), null);
  const result = await prepareXAvailability(root, { enabled: true, bearer: "fixture", now,
    recheck: { maxRequests: 2, sleep, lookup: async (ids, capture) => {
      assert.deepEqual(ids, [post.id]);
      assert.equal((await json<any[]>(join(root, "x-rechecks", "2026-10-17.json"), []))[0].state, "reserved");
      await capture?.({ fixture: true }); return { raw: {}, result: response() };
    } }, lookup: async () => { official++; throw new Error("No official call for identical standalone content"); } });
  assert.equal(official, 0); assert.equal(result.report.recheck?.verified, 1);
  assert.equal(result.state[item.id].checkedBy, "twitterapi"); assert.equal(result.state[item.id].revision, item.source.revision);
  assert.equal(filterXAvailability([item], result.state, Date.parse(now)).prompts.length, 1);
  assert.equal(filterXAvailability([item], result.state, Date.parse(now) + 24 * 3600_000).prompts.length, 0);
  assert.equal(item.source.license, "X-API-Terms");
  assert.deepEqual(await readdir(join(root, "x-discovery")), ["2026-10-16.json"]);
  assert.deepEqual(await json(join(root, "x-discovery", "2026-10-16.json"), null), before);
  assert.equal((await json<any>(join(root, "x-rechecks", "responses", "2026-10-17-001.json"), null)).provider, "twitterapi");
}));

test("third-party omissions route to official verification; a readable post is not deleted", () => fixture(async root => {
  let calls = 0;
  const result = await prepareXAvailability(root, { enabled: true, bearer: "fixture", now,
    recheck: { maxRequests: 2, sleep, lookup: async () => ({ raw: {}, result: { ...response(), posts: [], unknownIDs: [post.id] } }) },
    lookup: async (_, ids) => { calls++; assert.deepEqual(ids, [post.id]); return { ...snapshot, unavailable: [] }; } });
  assert.equal(calls, 1); assert.equal(result.report.recheck?.unresolved, 1);
  assert.equal(result.state[candidate().id].checkedBy, "official"); assert.equal(result.state[candidate().id].status, "ready");
  assert.equal(result.state[candidate().id].removed, undefined);
}));

test("only official withdrawal persists removal, and missing sources stay withheld if fallback cannot run", () => fixture(async root => {
  const item = candidate();
  await atomic(join(root, "x-availability", "state.json"), { [item.id]: { checkedAt: "2026-10-16T12:00:00.000Z", status: "ready", revision: item.source.revision } });
  const recheck = { maxRequests: 2, sleep, lookup: async () => ({ raw: {}, result: { ...response(), posts: [], unknownIDs: [post.id] } }) };
  const limited = await prepareXAvailability(root, { enabled: true, bearer: "fixture", now, maxRequests: 0, recheck });
  assert.equal(limited.state[item.id].status, "withheld"); assert.equal(limited.state[item.id].removed, undefined);
  assert.equal(filterXAvailability([item], limited.state, Date.parse(now)).prompts.length, 0);
  const confirmed = await prepareXAvailability(root, { enabled: true, bearer: "fixture", now: "2026-10-17T14:00:00.000Z", recheck,
    lookup: async () => ({ posts: [], creators: [], media: [], unavailable: [post.id] }) });
  assert.equal(confirmed.state[item.id].removed, true);
}));

test("changed sources need official hydration and invalidate the old editorial revision", () => fixture(async root => {
  const changed = response(); changed.posts[0].text += " Make the scene overcast.";
  const result = await prepareXAvailability(root, { enabled: true, bearer: "fixture", now,
    recheck: { maxRequests: 2, sleep, lookup: async () => ({ raw: {}, result: changed }) },
    lookup: async () => ({ ...snapshot, posts: [{ ...post, text: changed.posts[0].text }], unavailable: [] }) });
  assert.equal(result.report.recheck?.unresolved, 1);
  assert.equal(result.state[candidate().id].checkedBy, "official");
  assert.notEqual(result.state[candidate().id].revision, candidate().source.revision);
  assert.equal(filterXAvailability([candidate()], result.state, Date.parse(now)).prompts.length, 0);
}));

test("failed and exhausted third-party ledgers survive reruns without paid retries or false freshness", () => fixture(async root => {
  let calls = 0;
  const recheck = { maxRequests: 2, sleep, lookup: async () => { calls++; throw new Error("Rate limited"); } };
  const first = await prepareXAvailability(root, { enabled: true, bearer: "fixture", now, maxRequests: 0, recheck });
  assert.equal(first.report.recheck?.status, "failed"); assert.equal(first.state[candidate().id], undefined);
  const repeat = await prepareXAvailability(root, { enabled: true, bearer: "fixture", now, maxRequests: 0, recheck });
  assert.equal(repeat.report.recheck?.status, "daily-limit"); assert.equal(calls, 1);
  await assert.rejects(prepareXAvailability(root, { enabled: true, bearer: "fixture", now, recheck: { ...recheck, maxRequests: 41 } }), /budget/);
}));

test("batches stay at fifty and a daily allowance cannot be reset by a second invocation", () => fixture(async root => {
  const posts = Array.from({ length: 61 }, (_, index) => ({ ...post, id: String(1000 + index) }));
  await atomic(join(root, "x-discovery", "2026-10-16.json"), { ...snapshot, posts });
  const calls: number[] = [];
  const recheck = { maxRequests: 1, sleep, lookup: async (ids: readonly string[]) => {
    calls.push(ids.length); return { raw: {}, result: { ...response(), posts: posts.filter(p => ids.includes(p.id)) } };
  } };
  const first = await prepareXAvailability(root, { enabled: true, bearer: "fixture", now, maxRequests: 0, recheck });
  assert.equal(first.report.recheck?.verified, 50);
  const repeat = await prepareXAvailability(root, { enabled: true, bearer: "fixture", now, maxRequests: 0, recheck });
  assert.equal(repeat.report.recheck?.requests, 0); assert.deepEqual(calls, [50]);
}));

test("protected sources precede drafts in separate batches; preflight refusal never poisons maintenance ledger", () => fixture(async root => {
  const posts = [post, { ...post, id: "102" }];
  await atomic(join(root, "x-discovery", "2026-10-16.json"), { ...snapshot, posts });
  const calls: { ids: readonly string[]; purpose: unknown }[] = [];
  const admission = { publishedIDs: new Set(["x-post-102"]), attemptedIDs: new Set<string>(), maxDrafts: 10 };
  const recheck = { maxRequests: 4, sleep, lookup: async (ids: readonly string[], _capture?: unknown, purpose?: "growth" | "maintenance") => {
    calls.push({ ids, purpose });
    if (purpose === "growth") throw new XBudgetExceeded("fixture preflight: no HTTP sent");
    return { raw: {}, result: { ...response(), posts: posts.filter(p => ids.includes(p.id)) } };
  } };
  const first = await prepareXAvailability(root, { enabled: true, bearer: "fixture", now, maxRequests: 4, admission, recheck,
    lookup: async (_, ids, purpose) => { assert.deepEqual(ids, ["101"]); assert.equal(purpose, "growth"); throw new XBudgetExceeded("fixture"); } });
  assert.equal(first.report.recheck?.status, "budget-limited"); assert.equal(first.report.recheck?.requests, 1);
  assert.equal(first.report.requests, 0); assert.equal(first.report.status, "budget-limited");
  assert.deepEqual(calls, [{ ids: ["102"], purpose: "maintenance" }, { ids: ["101"], purpose: "growth" }]);
  assert.deepEqual(await json(join(root, "x-availability", "2026-10-17.json"), null), []);
  const ledger = await json<any[]>(join(root, "x-rechecks", "2026-10-17.json"), []);
  assert.equal(ledger.length, 1); assert.equal(ledger[0].state, "completed");
  const second = await prepareXAvailability(root, { enabled: true, bearer: "fixture", now: "2026-10-17T14:00:00Z", maxRequests: 0, admission, recheck });
  assert.equal(second.report.recheck?.verified, 1);
  assert.equal((await json<any[]>(join(root, "x-rechecks", "2026-10-17.json"), [])).length, 2);
}));

test("official fallback retains maintenance purpose while drafts never share its batch", () => fixture(async root => {
  const posts = [post, { ...post, id: "102" }];
  await atomic(join(root, "x-discovery", "2026-10-16.json"), { ...snapshot, posts });
  const calls: { ids: readonly string[]; purpose: unknown }[] = [];
  const result = await prepareXAvailability(root, { enabled: true, bearer: "fixture", now, maxRequests: 4,
    admission: { publishedIDs: new Set(["x-post-102"]), attemptedIDs: new Set(), maxDrafts: 10 },
    recheck: { maxRequests: 4, sleep, lookup: async ids => ({ raw: {}, result: { ...response(), posts: [], unknownIDs: [...ids] } }) },
    lookup: async (_, ids, purpose) => { calls.push({ ids, purpose }); return { ...snapshot, posts: posts.filter(p => ids.includes(p.id)), unavailable: [] }; } });
  assert.deepEqual(calls, [{ ids: ["102"], purpose: "maintenance" }, { ids: ["101"], purpose: "growth" }]);
  assert.equal(result.report.checked, 2); assert.equal(result.report.requests, 2);
}));

test("explicit inventory allowance preserves the daily ledger across forty requests and restart", () => fixture(async root => {
  const path = join(root, "x-rechecks", "2026-10-17.json");
  const prior = Array.from({ length: 40 }, (_, i) => ({ ids: [String(2000 + i)], at: now, state: "completed" }));
  await atomic(path, prior);
  let calls = 0;
  const options = { now, excerpts: {}, sleep, maxRequests: 41, dailyRequestCeiling: 80,
    lookup: async () => { calls++; return { raw: {}, result: response() }; }, apply: async () => {} };
  const result = await recheckXStandalone(root, [candidate()], options);
  assert.equal(result.verified, 1); assert.equal(calls, 1);
  const retained = await json<any[]>(path, []);
  assert.deepEqual(retained.slice(0, 40), prior); assert.equal(retained.length, 41);
  assert.equal((await recheckXStandalone(root, [candidate()], options)).status, "daily-limit");
  // Ordinary daily runs can read the larger ledger without gaining allowance or resetting it.
  assert.equal((await recheckXStandalone(root, [candidate()], { ...options, maxRequests: 40, dailyRequestCeiling: undefined })).status, "daily-limit");
  for (const ceiling of [0, 80.5, 81]) await assert.rejects(recheckXStandalone(root, [candidate()], { ...options, dailyRequestCeiling: ceiling }));
  await atomic(path, [...retained.slice(0, 40), { ...retained[40], state: "failed" }]);
  assert.equal((await recheckXStandalone(root, [candidate()], { ...options, maxRequests: 80 })).status, "daily-limit");
  assert.equal(calls, 1);
}));

test("configured maintenance can opt into a larger ceiling without enlarging ordinary defaults", () => {
  const env = { PROMPIX_X_RECHECK_PROVIDER: "twitterapi", PROMPIX_X_MONTHLY_USD: "20", TWITTERAPI_IO_KEY: "fixture" };
  assert.equal(configuredRecheck(env)?.dailyRequestCeiling, 40);
  assert.equal(configuredRecheck(env)?.maxRequests, 16);
  const large = { ...env, PROMPIX_X_RECHECK_DAILY_CEILING: "80", PROMPIX_X_RECHECK_MAX_REQUESTS: "80" };
  assert.equal(configuredRecheck(large)?.dailyRequestCeiling, 80);
  assert.equal(configuredRecheck(large)?.maxRequests, 80);
  for (const patch of [{ PROMPIX_X_RECHECK_MAX_REQUESTS: "81" }, { PROMPIX_X_RECHECK_DAILY_CEILING: "81" },
    { PROMPIX_X_RECHECK_DAILY_CEILING: "0" }, { PROMPIX_X_RECHECK_MAX_REQUESTS: "1.5" }])
    assert.throws(() => configuredRecheck({ ...large, ...patch }), /budget/);
  assert.throws(() => configuredRecheck({ ...env, PROMPIX_X_RECHECK_MAX_REQUESTS: "80" }), /budget/);
});
