import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("growth preserves maintenance runway across restarts while maintenance still obeys the shared cap", () => fixture(async root => {
  await atomic(join(root, "maintenance-reserve.json"), { version: 1, checkedAt: time().toISOString(), complete: true,
    standalone: 100, officialPosts: 0, sourceSetSHA256: "a".repeat(64) }); // $0.03/day, $0.45 remaining month.
  await atomic(join(root, "2026-10.json"), { version: 1, month: "2026-10", opening: 19_540_000, entries: [] });
  await (await new XSpendBudget(root, 20, 1, time, true).reserve("official", "lookup", "new-source", 2)).finish(2);
  const budget = new XSpendBudget(root, 20, 1, time, true);
  const before = await json(join(root, "2026-10.json"), null);
  await assert.rejects(budget.reserve("twitterapi", "search", "growth", 1), /runway/);
  assert.deepEqual(await json(join(root, "2026-10.json"), null), before);
  await (await budget.reserve("official", "lookup", "published", 90, "maintenance")).finish(90);
  await assert.rejects(budget.reserve("twitterapi", "lookup", "published", 1, "maintenance"), XBudgetExceeded);
}));

test("daily headroom also applies when the monthly budget has room", () => fixture(async root => {
  await atomic(join(root, "maintenance-reserve.json"), { version: 1, checkedAt: time().toISOString(), complete: true,
    standalone: 100, officialPosts: 0, sourceSetSHA256: "a".repeat(64) });
  const budget = new XSpendBudget(root, 20, 0.033, time, true);
  await (await budget.reserve("twitterapi", "search", "growth", 20)).finish(20);
  await assert.rejects(budget.reserve("twitterapi", "lookup", "draft", 1), /runway/);
  await (await budget.reserve("twitterapi", "lookup", "published", 1, "maintenance")).finish(1);
}));

test("missing, incomplete, corrupt, future and stale census block growth without blocking maintenance", () => fixture(async root => {
  const plan = { version: 1, checkedAt: time().toISOString(), complete: true, standalone: 1, officialPosts: 0, sourceSetSHA256: "a".repeat(64) };
  const budget = new XSpendBudget(root, 20, 1, time, true);
  for (const value of [null, {}, { ...plan, complete: false }, { ...plan, checkedAt: "2026-10-17T01:00:01Z" },
    { ...plan, checkedAt: "2026-10-16T01:00:00Z" }]) {
    await atomic(join(root, "maintenance-reserve.json"), value);
    await assert.rejects(budget.reserve("twitterapi", "search", "growth", 1), XBudgetExceeded);
    await (await budget.reserve("official", "lookup", "protected", 1, "maintenance")).finish(1);
  }
  assert.equal((await json<any>(join(root, "2026-10.json"), null)).entries.length, 5);
}));

test("unverified providers, searches and profiles cannot consume protected headroom", () => fixture(async root => {
  const budget = new XSpendBudget(root, 20, 1, time, true);
  for (const provider of ["official", "twitterapi"] as const) for (const operation of ["search", "users"] as const)
    await assert.rejects(budget.reserve(provider, operation, "request", 1, "maintenance"), /Only verified/);
  await assert.rejects(budget.reserve("tweetapi", "lookup", "pilot", 1, "maintenance"), /Only verified/);
  await assert.rejects(budget.reserve("official", "lookup", "request", 1, "invalid" as any), /Only verified/);
  assert.equal(await json(join(root, "2026-10.json"), null), null);
}));


test("unparseable census is a preflight refusal and never creates a charge", () => fixture(async root => {
  await writeFile(join(root, "maintenance-reserve.json"), "{broken");
  await assert.rejects(new XSpendBudget(root, 20, 1, time, true).reserve("twitterapi", "search", "growth", 1), XBudgetExceeded);
  assert.equal(await json(join(root, "2026-10.json"), null), null);
}));
