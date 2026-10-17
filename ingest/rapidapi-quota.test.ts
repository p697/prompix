import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { XSpendBudget, XBudgetExceeded } from "./x-spend.ts";
import { rapidAPICycleMonths, rapidAPIRequestRunway, type RapidAPICycleTerms } from "./rapidapi-quota.ts";
import { RapidAPIPilotClient } from "./rapidapi-pilot.ts";
import { atomic, json } from "./publication.ts";

async function fixture(run: (f: {
  root: string; budget: XSpendBudget; terms: RapidAPICycleTerms; setTime: (at: string) => void;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "prompix-rapidapi-quota-"));
  let date = new Date("2026-10-17T13:00:00Z");
  const budget = new XSpendBudget(root, 20, 20, () => date);
  const fee = await budget.reserve("rapidapi", "subscription", "synthetic-receipt", 1);
  await budget.confirmRapidAPIPilotFee(fee.id);
  const terms: RapidAPICycleTerms = { provider: "twitter241", feeReservationID: fee.id, feeMonth: "2026-10",
    startsAt: "2026-10-17T13:00:00Z", endsAt: "2026-11-17T13:00:00Z", stopAt: "2026-11-16T13:00:00Z", requestLimit: 1000 };
  try { await run({ root, budget, terms, setTime: at => { date = new Date(at); } }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("production cycle requires explicit receipt configuration and never sends a request itself", () => fixture(async ({ root, budget, terms }) => {
  await assert.rejects(budget.reserveRapidAPICycleLookup("first"), /not configured/);
  const before = await readFile(join(root, "2026-10.json"));
  assert.deepEqual(await budget.reconcileRapidAPICycle(terms, 0), { used: 0, remaining: 1000 });
  assert.ok(before.equals(await readFile(join(root, "2026-10.json"))));
  await (await budget.reserveRapidAPICycleLookup("first")).finish(1);
  const ledger = await json<any>(join(root, "2026-10.json"), null);
  assert.deepEqual(ledger.entries.map((e: any) => [e.provider, e.operation, e.accounted]),
    [["rapidapi", "subscription", 1_000_000], ["rapidapi", "lookup", 0]]);
}));

test("trial and uncertain attempts remain charged across UTC months, restarts and late settlement", () => fixture(async ({ root, budget, terms, setTime }) => {
  const pending = await budget.reserve("rapidapi", "lookup", "trial-pending", 1);
  await (await budget.reserve("rapidapi", "lookup", "trial-uncertain", 1)).finish();
  await (await budget.reserve("rapidapi", "lookup", "trial-complete", 1)).finish(1);
  assert.deepEqual(await budget.reconcileRapidAPICycle(terms, 1), { used: 3, remaining: 997 });
  setTime("2026-11-01T00:00:00Z");
  const resumed = new XSpendBudget(root, 20, 20, () => new Date("2026-11-01T00:00:00Z"));
  await resumed.reserveRapidAPICycleLookup("november");
  await pending.finish(1);
  assert.deepEqual(await resumed.reconcileRapidAPICycle(terms, 2), { used: 4, remaining: 996 });
  assert.equal((await json<any>(join(root, "2026-10.json"), null)).entries[2].state, "uncertain");
  assert.equal((await json<any>(join(root, "2026-11.json"), null)).entries.length, 1);
  await assert.rejects(budget.reserve("rapidapi", "lookup", "pilot-does-not-renew", 1), /confirmed fee/);
}));

test("dashboard high-water reconciliation accounts for external calls without refunding failures", () => fixture(async ({ budget, terms }) => {
  assert.deepEqual(await budget.reconcileRapidAPICycle(terms, 996), { used: 996, remaining: 4 });
  const attempt = await budget.reserveRapidAPICycleLookup("network-timeout"); await attempt.finish();
  assert.deepEqual(await budget.reconcileRapidAPICycle(terms, 5), { used: 997, remaining: 3 });
  assert.deepEqual(await budget.reconcileRapidAPICycle(terms, 999), { used: 999, remaining: 1 });
  await budget.reserveRapidAPICycleLookup("crash-after-reservation");
  await assert.rejects(budget.reserveRapidAPICycleLookup("overage"), /quota exhausted/);
  assert.deepEqual(await budget.reconcileRapidAPICycle(terms, 998), { used: 1000, remaining: 0 });
}));

test("parallel callers cannot consume the same last credit and refusal leaves cash unchanged", () => fixture(async ({ root, budget, terms }) => {
  await budget.reconcileRapidAPICycle(terms, 999);
  const attempts = await Promise.allSettled([budget.reserveRapidAPICycleLookup("a"), budget.reserveRapidAPICycleLookup("b")]);
  assert.equal(attempts.filter(x => x.status === "fulfilled").length, 1);
  const before = await readFile(join(root, "2026-10.json"));
  await assert.rejects(budget.reserveRapidAPICycleLookup("c"), XBudgetExceeded);
  assert.ok(before.equals(await readFile(join(root, "2026-10.json"))));
}));

test("trial client also honors reconciled external usage without bypassing its eight-call ceiling", () => fixture(async ({ budget, terms }) => {
  await budget.reconcileRapidAPICycle(terms, 1000);
  let calls = 0;
  const client = new RapidAPIPilotClient("test-key", budget, (async () => { calls++; return Response.json({}); }) as typeof fetch);
  await assert.rejects(client.lookup(["1"], async () => {}), /quota exhausted/);
  assert.equal(calls, 0);
}));

test("authorized end is exclusive and immutable; no cycle renewal, extension or clock rollback", () => fixture(async ({ root, budget, terms, setTime }) => {
  await budget.reconcileRapidAPICycle(terms, 4);
  for (const changed of [{ ...terms, stopAt: terms.endsAt }, { ...terms, startsAt: "2026-10-17T12:59:00Z" }])
    await assert.rejects(budget.reconcileRapidAPICycle(changed, 0), /immutable/);
  setTime("2026-10-17T12:59:59Z");
  await assert.rejects(budget.reserveRapidAPICycleLookup("future"), /inactive/);
  setTime("2026-10-18T01:00:00Z"); await budget.reconcileRapidAPICycle(terms, 4);
  setTime("2026-10-18T00:00:00Z");
  await assert.rejects(budget.reserveRapidAPICycleLookup("clock-rollback"), /backwards/);
  setTime(terms.stopAt);
  await assert.rejects(budget.reserveRapidAPICycleLookup("expired"), /inactive/);
  await assert.rejects(budget.reconcileRapidAPICycle(terms, 0), /active authorized/);
  assert.equal((await json<any>(join(root, "2026-10.json"), null)).entries.length, 1);
}));

test("malformed terms, missing payment, broken ledgers and disappearing attempts fail closed", () => fixture(async ({ root, budget, terms }) => {
  for (const changed of [{ ...terms, requestLimit: 1001 }, { ...terms, endsAt: "2027-01-01T00:00:00Z" },
    { ...terms, stopAt: "2026-12-01T00:00:00Z" }, { ...terms, feeMonth: "2026-09" }])
    await assert.rejects(budget.reconcileRapidAPICycle(changed as any, 0));
  const path = join(root, "2026-10.json"), ledger = await json<any>(path, null);
  ledger.entries[0].state = "uncertain"; await atomic(path, ledger);
  await assert.rejects(budget.reconcileRapidAPICycle(terms, 0), /confirmed fee/);
  ledger.entries[0].state = "completed"; await atomic(path, ledger);
  await budget.reserve("rapidapi", "lookup", "trial", 1);
  await budget.reconcileRapidAPICycle(terms, 1);
  await atomic(path, ledger); // Operator deletion cannot restore anchored credits.
  await assert.rejects(budget.reserveRapidAPICycleLookup("missing"), /disappeared/);
  await writeFile(path, "{broken");
  await assert.rejects(budget.reserveRapidAPICycleLookup("corrupt"));
}));

test("growth preserves two-scan batch headroom while maintenance can use remaining credits", () => fixture(async ({ root, budget, terms }) => {
  // 31 inclusive UTC days through November16; 256 originals need 124 calls.
  assert.equal(rapidAPIRequestRunway(256, terms.stopAt, new Date(terms.startsAt)), 124);
  await budget.reconcileRapidAPICycle(terms, 875);
  await assert.rejects(budget.reserveRapidAPICycleLookup("no-census", "growth"), /census/);
  const census = { version: 1, checkedAt: terms.startsAt, complete: true, standalone: 256,
    officialPosts: 10, sourceSetSHA256: "a".repeat(64) };
  await atomic(join(root, "maintenance-reserve.json"), census);
  await budget.reserveRapidAPICycleLookup("one-spare", "growth");
  await assert.rejects(budget.reserveRapidAPICycleLookup("eat-reserve", "growth"), /runway/);
  await budget.reserveRapidAPICycleLookup("published-source");
  assert.equal((await budget.reconcileRapidAPICycle(terms, 0)).remaining, 123);
  await atomic(join(root, "maintenance-reserve.json"), { ...census, complete: false });
  await assert.rejects(budget.reserveRapidAPICycleLookup("incomplete", "growth"), /census/);
}));

test("included requests cannot bypass the shared cash cap or renew a receipt in another month", () => fixture(async ({ root, budget, terms, setTime }) => {
  await budget.reconcileRapidAPICycle(terms, 0);
  const ledger = await json<any>(join(root, "2026-10.json"), null); ledger.opening = 19_000_001;
  await atomic(join(root, "2026-10.json"), ledger);
  await assert.rejects(budget.reserveRapidAPICycleLookup("over-cap"), /dollar budget/);
  setTime("2026-12-01T00:00:00Z");
  await assert.rejects(budget.reconcileRapidAPICycle({ ...terms, startsAt: "2026-12-01T00:00:00Z",
    endsAt: "2027-01-01T00:00:00Z", stopAt: "2026-12-31T00:00:00Z" }, 0), /confirmed fee/);
}));

test("receipt reservation time includes earlier trial attempts and month enumeration is bounded", () => fixture(async ({ budget, terms, setTime }) => {
  await budget.reserve("rapidapi", "lookup", "trial-before-receipt-confirmation", 1);
  setTime("2026-10-17T14:00:00Z");
  assert.equal((await budget.reconcileRapidAPICycle({ ...terms, startsAt: "2026-10-17T14:00:00Z" }, 0)).used, 1);
  assert.deepEqual(rapidAPICycleMonths({ ...terms, startsAt: "2026-10-31T13:00:00Z", endsAt: "2026-12-01T13:00:00Z" }),
    ["2026-10", "2026-11", "2026-12"]);
}));

test("a broken candidate cycle does not block the unchanged official or TwitterAPI.io maintenance route", () => fixture(async ({ root, budget, terms }) => {
  await budget.reconcileRapidAPICycle(terms, 4);
  await writeFile(join(root, "rapidapi-cycle.json"), "{broken");
  await assert.rejects(budget.reserveRapidAPICycleLookup("candidate"));
  await (await budget.reserve("twitterapi", "lookup", "existing-route", 1, "maintenance")).finish(1);
  await (await budget.reserve("official", "lookup", "official-fallback", 1, "maintenance")).finish();
  const entries = (await json<any>(join(root, "2026-10.json"), null)).entries;
  assert.equal(entries.at(-1).accounted, 5000); assert.equal(entries.at(-1).state, "uncertain");
  assert.equal(entries.at(-2).accounted, 150);
}));

test("stale and future census cannot grant growth credits; response failures cannot refund quota", () => fixture(async ({ root, budget, terms }) => {
  await budget.reconcileRapidAPICycle(terms, 0);
  for (const checkedAt of ["2026-10-16T13:00:00Z", "2026-10-17T13:00:01Z"]) {
    await atomic(join(root, "maintenance-reserve.json"), { version: 1, checkedAt, complete: true,
      standalone: 1, officialPosts: 0, sourceSetSHA256: "b".repeat(64) });
    await assert.rejects(budget.reserveRapidAPICycleLookup("stale", "growth"), /census/);
  }
  const failed = await budget.reserveRapidAPICycleLookup("response-unreadable"); await failed.finish();
  await assert.rejects(failed.finish(0), /settled/);
  assert.equal((await budget.reconcileRapidAPICycle(terms, 0)).used, 1);
}));


test("future-dated payment cannot fund a current cycle", () => fixture(async ({ root, budget, terms }) => {
  const path = join(root, "2026-10.json"), ledger = await json<any>(path, null);
  ledger.entries[0].at = "2026-10-18T13:00:00Z";
  await atomic(path, ledger);
  await assert.rejects(budget.reconcileRapidAPICycle(terms, 0), /confirmed fee/);
  assert.equal(await json(join(root, "rapidapi-cycle.json"), null), null);
}));
