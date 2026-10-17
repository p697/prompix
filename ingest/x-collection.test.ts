import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectXDiscovery, currentXSearchPlan, officialSupplementFeeds } from "./x-collection.ts";
import { xFeeds } from "./x-feed.ts";
import { parseXSearchResponse } from "./x.ts";
import { parseTwitterAPI, type TwitterAPIClient } from "./twitterapi.ts";
import { atomic, json } from "./publication.ts";
const day = "2026-10-17", at = new Date(day + "T08:00:00Z");
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "prompix-x-collection-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const environment = (root: string) => ({ PROMPIX_X_DISCOVERY_PROVIDER: "hybrid", TWITTERAPI_IO_KEY: "fixture-key",
  PROMPIX_X_MONTHLY_USD: "20", PROMPIX_X_SPEND_DIR: join(root, "spend") });

test("current search rotates every original topic plus visual recall with an overlapping day", () => {
  const ids = new Set<string>();
  for (let n = 0; n < 7; n++) {
    const p = currentXSearchPlan(new Date(at.getTime() + n * 6 * 3600_000));
    assert.equal(p.queries.length, 4);
    for (const q of p.queries) { assert.equal(q.end - q.start, 86400); ids.add(q.id.replace(/-\d+$/, "")); }
  }
  assert.equal(ids.size, 14); xFeeds.forEach(f => assert.ok(ids.has(f.id)));
  assert.equal(officialSupplementFeeds.filter(f => f.id === "video").length, officialSupplementFeeds.length / 2);
});

test("hybrid routing keeps one durable daily search and acquisition budget across repeated runs and windows", async () => fixture(async root => {
  let time = at, calls = 0, official = 0;
  const search: TwitterAPIClient["search"] = async (_query, _cursor, capture) => {
    calls++; const raw = { tweets: [], has_next_page: true, next_cursor: `next-${calls}` };
    await capture?.(raw); return { raw, result: parseTwitterAPI(raw, { search: true }) };
  };
  const options = { enabled: true, bearer: "fixture", environment: environment(root), now: () => time, search, sleep: async () => {},
    officialSearch: async (_bearer: string, request: Parameters<NonNullable<Parameters<typeof collectXDiscovery>[1]["officialSearch"]>>[1]) => {
      official++; assert.equal(request.limit, 10);
      return { ...parseXSearchResponse({ meta: { result_count: 0 } }, request.since, request.limit), request };
    } };
  const first = await collectXDiscovery(root, options); assert.equal(first.status, "ok"); assert.equal(calls, 20);
  await collectXDiscovery(root, options); assert.equal(calls, 20);
  time = new Date(day + "T20:00:00Z");
  await collectXDiscovery(root, options); assert.equal(calls, 40); assert.equal(official, 3);
  const ledger = await json<any[]>(join(root, "x-search-budgets", day + ".json"), []);
  assert.equal(ledger.reduce((n, a) => n + a.used, 0), 40);
}));

test("failed third-party search cannot disable the independently budgeted official supplement", async () => fixture(async root => {
  let official = 0, third = 0;
  const result = await collectXDiscovery(root, { enabled: true, bearer: "fixture", environment: environment(root), now: () => at,
    sleep: async () => {}, search: async () => { third++; throw new Error("fixture-key"); },
    officialSearch: async (_bearer, request) => { official++; return { ...parseXSearchResponse({ meta: { result_count: 0 } }), request }; } });
  assert.equal(result.status, "failed"); assert.equal(third, 1); assert.equal(official, 1);
  assert.equal(JSON.stringify(result).includes("fixture-key"), false);
}));

test("migration does not reset already-consumed official searches and missing budget never sends a request", async () => fixture(async root => {
  await atomic(join(root, "x-feed-attempts", day + ".json"), { legacyRequests: 0, legacyPosts: 0,
    attempts: [{ feed: "video", request: "prior", reservedPosts: 50, state: "completed", count: 50 }] });
  const raw = { tweets: [], has_next_page: false, next_cursor: null };
  const result = await collectXDiscovery(root, { enabled: true, bearer: "fixture", environment: environment(root), now: () => at,
    sleep: async () => {}, search: async (_query, _cursor, capture) => { await capture?.(raw); return { raw, result: parseTwitterAPI(raw, { search: true }) }; },
    officialSearch: async () => { throw new Error("Must preserve previous paid reservations"); } });
  assert.equal("supplement" in result && result.supplement.reservedPosts, 50);
  await assert.rejects(collectXDiscovery(root, { enabled: true, bearer: "fixture", environment: { PROMPIX_X_DISCOVERY_PROVIDER: "hybrid" } }), /shared dollar budget/);
  assert.equal((await collectXDiscovery(root, { enabled: false, environment: environment(root) })).status, "dry-run");
}));

test("a provider cooldown survives collection windows and UTC midnight without blocking official fallback", async () => fixture(async root => {
  const until = new Date(at.getTime() + 24 * 3600_000).toISOString();
  await atomic(join(root, 'x-search-cooldown.json'), { until });
  let official = 0;
  const result = await collectXDiscovery(root, { enabled: true, bearer: 'fixture', environment: environment(root),
    now: () => new Date('2026-10-18T02:00:00Z'), sleep: async () => {},
    search: async () => { throw new Error('Cooldown must prevent this call'); },
    officialSearch: async (_bearer, request) => { official++; return { ...parseXSearchResponse({ meta: { result_count: 0 } }), request }; } });
  assert.equal(result.status, 'failed');
  assert.equal('search' in result && result.search.retryAfter, until);
  // The first UTC window permits no official search yet; no request is forced past its allowance.
  assert.equal(official, 0);
}));
