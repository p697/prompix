import test from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "../services/feed/test-database.ts";
import { VerifiedCapacityRejection } from "./provider-capacity.ts";
import { StageQueue, workStage } from "./stage-queue.ts";

test("private durable stages retain dependency, identity, leases, global bound and failed attempts", async () => {
  const { pg, writer, reader } = await createTestDatabase();
  try {
    const queue = new StageQueue(writer);
    const first = { id: "one", run: "test", stage: "collect" as const, payload: { revision: "v1" } };
    await queue.enqueue(first); await queue.enqueue(first);
    await assert.rejects(queue.enqueue({ ...first, payload: { revision: "v2" } }), /identity conflict/);
    await queue.enqueue({ id: "two", run: "test", stage: "translate", payload: {}, dependency: "one" });
    assert.equal(await queue.claim("test", ["translate"]), undefined);
    const one = (await queue.claim("test", ["collect"]))!;
    assert.equal(await queue.claim("test", ["collect"]), undefined);
    await queue.finish(one, "succeeded", { passed: true });
    await assert.rejects(queue.finish(one, "succeeded", {}), /lease lost/);
    const two = (await queue.claim("test", ["translate"]))!;
    await queue.enqueue({ id: "three", run: "other", stage: "semantic", payload: {} });
    await queue.enqueue({ id: "four", run: "other", stage: "semantic", payload: {} });
    await queue.enqueue({ id: "five", run: "other", stage: "semantic", payload: {} });
    const three = (await queue.claim("other", ["semantic"]))!;
    const four = (await queue.claim("other", ["semantic"]))!;
    assert.equal(await queue.claim("other", ["semantic"]), undefined, "cap spans independent runs");
    await pg.query("update prompix.queue_jobs set lease_until=now()-interval '1 second' where id='two'");
    assert.ok(await queue.claim("other", ["semantic"]));
    await assert.rejects(queue.finish(two, "succeeded", {}), /lease lost/);
    assert.equal((await pg.query<{ state: string }>("select state from prompix.queue_jobs where id='two'")).rows[0].state, "reconcile");
    assert.equal((await pg.query<{ outcome: string }>("select outcome from prompix.queue_attempts where job_id='two'")).rows[0].outcome, "reconcile");
    assert.equal(await queue.claim("test", ["translate"]), undefined, "ambiguous charged operation cannot be repeated");
    await queue.finish(three, "retry", { knownSafe: true });
    await queue.finish(four, "rejected", { quality: "failed" });
    assert.equal(await queue.claim("other", ["semantic"]), undefined, "retry uses backoff");
    await assert.rejects(reader.query("select * from prompix.queue_jobs"), /permission denied/);
    await assert.rejects(reader.query("select * from prompix.queue_attempts"), /permission denied/);
    await assert.rejects(reader.query("select * from prompix.queue_controls"), /permission denied/);
  } finally { await pg.close(); }
});

test("retries stop at bound and never discard prior attempt rows", async () => {
  const { pg, writer } = await createTestDatabase();
  try {
    const queue = new StageQueue(writer);
    await queue.enqueue({ id: "bounded", run: "bound", stage: "review", payload: {}, maxAttempts: 2 });
    await queue.finish((await queue.claim("bound", ["review"]))!, "retry", { preflightOnly: true });
    await pg.query("update prompix.queue_jobs set available_at=now() where id='bounded'");
    await queue.finish((await queue.claim("bound", ["review"]))!, "retry", { preflightOnly: true });
    assert.equal(await queue.claim("bound", ["review"]), undefined);
    assert.equal((await pg.query<{ state: string }>("select state from prompix.queue_jobs")).rows[0].state, "rejected");
    assert.equal((await pg.query<{ n: number }>("select count(*)::int as n from prompix.queue_attempts")).rows[0].n, 2);
  } finally { await pg.close(); }
});


test("verified semantic capacity retries preserve attempts, back off and reconcile at the bound", async () => {
  const { pg, writer } = await createTestDatabase();
  try {
    const queue = new StageQueue(writer);
    const message = "Selected model is at capacity. Please try a different model.";
    const raw = [{ type: "thread.started" }, { type: "turn.started" }, { type: "error", message }, { type: "turn.failed", error: { message } }].map(e => JSON.stringify(e)).join("\n");
    const handler = async () => { throw new VerifiedCapacityRejection(raw); };
    await queue.enqueue({ id: "capacity", run: "capacity", stage: "semantic", payload: {} });
    for (let attempt = 1; attempt <= 2; attempt++) {
      assert.equal(await workStage(queue, "capacity", ["semantic"], handler), true);
      assert.equal(await queue.claim("capacity", ["semantic"]), undefined);
      await pg.query("update prompix.queue_jobs set available_at=now() where id='capacity'");
    }
    await assert.rejects(workStage(queue, "capacity", ["semantic"], handler), VerifiedCapacityRejection);
    const outcomes = (await pg.query<{ outcome: string }>("select outcome from prompix.queue_attempts where job_id='capacity' order by attempt")).rows.map(r => r.outcome);
    assert.deepEqual(outcomes, ["retry", "retry", "reconcile"]);
    assert.equal(await queue.claim("capacity", ["semantic"]), undefined);
    await queue.enqueue({ id: "unknown", run: "unknown", stage: "semantic", payload: {} });
    await assert.rejects(workStage(queue, "unknown", ["semantic"], async () => { throw new Error("timeout"); }), /timeout/);
    assert.equal(await queue.claim("unknown", ["semantic"]), undefined);
    await queue.enqueue({ id: "one", run: "one", stage: "semantic", payload: {}, maxAttempts: 1 });
    await assert.rejects(workStage(queue, "one", ["semantic"], handler), VerifiedCapacityRejection);
  } finally { await pg.close(); }
});

test("lost completion acknowledgement confirms exact committed result without another handler call", async () => {
  const { pg, writer } = await createTestDatabase();
  try {
    let transactions = 0, calls = 0;
    const queue = new StageQueue({ query: (sql, params) => writer.query(sql, params), transaction: async op => {
      const result = await writer.transaction(op); if (++transactions === 2) throw new Error("Query read timeout"); return result;
    } });
    await queue.enqueue({ id: "ack", run: "ack", stage: "semantic", payload: {} });
    assert.equal(await workStage(queue, "ack", ["semantic"], async () => { calls++; return { pass: 4, readySHA: "retained" }; }), true);
    assert.equal(calls, 1); assert.equal(transactions, 2);
    assert.equal((await pg.query<{ state: string; attempts: number }>("select state,attempts from prompix.queue_jobs where id='ack'")).rows[0].state, "succeeded");
    assert.equal((await pg.query<{ n: number }>("select count(*)::int n from prompix.queue_attempts where job_id='ack'")).rows[0].n, 1);
  } finally { await pg.close(); }
});

test("uncommitted completion stays reconciled and cannot replay its provider", async () => {
  const { pg, writer } = await createTestDatabase();
  try {
    let transactions = 0, calls = 0;
    const queue = new StageQueue({ query: (sql, params) => writer.query(sql, params), transaction: async op => {
      if (++transactions === 2) throw new Error("Query read timeout"); return writer.transaction(op);
    } });
    await queue.enqueue({ id: "unknown", run: "unknown", stage: "semantic", payload: {} });
    await assert.rejects(workStage(queue, "unknown", ["semantic"], async () => { calls++; return { pass: 4 }; }), /Query read timeout/);
    assert.equal(calls, 1); assert.equal((await pg.query<{ state: string }>("select state from prompix.queue_jobs where id='unknown'")).rows[0].state, "reconcile");
    assert.equal(await queue.claim("unknown", ["semantic"]), undefined);
  } finally { await pg.close(); }
});

test("success readback rejects a different result or attempt token", async () => {
  const { pg, writer } = await createTestDatabase();
  try {
    const queue = new StageQueue(writer); await queue.enqueue({ id: "match", run: "match", stage: "semantic", payload: {} });
    const job = (await queue.claim("match", ["semantic"]))!; await queue.finish(job, "succeeded", { pass: 4 });
    assert.equal(await queue.confirmsSuccess(job, { pass: 3 }), false);
    assert.equal(await queue.confirmsSuccess({ ...job, lease_token: "00000000-0000-0000-0000-000000000000" }, { pass: 4 }), false);
    assert.equal(await queue.confirmsSuccess(job, { pass: 4 }), true);
  } finally { await pg.close(); }
});

test("transient renewal error needs a fresh valid lease before completion", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { pg, writer } = await createTestDatabase();
  try {
    const queue = new StageQueue(writer); await queue.enqueue({ id: "renew", run: "renew", stage: "semantic", payload: {} });
    const original = queue.renew.bind(queue); let renewals = 0;
    queue.renew = async job => { if (++renewals === 1) throw new Error("Query read timeout"); return original(job); };
    assert.equal(await workStage(queue, "renew", ["semantic"], async () => { t.mock.timers.tick(60000); await new Promise<void>(r => setImmediate(r)); return { pass: 4 }; }), true);
    assert.equal(renewals, 2);
  } finally { t.mock.timers.reset(); await pg.close(); }
});

test("a genuinely lost lease cannot be revived after a renewal error", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { pg, writer } = await createTestDatabase();
  try {
    const queue = new StageQueue(writer); await queue.enqueue({ id: "expired", run: "expired", stage: "semantic", payload: {} });
    const original = queue.renew.bind(queue); let renewals = 0;
    queue.renew = async job => { if (++renewals === 1) throw new Error("Query read timeout"); return original(job); };
    await assert.rejects(workStage(queue, "expired", ["semantic"], async () => {
      t.mock.timers.tick(60000); await new Promise<void>(r => setImmediate(r));
      await pg.query("update prompix.queue_jobs set lease_until=now()-interval '1 second' where id='expired'");
      return { pass: 4 };
    }), /Queue lease lost/);
    assert.equal(renewals, 2);
    assert.equal(await queue.claim("expired", ["semantic"]), undefined);
    assert.equal((await pg.query<{ state: string }>("select state from prompix.queue_jobs where id='expired'")).rows[0].state, "reconcile");
  } finally { t.mock.timers.reset(); await pg.close(); }
});

import { confirmedTransaction } from "../services/feed/postgres.ts";
import type { TransactionalDatabase } from "../services/feed/database.ts";
async function loseCommitResponse<T>(value: T): Promise<T> {
  return confirmedTransaction({ query: async sql => {
    if (sql === "commit") throw new Error("Query read timeout");
    return { rows: [] };
  } }, async () => value);
}

test("lost claim COMMIT response reads the exact reservation and invokes handler once", async () => {
  const { pg, writer } = await createTestDatabase();
  try {
    const ordinary = new StageQueue(writer);
    await ordinary.enqueue({ id: "committed", run: "claim-proof", stage: "collect", payload: {} });
    let first = true, calls = 0;
    const db: TransactionalDatabase = { ...writer, transaction: async op => {
      const result = await writer.transaction(op);
      if (first) { first = false; return loseCommitResponse(result); }
      return result;
    } };
    const queue = new StageQueue(db);
    assert.equal(await workStage(queue, "claim-proof", ["collect"], async () => { calls++; return { accepted: true }; }), true);
    assert.equal(calls, 1);
    const jobs = (await writer.query("select state,attempts from prompix.queue_jobs where id='committed'")).rows;
    assert.deepEqual(jobs, [{ state: "succeeded", attempts: 1 }]);
  } finally { await pg.close(); }
});

test("an uncommitted claim returns idle only after the control lock barrier", async () => {
  const { pg, writer } = await createTestDatabase();
  try {
    let first = true;
    const db: TransactionalDatabase = { ...writer, transaction: async op => {
      if (first) { first = false; return loseCommitResponse(undefined as any); }
      return writer.transaction(op);
    } };
    const queue = new StageQueue(db);
    await queue.enqueue({ id: "unclaimed", run: "claim-empty", stage: "collect", payload: {} });
    assert.equal(await queue.claim("claim-empty", ["collect"]), undefined);
    assert.equal((await writer.query("select attempts from prompix.queue_jobs where id='unclaimed'")).rows[0].attempts, 0);
    assert.equal((await queue.claim("claim-empty", ["collect"]))?.id, "unclaimed");
  } finally { await pg.close(); }
});

test("a lost claim response never runs an expired reservation", async () => {
  const { pg, writer } = await createTestDatabase();
  try {
    await new StageQueue(writer).enqueue({ id: "expired", run: "claim-expired", stage: "collect", payload: {} });
    let first = true, calls = 0;
    const db: TransactionalDatabase = { ...writer, transaction: async op => {
      const result = await writer.transaction(op);
      if (first) {
        first = false;
        await writer.query("update prompix.queue_jobs set lease_until=now()-interval '1 second' where id='expired'");
        return loseCommitResponse(result);
      }
      return result;
    } };
    await assert.rejects(workStage(new StageQueue(db), "claim-expired", ["collect"], async () => { calls++; return {}; }), /no longer exclusively owned/);
    assert.equal(calls, 0);
  } finally { await pg.close(); }
});
