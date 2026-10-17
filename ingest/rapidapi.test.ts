import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomic, json } from "./publication.ts";
import { XSpendBudget } from "./x-spend.ts";
import { RapidAPIClient } from "./rapidapi.ts";
import { parseRapidAPISources } from "./rapidapi-sources.ts";
import { prepareXAvailability, readXAvailability, configuredRecheck } from "./x-availability.ts";
import { recheckXStandalone } from "./x-recheck.ts";
import { convertXDiscovery } from "./x-intake.ts";
import { at, tweet, envelope } from "./test-support/rapidapi.ts";

const now = "2026-10-18T03:00:00.000Z", sleep = async () => {};
const headers = (remaining = 999) => ({ "x-ratelimit-requests-limit": "1000", "x-ratelimit-requests-remaining": String(remaining) });
async function fixture(run: (f: { root: string; budget: XSpendBudget; terms: any }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "prompix-rapidapi-client-"));
  const budget = new XSpendBudget(join(root, "spend"), 20, 20, () => new Date(now));
  const fee = await budget.reserve("rapidapi", "subscription", "synthetic-receipt", 1);
  await budget.confirmRapidAPIPilotFee(fee.id);
  const terms = { provider: "twitter241", feeReservationID: fee.id, feeMonth: "2026-10", startsAt: at,
    endsAt: "2026-11-17T14:00:00Z", stopAt: "2026-11-16T14:00:00Z", requestLimit: 1000 } as const;
  await budget.reconcileRapidAPICycle(terms, 0);
  try { await run({ root, budget, terms }); } finally { await rm(root, { recursive: true, force: true }); }
}
async function intake(root: string, ids: string[]) {
  const posts = ids.map(id => tweet(id)), r = parseRapidAPISources(envelope(...posts), ids);
  for (let i = 0; i < r.posts.length; i += 100)
    await atomic(join(root, "x-discovery", `2026-10-17-feed-${String(i / 100 + 1).padStart(3, "0")}.json`), { capturedAt: at, posts: r.posts.slice(i, i + 100), creators: r.creators, media: r.media });
  return r;
}

test("production transport accounts before HTTP, captures before validation and accepts up to 200 complete sources", () => fixture(async ({ root, budget }) => {
  const ids = Array.from({ length: 200 }, (_, i) => String(i + 1000)); let captured: any, calls = 0;
  const client = new RapidAPIClient("synthetic-secret", budget, (async (input, options) => {
    calls++; const url = new URL(String(input));
    assert.equal(url.hostname, "twitter241.p.rapidapi.com"); assert.equal(url.searchParams.get("tweetIds"), ids.join(","));
    assert.equal(options?.redirect, "manual"); assert.ok(options?.signal);
    assert.equal((await json<any>(join(root, "spend", "2026-10.json"), null)).entries.at(-1).state, "reserved");
    return Response.json(envelope(...ids.map(id => tweet(id))), { headers: headers() });
  }) as typeof fetch);
  const { result } = await client.lookup(ids, async value => { captured = value; }, "maintenance");
  assert.equal(result.posts.length, 200); assert.equal(result.provider, "rapidapi"); assert.equal(calls, 1);
  assert.equal(captured.status, 200); assert.equal(captured.quota["x-ratelimit-requests-remaining"], "999");
  const ledger = await json<any>(join(root, "spend", "2026-10.json"), null);
  assert.equal(ledger.entries.length, 2); assert.equal(ledger.entries[1].state, "completed"); assert.equal(ledger.entries[1].accounted, 0);
}));

test("invalid identities, absent capture and an unconfigured cycle stop before HTTP", () => fixture(async ({ root, budget }) => {
  let calls = 0;
  const client = new RapidAPIClient("synthetic-secret", budget, (async () => { calls++; return Response.json({}); }) as typeof fetch);
  for (const ids of [[], ["1", "1"], ["bad"], Array.from({ length: 201 }, (_, i) => String(i + 1))])
    await assert.rejects(client.lookup(ids, async () => {}, "maintenance"));
  await assert.rejects(client.lookup(["1"], undefined as any, "maintenance"), /capture/);
  await rm(join(root, "spend", "rapidapi-cycle.json"));
  await assert.rejects(client.lookup(["1"], async () => {}, "maintenance"), /not configured/);
  assert.equal(calls, 0); assert.equal((await json<any>(join(root, "spend", "2026-10.json"), null)).entries.length, 1);
}));

test("transport, HTTP, malformed quota, body and capture failures stay accounted without retry or secret leakage", async () => {
  for (const failure of ["transport", 302, 401, 429, 500, "json", "source", "quota", "over-quota", "capture"] as const)
    await fixture(async ({ root, budget }) => {
      let calls = 0, captured = false;
      const client = new RapidAPIClient("synthetic-secret", budget, (async () => {
        calls++; if (failure === "transport") throw new Error("synthetic-secret");
        if (failure === "source") return Response.json(envelope({ __typename: "Tweet", rest_id: "101" }), { headers: headers() });
        if (failure === "quota") return Response.json(envelope(tweet()), { headers: { "x-ratelimit-requests-limit": "10000" } });
        return new Response("synthetic-secret", { status: typeof failure === "number" ? failure : 200,
          headers: headers(failure === "over-quota" ? 1001 : 999) });
      }) as typeof fetch);
      await assert.rejects(client.lookup(["101"], async () => { captured = true; if (failure === "capture") throw new Error("synthetic-secret"); }, "maintenance"),
        (e: any) => !e.message.includes("synthetic-secret"));
      assert.equal(calls, 1); assert.equal(captured, failure !== "transport");
      const entries = (await json<any>(join(root, "spend", "2026-10.json"), null)).entries;
      assert.equal(entries[1].state, "uncertain"); assert.equal(entries[0].accounted, 1_000_000);
    });
});

test("zero quota on a failed response blocks subsequent HTTP and higher counters cannot refill credits", () => fixture(async ({ budget, terms }) => {
  let calls = 0;
  const client = new RapidAPIClient("synthetic-secret", budget, (async () => { calls++; return new Response("quota exhausted", { status: 429, headers: headers(0) }); }) as typeof fetch);
  await assert.rejects(client.lookup(["101"], async () => {}, "maintenance"), /HTTP 429/);
  await assert.rejects(client.lookup(["101"], async () => {}, "maintenance"), /quota exhausted/);
  assert.equal(calls, 1); assert.equal((await budget.reconcileRapidAPICycle(terms, 0)).remaining, 0);
}));

test("out-of-order quota observations include other pending and uncertain attempts conservatively", () => fixture(async ({ budget, terms }) => {
  const a = await budget.reserveRapidAPICycleLookup("a"), b = await budget.reserveRapidAPICycleLookup("b");
  assert.equal((await budget.observeRapidAPICycleQuota(a.id, 999)).used, 2);
  await a.finish(1);
  assert.equal((await budget.observeRapidAPICycleQuota(b.id, 998)).used, 2);
  await b.finish();
  const c = await budget.reserveRapidAPICycleLookup("c");
  assert.equal((await budget.observeRapidAPICycleQuota(c.id, 990)).used, 11);
  await c.finish(1);
  assert.equal((await budget.observeRapidAPICycleQuota(a.id, 999)).used, 11);
  await assert.rejects(budget.observeRapidAPICycleQuota(randomUUID(), 0), /Unknown/);
  assert.equal((await budget.reconcileRapidAPICycle(terms, 1)).used, 11);
}));

test("real adapter batches 200+1, preserves source provenance and resumes without repeating paid reads", () => fixture(async ({ root, budget }) => {
  const ids = Array.from({ length: 201 }, (_, i) => String(i + 1000));
  // Each normalized response is bounded to 200; intake snapshots use 100.
  await intake(root, ids.slice(0, 200));
  const last = parseRapidAPISources(envelope(tweet(ids[200])), [ids[200]]);
  await atomic(join(root, "x-discovery", "2026-10-17-feed-003.json"), { capturedAt: at, ...last, provider: undefined });
  const original = await readFile(join(root, "x-discovery", "2026-10-17-feed-001.json"));
  const calls: number[] = [];
  const client = new RapidAPIClient("synthetic-secret", budget, (async input => {
    const batch = new URL(String(input)).searchParams.get("tweetIds")!.split(","); calls.push(batch.length);
    return Response.json(envelope(...batch.map(id => tweet(id))), { headers: headers(1000 - calls.length) });
  }) as typeof fetch);
  const options = { enabled: true, bearer: "synthetic", now, maxRequests: 0,
    admission: { publishedIDs: new Set(ids.map(id => `x-post-${id}`)), attemptedIDs: new Set<string>(), maxDrafts: 0 },
    recheck: { provider: "rapidapi" as const, maxRequests: 4, sleep, lookup: client.lookup.bind(client) } };
  const checked = await prepareXAvailability(root, options);
  assert.deepEqual(calls, [200, 1]); assert.equal(checked.report.recheck?.verified, 201);
  assert.equal(Object.values(checked.state).every(s => s.checkedBy === "rapidapi" && s.status === "ready"), true);
  assert.deepEqual(await readXAvailability(root), checked.state);
  assert.ok(original.equals(await readFile(join(root, "x-discovery", "2026-10-17-feed-001.json"))));
  assert.equal((await prepareXAvailability(root, options)).report.recheck?.requests, 0); assert.deepEqual(calls, [200, 1]);
  assert.equal(await json(join(root, "x-rechecks", "2026-10-18.json"), null), null);
  assert.equal((await json<any>(join(root, "x-rechecks", "rapidapi", "responses", "2026-10-18-001.json"), null)).provider, "rapidapi");
}));

test("first successful batch survives a later transport failure; restart does not repeat the failed provider call", () => fixture(async ({ root, budget }) => {
  const ids = Array.from({ length: 200 }, (_, i) => String(i + 1000));
  await intake(root, ids);
  const last = parseRapidAPISources(envelope(tweet("2001")), ["2001"]);
  await atomic(join(root, "x-discovery", "2026-10-17-feed-003.json"), { ...last, capturedAt: at, provider: undefined });
  let calls = 0;
  const client = new RapidAPIClient("synthetic-secret", budget, (async input => {
    if (++calls > 1) throw new Error("transport");
    const batch = new URL(String(input)).searchParams.get("tweetIds")!.split(",");
    return Response.json(envelope(...batch.map(id => tweet(id))), { headers: headers() });
  }) as typeof fetch);
  const options = { enabled: true, bearer: "synthetic", now, maxRequests: 0,
    admission: { publishedIDs: new Set([...ids, "2001"].map(id => `x-post-${id}`)), attemptedIDs: new Set<string>(), maxDrafts: 0 },
    recheck: { provider: "rapidapi" as const, maxRequests: 4, sleep, lookup: client.lookup.bind(client) } };
  const checked = await prepareXAvailability(root, options);
  assert.equal(checked.report.recheck?.status, "failed"); assert.equal(checked.report.recheck?.verified, 200);
  assert.equal(checked.state["x-post-2001"], undefined);
  assert.equal((await prepareXAvailability(root, options)).report.recheck?.requests, 0); assert.equal(calls, 2);
  const entries = (await json<any>(join(root, "spend", "2026-10.json"), null)).entries;
  assert.deepEqual(entries.slice(1).map((e: any) => e.state), ["completed", "uncertain"]);
}));

test("state-write interruption retains the provider attempt and a routing rollback keeps separate ledgers", () => fixture(async ({ root }) => {
  const result = await intake(root, ["101"]), item = convertXDiscovery([{ name: "fixture", data: { ...result, capturedAt: at } }]).candidates[0];
  let calls = 0;
  const options = { provider: "rapidapi" as const, maxRequests: 4, sleep, now, excerpts: {},
    lookup: async () => { calls++; return { raw: {}, result }; }, apply: async () => { throw new Error("state-write"); } };
  assert.equal((await recheckXStandalone(root, [item], options)).status, "failed");
  assert.equal((await recheckXStandalone(root, [item], options)).requests, 0); assert.equal(calls, 1);
  const failed = await readFile(join(root, "x-rechecks", "rapidapi", "2026-10-18.json"));
  const rollback = await prepareXAvailability(root, { enabled: true, bearer: "synthetic", now, maxRequests: 0,
    recheck: { maxRequests: 4, sleep, lookup: async () => ({ raw: {}, result: { ...result, provider: "twitterapi" } }) } });
  assert.equal(rollback.state[item.id].checkedBy, "twitterapi");
  assert.ok(failed.equals(await readFile(join(root, "x-rechecks", "rapidapi", "2026-10-18.json"))));
  assert.equal((await json<any[]>(join(root, "x-rechecks", "2026-10-18.json"), []))[0].state, "completed");
}));

test("changed and omitted sources require official fallback, never deletion or freshness from provider identity alone", () => fixture(async ({ root }) => {
  const baseline = await intake(root, ["101", "102", "103"]);
  const changed = tweet("101"); changed.legacy.full_text += " Make the painting blue.";
  const result = parseRapidAPISources(envelope(changed, tweet("103")), ["101", "102", "103"]);
  let official = 0;
  const checked = await prepareXAvailability(root, { enabled: true, bearer: "synthetic", now,
    recheck: { provider: "rapidapi", maxRequests: 4, sleep, lookup: async () => ({ raw: {}, result }) },
    lookup: async (_, ids) => { official++; assert.deepEqual(ids, ["101", "102"]); return { ...baseline,
      posts: baseline.posts.filter(p => ids.includes(p.id)).map(p => ({ ...p, created_at: p.created_at! })), unavailable: [] }; } });
  assert.equal(official, 1); assert.equal(checked.state["x-post-103"].checkedBy, "rapidapi");
  for (const id of ["101", "102"]) { assert.equal(checked.state[`x-post-${id}`].checkedBy, "official"); assert.equal(checked.state[`x-post-${id}`].removed, undefined); }
}));

test("explicit provider configuration needs the shared budget/key and rejects unknown choices", () => {
  const saved = { ...process.env };
  try {
    process.env.PROMPIX_X_RECHECK_PROVIDER = "rapidapi";
    process.env.PROMPIX_X_MONTHLY_USD = "20"; process.env.RAPIDAPI_KEY = "synthetic-key";
    assert.equal(configuredRecheck()?.provider, "rapidapi");
    delete process.env.RAPIDAPI_KEY; assert.throws(() => configuredRecheck(), /budget and key/);
    process.env.PROMPIX_X_RECHECK_PROVIDER = "unknown"; assert.throws(() => configuredRecheck(), /Invalid/);
    process.env.PROMPIX_X_RECHECK_PROVIDER = "official"; assert.equal(configuredRecheck(), undefined);
  } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});
