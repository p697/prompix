import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomic } from "./publication.ts";
import { StageQueue, queueIdentity, workStage } from "./stage-queue.ts";
import { inspectHistoryIsolation, activeHistoryBatches } from "./history-isolation.ts";
import { createTestDatabase } from "../services/feed/test-database.ts";
const run = "isolation", day = "2026-10-19";
const manifest = (batch: string) => ({ version: 1, id: batch, createdAt: day + "T00:00:00Z", leads: [
  { id: "1", authorID: "2", reason: "prompt", kind: "image", visual: true, sourceDate: day + "T00:00:00Z", evidence: "synthetic" }] });
const attempt = { day, requests: 1, model: "gpt-5.6-luna", reservedAt: day + "T00:00:00Z", candidateIDs: ["x-post-1"],
  inputCharacters: 100, state: "failed", error: "Visual provider timed out; daily attempt remains consumed",
  identities: ["a".repeat(64)], attachments: 1, attachmentBytes: 100 };
const row = (batch: string, message = "Historical visual attempt requires inspection") => ({
  id: `${run}:${batch}:review`, stage: "review", attempts: 1, payload: { batch, manifestSHA: queueIdentity(manifest(batch)) }, output: { reason: "handler-failed", message } });
async function fixture(root: string, batch: string) {
  await atomic(join(root, run, batch, "manifest.json"), manifest(batch));
  await atomic(join(root, run, batch, "visual-ledger.json"), { schemaVersion: 2, day, requests: 1, attempts: [attempt] });
}
test("isolated timeout leaves all attempts and blocked children intact while unrelated stages run", async () => {
  const root = await mkdtemp(join(tmpdir(), "isolation-")); const { pg, writer } = await createTestDatabase();
  try {
    const queue = new StageQueue(writer), batch = "batch-0001", id = row(batch).id;
    await fixture(root, batch);
    await queue.enqueue({ id, run, stage: "review", payload: row(batch).payload });
    await queue.enqueue({ id: "child", run, stage: "translate", payload: { batch }, dependency: id });
    await assert.rejects(workStage(queue, run, ["review"], async () => { throw Error(row(batch).output.message); }));
    const attempts = JSON.stringify((await pg.query("select * from prompix.queue_attempts order by job_id,attempt")).rows);
    const ledger = await readFile(join(root, run, batch, "visual-ledger.json"));
    const isolated = await inspectHistoryIsolation(queue, root, run);
    assert.equal(isolated.length, 1); assert.equal(isolated[0].qualified, 0);
    assert.equal(await activeHistoryBatches(queue, run, isolated), 0);
    assert.equal(await queue.claim(run, ["review", "translate"]), undefined);
    await queue.enqueue({ id: "healthy", run, stage: "review", payload: { batch: "batch-0002" } });
    assert.equal(await activeHistoryBatches(queue, run, isolated), 1);
    assert.equal(await workStage(queue, run, ["review"], async () => ({ passed: true })), true);
    const beforeRestart = await readFile(join(root, "isolated-reviews", batch + "-1.json"));
    assert.deepEqual(await inspectHistoryIsolation(new StageQueue(writer), root, run), isolated);
    assert.deepEqual(await readFile(join(root, "isolated-reviews", batch + "-1.json")), beforeRestart);
    assert.deepEqual(await readFile(join(root, run, batch, "visual-ledger.json")), ledger);
    assert.equal(JSON.stringify((await pg.query("select * from prompix.queue_attempts where job_id<> 'healthy' order by job_id,attempt")).rows), attempts);
    assert.equal((await pg.query<{ state: string }>("select state from prompix.queue_jobs where id='child'")).rows[0].state, "queued");
  } finally { await pg.close(); await rm(root, { recursive: true, force: true }); }
});
test("isolation refuses malformed identity, captured responses, unknown errors and the persistent circuit bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "isolation-")); let rows: any[] = [row("batch-0001")];
  const queue = new StageQueue({ query: async () => ({ rows }) } as any);
  try {
    await fixture(root, "batch-0001");
    rows = [{ ...row("batch-0001"), stage: "semantic" }]; await assert.rejects(inspectHistoryIsolation(queue, root, run));
    rows = [{ ...row("batch-0001"), output: { reason: "lease-expired" } }]; await assert.rejects(inspectHistoryIsolation(queue, root, run));
    rows = [row("batch-0001")]; rows[0].payload.manifestSHA = "b".repeat(64); await assert.rejects(inspectHistoryIsolation(queue, root, run), /manifest changed/);
    rows = [row("batch-0001")];
    await atomic(join(root, run, "batch-0001", "visual-responses", "1.json"), { text: "partial" });
    await assert.rejects(inspectHistoryIsolation(queue, root, run), /Retained response/);
    await rm(join(root, run, "batch-0001", "visual-responses"), { recursive: true });
    await atomic(join(root, run, "batch-0001", "visual-ledger.json"), { schemaVersion: 2, day, requests: 1, attempts: [{ ...attempt, error: "Quota exceeded" }] });
    await assert.rejects(inspectHistoryIsolation(queue, root, run), /Unclassified visual/);
    rows = Array.from({ length: 5 }, (_, i) => row(`batch-${String(i + 1).padStart(4, "0")}`));
    await assert.rejects(inspectHistoryIsolation(queue, root, run), /circuit open/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("editorial isolation requires complete pre-output capacity evidence, never retries or accepts output", async () => {
  const root = await mkdtemp(join(tmpdir(), "isolation-")), batch = "batch-0001";
  const queue = new StageQueue({ query: async () => ({ rows: [row(batch, "Historical editorial attempt requires inspection")] }) } as any);
  try {
    await fixture(root, batch);
    const { identities, attachments, attachmentBytes, ...editorial } = attempt;
    await atomic(join(root, run, batch, "editorial-ledger.json"), { schemaVersion: 2, day, requests: 1, attempts: [{ ...editorial, error: "Editorial provider exited 1" }] });
    const message = "Selected model is at capacity. Please try a different model.";
    const evidence = { model: attempt.model, exitCode: 1, eventsTruncated: false, outputBytes: null, outputText: null,
      events: [{ type: "thread.started" }, { type: "turn.started" }, { type: "error", message }, { type: "turn.failed", error: { message } }].map(e => JSON.stringify(e)).join("\n") };
    const path = join(root, run, batch, "editorial-attempts", "1.json");
    for (const change of [{ eventsTruncated: true }, { outputText: "partial" }, { outputBytes: 0 }, { model: "different" }, { events: "{}" }]) {
      await atomic(path, { ...evidence, ...change }); await assert.rejects(inspectHistoryIsolation(queue, root, run), /not a verified/);
    }
    await atomic(path, evidence);
    const isolated = await inspectHistoryIsolation(queue, root, run);
    assert.equal(isolated[0].replayed, false); assert.equal(isolated[0].reason, "editorial-capacity-before-output");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("operator closes only proven pre-output capacity failures and preserves all original attempts", async () => {
  const { rejectVerifiedCapacityBatch } = await import("./history-isolation.ts");
  const root = await mkdtemp(join(tmpdir(), "disposition-")); const { pg, writer } = await createTestDatabase();
  try {
    const queue = new StageQueue(writer);
    for (let i = 1; i <= 5; i++) {
      const batch = `batch-${String(i).padStart(4, "0")}`, failed = row(batch, i === 5 ? "Historical editorial attempt requires inspection" : undefined);
      await fixture(root, batch);
      await queue.enqueue({ id: failed.id, run, stage: "review", payload: failed.payload });
      await assert.rejects(workStage(queue, run, ["review"], async () => { throw Error(failed.output.message); }));
      await queue.enqueue({ id: `child-${i}`, run, stage: "translate", payload: { batch }, dependency: failed.id });
      await queue.enqueue({ id: `grandchild-${i}`, run, stage: "semantic", payload: { batch }, dependency: `child-${i}` });
    }
    const batch = "batch-0005", directory = join(root, run, batch);
    const { identities, attachments, attachmentBytes, ...editorial } = attempt;
    await atomic(join(directory, "editorial-ledger.json"), { schemaVersion: 2, day, requests: 1, attempts: [{ ...editorial, error: "Editorial provider exited 1" }] });
    const message = "Selected model is at capacity. Please try a different model.";
    const evidence = { model: attempt.model, exitCode: 1, eventsTruncated: false, outputBytes: null, outputText: null,
      events: [{ type: "thread.started" }, { type: "turn.started" }, { type: "error", message }, { type: "turn.failed", error: { message } }].map(e => JSON.stringify(e)).join("\n") };
    const path = join(directory, "editorial-attempts", "1.json");
    await atomic(path, evidence);
    await assert.rejects(inspectHistoryIsolation(queue, root, run), /circuit open/);
    await assert.rejects(rejectVerifiedCapacityBatch(queue, root, run, "batch-0001"), /Unknown provider/);
    await atomic(path, { ...evidence, outputText: "partial" });
    await assert.rejects(rejectVerifiedCapacityBatch(queue, root, run, batch), /not a verified/);
    await atomic(path, evidence);
    await queue.enqueue({ id: "active", run, stage: "collect", payload: {} });
    const active = (await queue.claim(run, ["collect"]))!;
    await assert.rejects(rejectVerifiedCapacityBatch(queue, root, run, batch), /Drain active/);
    await queue.finish(active, "succeeded", {});
    const attempts = JSON.stringify((await pg.query("select * from prompix.queue_attempts order by job_id,attempt")).rows);
    const ledger = await readFile(join(directory, "editorial-ledger.json"));
    const result = await rejectVerifiedCapacityBatch(queue, root, run, batch);
    assert.equal(result.qualified, 0); assert.equal(result.replayed, false);
    assert.deepEqual(await readFile(join(directory, "editorial-ledger.json")), ledger);
    assert.equal(JSON.stringify((await pg.query("select * from prompix.queue_attempts order by job_id,attempt")).rows), attempts);
    assert.equal((await pg.query<{state: string}>("select state from prompix.queue_jobs where id=$1", [row(batch).id])).rows[0].state, "rejected");
    assert.equal(await queue.claim(run, ["review", "translate", "semantic"]), undefined);
    const isolated = await inspectHistoryIsolation(queue, root, run);
    assert.equal(isolated.length, 4);
    assert.equal(await activeHistoryBatches(queue, run, isolated), 0, "rejected batch descendants never hold scheduling capacity");
    await assert.rejects(rejectVerifiedCapacityBatch(queue, root, run, batch), /Only reconciled/);
    await queue.enqueue({ id: "healthy", run, stage: "collect", payload: { batch: "batch-0006" } });
    assert.equal(await activeHistoryBatches(queue, run, isolated), 1);
    assert.ok(await queue.claim(run, ["collect"]));
  } finally { await pg.close(); await rm(root, { recursive: true, force: true }); }
});
