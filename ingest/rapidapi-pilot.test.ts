import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { XSpendBudget, XBudgetExceeded } from "./x-spend.ts";
import { RapidAPIPilotClient, inspectRapidAPILookup } from "./rapidapi-pilot.ts";
import { atomic, json } from "./publication.ts";
const now = () => new Date("2026-10-17T13:00:00Z");
const body = (ids: readonly string[]) => ({ result: { tweetResult: ids.map(rest_id => ({ result: { __typename: "Tweet", rest_id } })) } });
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "prompix-rapidapi-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function paid(root: string) {
  const budget = new XSpendBudget(root, 20, 20, now);
  const fee = await budget.reserve("rapidapi", "subscription", "synthetic-first-month", 1);
  await budget.confirmRapidAPIPilotFee(fee.id);
  return budget;
}

test("the whole fixed fee shares the existing cap and protects maintenance runway", () => fixture(async root => {
  await atomic(join(root, "2026-10.json"), { version: 1, month: "2026-10", opening: 19_000_001, entries: [] });
  const budget = new XSpendBudget(root, 20, 20, now);
  await assert.rejects(budget.reserve("rapidapi", "subscription", "fee", 1), XBudgetExceeded);
  await atomic(join(root, "2026-10.json"), { version: 1, month: "2026-10", opening: 18_600_000, entries: [] });
  await atomic(join(root, "maintenance-reserve.json"), { version: 1, checkedAt: now().toISOString(), complete: true,
    standalone: 100, officialPosts: 0, sourceSetSHA256: "a".repeat(64) });
  await assert.rejects(new XSpendBudget(root, 20, 20, now, true).reserve("rapidapi", "subscription", "fee", 1), /runway/);
  assert.equal((await json<any>(join(root, "2026-10.json"), null)).entries.length, 0);
}));

test("unconfirmed fee blocks HTTP; confirmation is idempotent without double billing", () => fixture(async root => {
  const budget = new XSpendBudget(root, 20, 20, now); let calls = 0;
  const client = new RapidAPIPilotClient("test-secret", budget, (async () => { calls++; return Response.json(body(["1"])); }) as typeof fetch);
  await assert.rejects(client.lookup(["1"], async () => {}), /confirmed fee/);
  const fee = await budget.reserve("rapidapi", "subscription", "fee", 1);
  assert.equal((await budget.reserve("rapidapi", "subscription", "fee", 1)).id, fee.id);
  await assert.rejects(client.lookup(["1"], async () => {}), /confirmed fee/);
  assert.equal(calls, 0);
  await budget.confirmRapidAPIPilotFee(fee.id); await budget.confirmRapidAPIPilotFee(fee.id);
  await assert.rejects(budget.reserve("rapidapi", "subscription", "different-request-cannot-renew", 1), /already reserved/);
  await client.lookup(["1"], async () => {});
  const ledger = await json<any>(join(root, "2026-10.json"), null);
  assert.deepEqual(ledger.entries.map((e: any) => [e.operation, e.accounted]), [["subscription", 1_000_000], ["lookup", 0]]);
  assert.equal(JSON.stringify(ledger).includes("test-secret"), false);
}));

test("restart, unknown outcomes and midnight do not reset the eight-request pilot", () => fixture(async root => {
  await paid(root);
  for (let i = 0; i < 8; i++) {
    const budget = new XSpendBudget(root, 20, 20, () => new Date("2026-10-18T01:00:00Z"));
    const attempt = await budget.reserve("rapidapi", "lookup", `call-${i}`, 1);
    if (i % 2) await attempt.finish();
  }
  await assert.rejects(new XSpendBudget(root, 20, 20, now).reserve("rapidapi", "lookup", "ninth", 1), /exhausted/);
  const ledger = await json<any>(join(root, "2026-10.json"), null);
  assert.equal(ledger.entries.length, 9); assert.equal(ledger.entries.filter((e: any) => e.state !== "completed").length, 8);
}));

test("expired trials, new UTC months and unsupported operations fail closed", () => fixture(async root => {
  const budget = await paid(root);
  for (const date of ["2026-10-17T12:59:59Z", "2026-10-20T13:00:00Z", "2026-11-01T00:00:00Z"])
    await assert.rejects(new XSpendBudget(root, 20, 20, () => new Date(date)).reserve("rapidapi", "lookup", "late", 1), /confirmed fee/);
  await assert.rejects(budget.reserve("rapidapi", "lookup", "over", 200), /one fixed fee/);
  await assert.rejects(budget.reserve("rapidapi", "search", "unsupported", 1), /one fixed fee/);
  await assert.rejects(budget.reserve("rapidapi", "lookup", "headroom", 1, "maintenance"), /Only verified/);
  await assert.rejects(budget.reserve("official", "subscription", "wrong", 1), /fixed fee/);
}));

test("200 IDs use one included request, capture raw evidence and never approve fidelity", () => fixture(async root => {
  const budget = await paid(root), ids = Array.from({ length: 200 }, (_, i) => String(i + 1));
  let captured: any;
  const client = new RapidAPIPilotClient("test-secret", budget, (async (url, options) => {
    assert.equal(new URL(String(url)).hostname, "twitter241.p.rapidapi.com");
    assert.equal(new URL(String(url)).searchParams.get("tweetIds"), ids.join(","));
    assert.equal(new Headers(options?.headers).get("x-rapidapi-host"), "twitter241.p.rapidapi.com");
    assert.equal(options?.redirect, "manual");
    assert.equal((await json<any>(join(root, "2026-10.json"), null)).entries.at(-1).state, "reserved");
    return Response.json(body(ids), { headers: { "x-ratelimit-requests-remaining": "999" } });
  }) as typeof fetch);
  const result = await client.lookup(ids, async evidence => { captured = evidence; });
  assert.deepEqual(JSON.parse(captured.body), body(ids)); assert.equal(captured.quota["x-ratelimit-requests-remaining"], "999");
  assert.equal(result.inspection.returnedIDs.length, 200); assert.equal(result.inspection.sourceFidelityVerified, false);
  assert.equal(result.inspection.productionSwitchAllowed, false);
}));

test("failures stay counted, capture precedes parsing, credentials do not enter errors, no retries", () => fixture(async root => {
  for (const failure of [302, 401, 429, 500, "transport", "json", "identity", "capture"] as const) {
    const dir = join(root, String(failure)), budget = await paid(dir); let calls = 0, captured: any;
    const client = new RapidAPIPilotClient("test-secret", budget, (async () => {
      calls++;
      if (failure === "transport") throw new Error("test-secret");
      if (failure === "identity") return Response.json(body(["2"]));
      return new Response("test-secret", { status: typeof failure === "number" ? failure : 200 });
    }) as typeof fetch);
    await assert.rejects(client.lookup(["1"], async value => { captured = value; if (failure === "capture") throw new Error("test-secret"); }),
      e => e instanceof Error && !e.message.includes("test-secret"));
    assert.equal(calls, 1);
    const ledger = await json<any>(join(dir, "2026-10.json"), null);
    assert.equal(ledger.entries[1].state, "uncertain"); assert.equal(ledger.entries[0].accounted, 1_000_000);
    if (failure !== "transport") assert.ok(captured);
  }
}));

test("malformed identities cannot become matched or removed source records", () => fixture(async root => {
  let calls = 0;
  const client = new RapidAPIPilotClient("test-secret", new XSpendBudget(root, 20, 20, now), (async () => { calls++; return Response.json(body([])); }) as typeof fetch);
  for (const ids of [[], ["1", "1"], ["bad"], Array.from({ length: 201 }, (_, i) => String(i + 1))])
    await assert.rejects(client.lookup(ids, async () => {}));
  assert.equal(calls, 0); assert.equal(await json(join(root, "2026-10.json"), null), null);
  for (const raw of [body(["3"]), body(["1", "1"]), { ...body([]), errors: [] }, { result: { tweetResult: [{}] } }])
    assert.throws(() => inspectRapidAPILookup(raw, ["1", "2"]));
  const raw = body(["1"]); raw.result.tweetResult.push({ result: { __typename: "TweetUnavailable", rest_id: "2" } });
  const result = inspectRapidAPILookup(raw, ["1", "2"]);
  assert.deepEqual(result.returnedIDs, ["1"]); assert.deepEqual(result.missingIDs, ["2"]); assert.equal(result.unavailablePlaceholders, 1);
}));
