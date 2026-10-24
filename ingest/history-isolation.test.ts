import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomic } from "./publication.ts";
import { StageQueue, queueIdentity, workStage } from "./stage-queue.ts";
import { inspectHistoryIsolation, activeHistoryBatches, rejectQuotaAdmissionBatch } from "./history-isolation.ts";
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

test("recovery receipt isolates five unchanged failures, stops on any new failure, and never unlocks their children", async () => {
  const { reserveReviewProbe, completeReviewProbe } = await import("./review-recovery.ts");
  const { inspectReviewFailure } = await import("./history-isolation.ts");
  const { activateCampaignStage } = await import("./campaign-stage.ts");
  const { createHash } = await import("node:crypto");
  const root = await mkdtemp(join(tmpdir(), "recover-five-")), { pg, writer } = await createTestDatabase();
  try {
    const queue = new StageQueue(writer), evidence = join(root, "evidence.json"); await atomic(evidence, {});
    await activateCampaignStage(root, { version: 1, id: "one", run, authorizedAt: new Date().toISOString(), baselineCount: 1, seedReadyAtStart: 0, newReadyAtStart: 0, additionalQualified: 1000,
      evidencePath: evidence, evidenceSHA256: createHash("sha256").update(await readFile(evidence)).digest("hex") });
    const proofs = [];
    for (let i = 1; i <= 5; i++) {
      const batch = `batch-000${i}`; await fixture(root, batch);
      await queue.enqueue({ id: row(batch).id, run, stage: "review", payload: row(batch).payload });
      await assert.rejects(workStage(queue, run, ["review"], async () => { throw Error(row(batch).output.message); }));
      await queue.enqueue({ id: `child-${i}`, run, stage: "translate", payload: {}, dependency: row(batch).id });
      proofs.push(await inspectReviewFailure(root, run, row(batch)));
    }
    await pg.query("update prompix.queue_jobs set finished_at=now()-interval '1 hour' where state='reconcile'");
    const attempts = JSON.stringify((await pg.query("select * from prompix.queue_attempts order by job_id")).rows);
    const probeBatch = "batch-0006", probeManifest = { ...manifest(probeBatch), leads: [{ ...manifest(probeBatch).leads[0], id: "99" }] };
    await atomic(join(root, run, probeBatch, "manifest.json"), probeManifest);
    for (const kind of ["collect", "review"] as const) await queue.enqueue({ id: `${run}:${probeBatch}:${kind}`, run, stage: kind, payload: { batch: probeBatch, manifestSHA: queueIdentity(probeManifest) } });
    const probe = await reserveReviewProbe(queue, root, run, probeBatch, proofs);
    await assert.rejects(inspectHistoryIsolation(queue, root, run), /successful fresh probe/);
    const source = { prompts: [{ id: "synthetic" }] }; await atomic(join(root, run, probeBatch, "source-catalog.json"), source);
    await workStage(queue, run, ["review"], async () => ({ count: 1, sourceSHA: queueIdentity(source) }), `${run}:${probeBatch}:review`);
    const { identities, attachments, attachmentBytes, ...editorial } = attempt;
    await atomic(join(root, run, probeBatch, "editorial-ledger.json"), { schemaVersion: 2, day, requests: 1, attempts: [{ ...editorial, state: "completed", error: undefined, reservedAt: new Date().toISOString() }] });
    await atomic(join(root, run, probeBatch, "visual-ledger.json"), { schemaVersion: 2, day, requests: 1, attempts: [{ ...attempt, state: "completed", error: undefined, reservedAt: new Date().toISOString() }] });
    await completeReviewProbe(queue, root, probe);
    assert.equal((await inspectHistoryIsolation(queue, root, run)).length, 5);
    assert.equal(await queue.claim(run, ["translate"]), undefined);
    assert.equal(JSON.stringify((await pg.query("select * from prompix.queue_attempts where job_id <> $1 order by job_id", [`${run}:${probeBatch}:review`])).rows), attempts);
    const next = "batch-0007"; await fixture(root, next);
    await queue.enqueue({ id: row(next).id, run, stage: "review", payload: row(next).payload });
    await assert.rejects(workStage(queue, run, ["review"], async () => { throw Error(row(next).output.message); }));
    await assert.rejects(inspectHistoryIsolation(queue, root, run), /circuit open/);
  } finally { await pg.close(); await rm(root, { recursive: true, force: true }); }
});

test("editorial timeout remains unknown and cannot use capacity terminal disposition", async () => {
  const { rejectVerifiedCapacityBatch } = await import("./history-isolation.ts");
  const root = await mkdtemp(join(tmpdir(), "editorial-timeout-")), batch = "batch-0001";
  const raw = { ...row(batch, "Historical editorial attempt requires inspection"), state: "reconcile" };
  const queue = new StageQueue({ query: async () => ({ rows: [raw] }) } as any);
  try {
    await fixture(root, batch); const { identities, attachments, attachmentBytes, ...editorial } = attempt;
    await atomic(join(root, run, batch, "editorial-ledger.json"), { schemaVersion: 2, day, requests: 1, attempts: [{ ...editorial, error: "Editorial provider timed out; daily attempt remains consumed" }] });
    await atomic(join(root, run, batch, "editorial-attempts/1.json"), { model: attempt.model, exitCode: null, eventsTruncated: false, outputBytes: null, outputText: null, events: '{"type":"turn.started"}' });
    assert.equal((await inspectHistoryIsolation(queue, root, run))[0].reason, "editorial-timeout-no-response");
    await assert.rejects(rejectVerifiedCapacityBatch(queue, root, run, batch), /Unknown provider outcomes cannot be closed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("non-review reconcile reports its actual stage and cause without changing evidence", async () => {
  const raw = { ...row("batch-0001"), id: `${run}:batch-0001:translate`, stage: "translate",
    output: { reason: "handler-failed", message: "Translation retained untranslated bracket guidance" } };
  const before = JSON.stringify(raw);
  const queue = new StageQueue({ query: async () => ({ rows: [raw] }) } as any);
  await assert.rejects(inspectHistoryIsolation(queue, "/unused", run), /batch-0001:translate \(translate\): Translation retained untranslated bracket guidance/);
  assert.equal(JSON.stringify(raw), before);
});

test("proven pre-provider quota failure rejects its whole batch while retaining original attempts", async () => {
 const root=await mkdtemp(join(tmpdir(),"admission-disposition-"));const{pg,writer}=await createTestDatabase();
 try{
  const queue=new StageQueue(writer),batch="batch-0001",id=row(batch).id;await fixture(root,batch);
  const failure={...attempt,error:JSON.stringify([{code:"invalid_value",values:[true],path:["ordinaryUsageAllowed"],message:"expected true"}])};
  await atomic(join(root,run,batch,"visual-ledger.json"),{schemaVersion:2,day,requests:1,attempts:[failure]});
  await queue.enqueue({id,run,stage:"review",payload:row(batch).payload});
  const observedAt=new Date(Date.now()-1000).toISOString();
  await assert.rejects(workStage(queue,run,["review"],async()=>{throw Error(row(batch).output.message);}));
  const before=await readFile(join(root,run,batch,"visual-ledger.json"));const attempts=JSON.stringify((await pg.query("select * from prompix.queue_attempts")).rows);
  await assert.rejects(rejectQuotaAdmissionBatch(queue,root,run,batch));
  await writeFile(join(root,"subscription-quota-history.jsonl"),JSON.stringify({observedAt,ordinaryUsageAllowed:false,weeklyUsedPercent:100,source:"codex-account-rate-limits"})+"\n");
  await atomic(join(root,run,batch,"visual-attempts/1.json"),{events:"partial or unknown"});
  await assert.rejects(rejectQuotaAdmissionBatch(queue,root,run,batch),/Retained response/);
  await rm(join(root,run,batch,"visual-attempts"),{recursive:true});
  const disposition=await rejectQuotaAdmissionBatch(queue,root,run,batch);assert.equal(disposition.qualified,0);assert.equal(disposition.replayed,false);
  assert.equal((await pg.query<{state:string}>("select state from prompix.queue_jobs where id=$1",[id])).rows[0].state,"rejected");
  assert.deepEqual(await readFile(join(root,run,batch,"visual-ledger.json")),before);assert.equal(JSON.stringify((await pg.query("select * from prompix.queue_attempts")).rows),attempts);
  await assert.rejects(rejectQuotaAdmissionBatch(queue,root,run,batch));
 }finally{await pg.close();await rm(root,{recursive:true,force:true});}
});
