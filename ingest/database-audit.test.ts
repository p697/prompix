import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createTestDatabase } from "../services/feed/test-database.ts";
import { recordDatabaseRun } from "./database-audit.ts";
import { withDailyStatus } from "./daily-status.ts";

test("run history is private, bounded, idempotent and excludes raw provider diagnostics", async t => {
  const { pg, writer, reader } = await createTestDatabase(); t.after(() => pg.close());
  const run = { runID: randomUUID(), startedAt: "2026-10-14T00:00:00.000Z", state: "running", published: false,
    counts: { prepared: { text: 12, total: 12 }, arbitrary: "private" },
    sources: { x: { status: "error", count: 7, error: "Authorization: private-test-value", url: "https://example.com/?token=private" } },
    error: "postgres://private-test-value" };
  await recordDatabaseRun(writer, run);
  await assert.rejects(reader.query("select * from prompix.ingest_runs"), /permission denied/);
  const complete = { ...run, state: "failed", finishedAt: "2026-10-14T00:01:00.000Z" };
  await recordDatabaseRun(writer, complete);
  await recordDatabaseRun(writer, complete);
  const rows = (await writer.query("select * from prompix.ingest_runs")).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "failed");
  assert.equal(rows[0].failure_code, "run_failed");
  assert.deepEqual(rows[0].counts, { prepared: { text: 12, total: 12 } });
  assert.deepEqual(rows[0].sources, { x: { status: "error", count: 7 } });
  assert.ok(!JSON.stringify(rows).includes("private"));
  await assert.rejects(recordDatabaseRun(writer, run), /state conflict/);
});

test("an unavailable start audit prevents collection; final audit failure cannot leave false success", async () => {
  const reports: Record<string, unknown>[] = [], audit: Record<string, unknown>[] = [];
  let calls = 0, unlocked = 0;
  const io = { lock: async () => async () => { unlocked++; },
    write: async (_: string, value: unknown) => { reports.push(structuredClone(value) as Record<string, unknown>); },
    invalidate: async () => {}, log: () => {} };
  const failure = new Error("Audit offline");
  await assert.rejects(withDailyStatus("/unused", { startedAt: "2026-10-14T00:00:00.000Z", published: false }, async () => { calls++; },
    { ...io, audit: async record => { audit.push(record); throw failure; } }), error => error === failure);
  assert.equal(calls, 0); assert.equal(unlocked, 1);
  assert.equal(reports.at(-1)!.state, "failed");
  await assert.rejects(withDailyStatus("/unused", { startedAt: "2026-10-14T00:00:00.000Z", published: true }, async () => { calls++; },
    { ...io, audit: async record => { if (record.state !== "running") throw failure; } }), error => error === failure);
  assert.equal(calls, 1); assert.equal(unlocked, 2);
  assert.equal(reports.at(-1)!.state, "failed");
  assert.equal(reports.at(-1)!.published, true);
});
