import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupX, lookupXUsers, searchX, searchXFeed, xFeedRequest, checkXAvailability } from "./x.ts";
import { configuredXSpendBudget, XBudgetExceeded, XSpendBudget } from "./x-spend.ts";
import { atomic, json } from "./publication.ts";

const post = { id: "101", author_id: "42", text: "Synthetic original source", created_at: "2026-10-17T00:00:00Z" };
const user = { id: "42", username: "fixture", name: "Fixture" };
const payload = { data: [post], includes: { users: [user] }, meta: { result_count: 1, newest_id: "101", oldest_id: "101" } };
async function fixture(t: TestContext, run: (root: string, ledgerPath: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "prompix-official-budget-"));
  const names = ["PROMPIX_X_SPEND_DIR", "PROMPIX_X_MONTHLY_USD", "PROMPIX_X_DAILY_USD"];
  const previous = names.map(name => process.env[name]);
  Object.assign(process.env, { PROMPIX_X_SPEND_DIR: root, PROMPIX_X_MONTHLY_USD: "1", PROMPIX_X_DAILY_USD: "1" });
  try { await run(root, join(root, `${new Date().toISOString().slice(0, 7)}.json`)); }
  finally {
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    t.mock.restoreAll(); await rm(root, { recursive: true, force: true });
  }
}

test("all official read paths reserve the shared ledger before network and charge primary resources only", t => fixture(t, async (root, path) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string, options: RequestInit) => {
    const ledger = await json<any>(path, null);
    assert.equal(ledger.entries.at(-1).state, "reserved");
    assert.equal(ledger.entries.at(-1).provider, "official");
    assert.equal(options.redirect, "manual"); calls++;
    return Response.json(input.includes("/users/") ? { data: [user] } : payload);
  });
  await searchX("fixture-secret");
  await searchXFeed("fixture-secret", xFeedRequest("prompt", { limit: 20 }));
  await lookupX("fixture-secret", ["101"]);
  await checkXAvailability("fixture-secret", ["101"]);
  await lookupXUsers("fixture-secret", ["Fixture", "fixture"]);
  const shared = new XSpendBudget(root, 1, 1);
  await (await shared.reserve("twitterapi", "lookup", "same-account-trial", 1)).finish(1);
  const ledger = await json<any>(path, null);
  assert.equal(calls, 5);
  assert.deepEqual(ledger.entries.map((entry: any) => entry.accounted), [5000, 5000, 5000, 5000, 10000, 150]);
  assert.deepEqual(ledger.entries.map((entry: any) => entry.reserved), [50000, 100000, 5000, 5000, 10000, 150]);
  assert.equal(JSON.stringify(ledger).includes("fixture-secret"), false);
}));

test("opening spend and a shared third-party read block official calls before any request leaves", t => fixture(t, async (root, path) => {
  const month = new Date().toISOString().slice(0, 7);
  await atomic(path, { version: 1, month, opening: 999_850, entries: [] });
  const trial = new XSpendBudget(root, 1, 1);
  await (await trial.reserve("twitterapi", "lookup", "trial", 1)).finish(1);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(payload); });
  for (const action of [() => searchX("secret"), () => lookupX("secret", ["101"]),
    () => checkXAvailability("secret", ["101"]), () => lookupXUsers("secret", ["fixture"])])
    await assert.rejects(action(), XBudgetExceeded);
  assert.equal(calls, 0);
}));

test("HTTP, transport and ambiguous billing failures retain their full official reservation", t => fixture(t, async (_root, path) => {
  const responses = [() => { throw new Error("fixture-secret"); }, () => new Response("unavailable", { status: 500 }),
    () => Response.json({ unexpected: true })];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => responses[calls++]());
  for (const _ of responses) await assert.rejects(lookupX("fixture-secret", ["101"]), error =>
    error instanceof Error && !error.message.includes("fixture-secret"));
  const ledger = await json<any>(path, null);
  assert.equal(calls, 3);
  assert.ok(ledger.entries.every((entry: any) => entry.state === "uncertain" && entry.accounted === 5000));
}));

test("valid empty searches settle zero without assuming same-day deduplication", t => fixture(t, async (_root, path) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => Response.json(++calls === 1 ? { meta: { result_count: 0 } } : payload));
  await searchX("fixture-secret");
  await lookupX("fixture-secret", ["101"]);
  await lookupX("fixture-secret", ["101"]);
  const ledger = await json<any>(path, null);
  assert.deepEqual(ledger.entries.map((entry: any) => entry.accounted), [0, 5000, 5000]);
}));

test("a conservatively accounted error-only response still preserves official withdrawal evidence", t => fixture(t, async (_root, path) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ errors: [
    { resource_id: "101", type: "https://api.x.com/2/problems/resource-not-found" },
  ] }));
  const result = await checkXAvailability("fixture-secret", ["101"]);
  assert.deepEqual(result.unavailable, ["101"]);
  const ledger = await json<any>(path, null);
  assert.equal(ledger.entries[0].state, "uncertain");
  assert.equal(ledger.entries[0].accounted, 5000);
}));

test("production budget configuration must explicitly opt in and cannot exceed the approved ceiling", () => {
  assert.equal(configuredXSpendBudget({}), undefined);
  assert.throws(() => configuredXSpendBudget({ PROMPIX_X_DAILY_USD: "1" }), /Monthly/);
  for (const limit of ["21", "NaN", "0", "-1", ""]) assert.throws(() => configuredXSpendBudget({ PROMPIX_X_MONTHLY_USD: limit }), /Invalid/);
  assert.equal(configuredXSpendBudget({ PROMPIX_X_MONTHLY_USD: "20" })?.monthlyUSD, 20);
});
