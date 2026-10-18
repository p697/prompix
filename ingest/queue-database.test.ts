import { test } from "node:test";
import assert from "node:assert/strict";
import { queueDatabase } from "./queue-database.ts";
import type { TransactionalDatabase } from "../services/feed/database.ts";
import { retryConnection } from "./transient-retry.ts";

test("queue operations release a single connection after failure without replaying transactions", async () => {
  let active = 0, maximum = 0, calls = 0;
  const db: TransactionalDatabase = { query: async () => ({ rows: [] }), transaction: async op => op(db) };
  const queue = queueDatabase(async op => {
    active++; maximum = Math.max(maximum, active); calls++;
    try { await new Promise(resolve => setTimeout(resolve, 2)); return await op(db); }
    finally { active--; }
  });
  let mutations = 0;
  const result = await Promise.allSettled([
    queue.query("one"), queue.transaction(async () => { mutations++; throw new Error("uncertain commit"); }),
    queue.query("two"), queue.query("three"),
  ]);
  assert.equal(maximum, 1); assert.equal(active, 0); assert.equal(calls, 4); assert.equal(mutations, 1);
  assert.deepEqual(result.map(r => r.status), ["fulfilled", "rejected", "fulfilled", "fulfilled"]);
});

test("role connection exhaustion retries only connection establishment", async () => {
  let calls = 0;
  assert.equal(await retryConnection(async () => { if (++calls < 3) throw Object.assign(new Error("role full"), { code: "53300" }); return true; }, async () => {}), true);
  assert.equal(calls, 3);
});
