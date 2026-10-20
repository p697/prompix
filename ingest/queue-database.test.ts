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

import { confirmedTransaction } from "../services/feed/postgres.ts";

test("queue reconnects a confirmed rolled-back query without overlapping workers", async () => {
  let connections = 0, active = 0, maximum = 0;
  const waits: number[] = [], committed: string[] = [];
  const queue = queueDatabase(async operation => {
    const attempt = ++connections; active++; maximum = Math.max(maximum, active);
    const pending: string[] = [];
    const db: TransactionalDatabase = { query: async sql => {
      if (sql === "rollback") pending.length = 0;
      else if (sql === "commit") committed.push(...pending);
      else if (sql !== "begin") {
        pending.push(sql);
        if (attempt <= 2) throw new Error("Query read timeout");
      }
      return { rows: [] };
    }, transaction: op => confirmedTransaction(db, op) };
    try { return await operation(db); } finally { active--; }
  }, async ms => { waits.push(ms); });
  await Promise.all([queue.query("insert one"), queue.query("insert two")]);
  assert.deepEqual(committed, ["insert one", "insert two"]);
  assert.deepEqual(waits, [1000, 3000]); assert.equal(maximum, 1); assert.equal(connections, 4);
});

test("queue never replays uncertain commits and stops after bounded rollback retries", async () => {
  for (const mode of ["commit", "rollback", "query", "invalid"]) {
    let connections = 0;
    const queue = queueDatabase(async operation => {
      connections++;
      const db: TransactionalDatabase = { query: async sql => {
        if (sql === mode || (mode === "rollback" && sql === "query")) throw new Error("Query read timeout");
        if (mode === "invalid" && sql === "query") throw new Error("Invalid content");
        return { rows: [] };
      }, transaction: op => confirmedTransaction(db, op) };
      return operation(db);
    }, async () => {});
    await assert.rejects(queue.transaction(tx => tx.query("query")));
    assert.equal(connections, mode === "query" ? 4 : 1);
  }
});
