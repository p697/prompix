import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomic, json } from "./publication.ts";
import { runXSearchPlan, type XSearchPlan } from "./x-search-plan.ts";
import { parseTwitterAPI } from "./twitterapi.ts";
import { stageXLeadQueue, syncLiveXLeadQueue, acquireXLeadQueue, fairXLeadOrder } from "./x-lead-queue.ts";
import { type XSearchLead } from "./x-search-admission.ts";
import { XBudgetExceeded } from "./x-spend.ts";

const at = "2026-10-17T08:00:00.000Z", next = "2026-10-18T08:00:00.000Z";
const plan: XSearchPlan = { version: 1, maxPagesPerQuery: 1, queries: [{ id: "images", query: "prompt", lane: "recall",
  start: Date.parse("2026-10-17T00:00:00Z") / 1000, end: Date.parse(at) / 1000 }] };
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "prompix-queue-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function capture(directory: string, ids: string[], authorID = "42") {
  const tweets = ids.map(id => ({ id, text: "Image prompt: Paint an original watercolor garden in soft morning light.",
    createdAt: "Sat Oct 17 07:00:00 +0000 2026", isReply: false,
    author: { id: authorID, userName: "fixture", name: "Fixture" },
    extendedEntities: { media: [{ id_str: "501", type: "photo", media_url_https: "https://pbs.twimg.com/media/fixture.jpg" }] } }));
  const raw = { tweets, has_next_page: false, next_cursor: null };
  await runXSearchPlan(directory, plan, { maxRequests: 1, now: () => new Date(at), sleep: async () => {},
    search: async (_query, _cursor, save) => { await save?.(raw); return { raw, result: parseTwitterAPI(raw, { search: true }) }; } });
}
const unavailable = async (_bearer: string, ids: readonly string[]) => ({ posts: [], media: [], creators: [], unavailable: [...ids] });

test("earlier windows stay queued when the next window is empty; replay does not duplicate or renew age", async () => fixture(async root => {
  const first = join(root, "x-search-plans", "2026-10-17-0"), second = join(root, "x-search-plans", "2026-10-17-1");
  await capture(first, ["101", "102"]);
  assert.equal((await syncLiveXLeadQueue(root, at)).added, 2);
  await capture(second, []);
  const update = await syncLiveXLeadQueue(root, next); assert.equal(update.added, 0); assert.equal(update.total, 2);
  assert.equal((await syncLiveXLeadQueue(root, next)).changedPlans, 0);
  const queue = await json<any>(join(root, "x-lead-queue.json"), null);
  assert.ok(queue.entries.every((e: any) => e.firstSeen === at));
  const result = await acquireXLeadQueue(root, { enabled: true, bearer: "fixture", maxPosts: 2, now: next, lookup: unavailable });
  assert.equal(result.unavailable, 2);
}));

test("freshness and old pending candidates share visual slots without duplicates at library scale", () => {
  const leads: XSearchLead[] = Array.from({ length: 10_000 }, (_, i) => ({ id: String(i), authorID: "42", reason: "prompt",
    kind: i % 7 ? "image" : "text", visual: i % 7 !== 0, sourceDate: new Date(Date.parse(at) + i * 1000).toISOString(), evidence: "response-00001.json" }));
  const age = new Map(leads.map(l => [l.id, l.sourceDate]));
  const sorted = fairXLeadOrder(leads, age);
  assert.equal(sorted.length, leads.length); assert.equal(new Set(sorted.map(l => l.id)).size, leads.length);
  assert.deepEqual(sorted.slice(0, 4).map(l => l.id), ["9999", "9998", "9997", "1"]);
  const lastVisual = sorted.reduce((last, l, index) => l.visual ? index : last, -1);
  assert.ok(sorted.slice(0, lastVisual + 1).every(l => l.visual));
});

test("official unavailable and ambiguous failed attempts are never purchased again after UTC midnight", async () => fixture(async root => {
  const directory = join(root, "source"); await capture(directory, ["101", "102", "103"]);
  await stageXLeadQueue(root, [{ directory, lane: "live" }], at);
  let calls = 0;
  await acquireXLeadQueue(root, { enabled: true, bearer: "fixture", maxPosts: 1, now: at,
    lookup: async (_b, ids) => { calls++; assert.deepEqual(ids, ["101"]); return unavailable(_b, ids); } });
  const failed = await acquireXLeadQueue(root, { enabled: true, bearer: "fixture", maxPosts: 2, now: at,
    lookup: async () => { calls++; throw new Error("ambiguous interruption"); } });
  assert.equal(failed.status, "failed");
  const resumed = await acquireXLeadQueue(root, { enabled: true, bearer: "fixture", maxPosts: 3, now: next,
    lookup: async (_b, ids) => { calls++; assert.deepEqual(ids, ["103"]); return unavailable(_b, ids); } });
  assert.equal(resumed.unavailable, 1); assert.equal(resumed.known, 2); assert.equal(resumed.needsInspection, 1); assert.equal(calls, 3);
}));

test("historical acquisition cannot consume the normal discovery allowance or reset legacy reservations", async () => fixture(async root => {
  const live = join(root, "live"), history = join(root, "history");
  await capture(live, ["101", "102"]); await capture(history, ["201", "202"]);
  await stageXLeadQueue(root, [{ directory: live, lane: "live" }, { directory: history, lane: "history" }], at);
  await atomic(join(root, "x-lead-acquisitions", "2026-10-17.json"), [{ at, ids: ["999"], state: "completed", unavailable: ["999"] }]);
  const old = await acquireXLeadQueue(root, { enabled: true, bearer: "fixture", lane: "history", maxPosts: 2, now: at, lookup: unavailable });
  const fresh = await acquireXLeadQueue(root, { enabled: true, bearer: "fixture", maxPosts: 2, now: at, lookup: unavailable });
  assert.equal(old.unavailable, 2); assert.equal(fresh.unavailable, 1);
  const sameDay = await acquireXLeadQueue(root, { enabled: true, bearer: "fixture", maxPosts: 2, now: at,
    lookup: async () => { throw new Error("Must not exceed the live allowance"); } });
  assert.equal(sameDay.status, "daily-limit");
}));

test("budget-rejected requests remain queued and dry-run sends no lookup", async () => fixture(async root => {
  const directory = join(root, "source"); await capture(directory, ["101"]);
  await stageXLeadQueue(root, [{ directory, lane: "history" }], at);
  const options = { enabled: true, bearer: "fixture", lane: "history" as const, maxPosts: 1, now: at };
  const blocked = await acquireXLeadQueue(root, { ...options, lookup: async () => { throw new XBudgetExceeded("cap"); } });
  assert.equal(blocked.status, "budget-limit");
  assert.equal((await acquireXLeadQueue(root, { ...options, enabled: false, lookup: async () => { throw new Error("No dry-run HTTP"); } })).status, "dry-run");
  const resumed = await acquireXLeadQueue(root, { ...options, now: next, lookup: unavailable });
  assert.equal(resumed.unavailable, 1);
}));

test("conflicting source identity fails staging atomically, without replacing existing evidence", async () => fixture(async root => {
  const first = join(root, "first"), conflict = join(root, "conflict");
  await capture(first, ["101"]); await capture(conflict, ["101"], "99");
  await stageXLeadQueue(root, [{ directory: first, lane: "live" }], at);
  const before = await json(join(root, "x-lead-queue.json"), null);
  await assert.rejects(stageXLeadQueue(root, [{ directory: conflict, lane: "history" }], next), /identity changed/);
  assert.deepEqual(await json(join(root, "x-lead-queue.json"), null), before);
}));
