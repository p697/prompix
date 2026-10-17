import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomic, json } from "./publication.ts";
import { XSpendBudget, XBudgetExceeded } from "./x-spend.ts";
const time = () => new Date("2026-10-17T01:00:00Z");
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "prompix-x-spend-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test("reservations survive restart, failures and smaller configured budgets", () => fixture(async root => {
  const budget = new XSpendBudget(root, 20, 0.01, time);
  await budget.reserve("twitterapi", "search", "first", 20);
  const next = new XSpendBudget(root, 20, 0.003, time);
  await assert.rejects(next.reserve("twitterapi", "lookup", "second", 1), XBudgetExceeded);
}));
test("successful reads settle actual returned units including empty minimum charge", () => fixture(async root => {
  const budget = new XSpendBudget(root, 20, 1, time);
  await (await budget.reserve("twitterapi", "search", "empty", 20)).finish(0);
  await (await budget.reserve("twitterapi", "lookup", "found", 10)).finish(2);
  const ledger = await json<any>(join(root, "2026-10.json"), null);
  assert.deepEqual(ledger.entries.map((e: any) => e.accounted), [150, 300]);
  assert.equal(JSON.stringify(ledger).includes("empty"), false);
}));
test("monthly cap includes opening spend and every provider; configuration cannot exceed user ceiling", () => fixture(async root => {
  await atomic(join(root, "2026-10.json"), { version: 1, month: "2026-10", opening: 19_995_000, entries: [] });
  const budget = new XSpendBudget(root, 20, 1, time);
  await (await budget.reserve("official", "lookup", "official", 1)).finish(1);
  await assert.rejects(budget.reserve("twitterapi", "lookup", "third-party", 1), XBudgetExceeded);
  assert.throws(() => new XSpendBudget(root, 21), /Invalid/);
}));
test("ambiguous settlements stay reserved and late completion settles the original month", () => fixture(async root => {
  let date = time();
  const budget = new XSpendBudget(root, 20, 1, () => date);
  const pending = await budget.reserve("twitterapi", "lookup", "first", 10);
  await assert.rejects(pending.finish(11), /bound/);
  date = new Date("2026-11-01T00:00:00Z");
  await pending.finish();
  const ledger = await json<any>(join(root, "2026-10.json"), null);
  assert.equal(ledger.entries[0].accounted, 1500);
  assert.equal(ledger.entries[0].state, "uncertain");
  await assert.rejects(pending.finish(), /settled/);
}));
test("a corrupt ledger blocks paid calls, and concurrent reservations cannot overspend", () => fixture(async root => {
  const budget = new XSpendBudget(root, 20, 0.003, time);
  const results = await Promise.allSettled([budget.reserve("twitterapi", "search", "a", 20), budget.reserve("twitterapi", "search", "b", 20)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const ledger = await json<any>(join(root, "2026-10.json"), null);
  ledger.entries[0].accounted = 0;
  await atomic(join(root, "2026-10.json"), ledger);
  await assert.rejects(budget.reserve("twitterapi", "lookup", "corrupt", 1), /accounting/);
  await atomic(join(root, "2026-10.json"), { version: 1, month: "2026-09", opening: 0, entries: [] });
  await assert.rejects(budget.reserve("twitterapi", "lookup", "c", 1), /month mismatch/);
}));
