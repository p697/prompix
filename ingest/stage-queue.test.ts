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
