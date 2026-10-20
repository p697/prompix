import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { atomic } from "./publication.ts";
import { activateCampaignStage } from "./campaign-stage.ts";
import { StageQueue, queueIdentity, workStage } from "./stage-queue.ts";
import { reserveReviewProbe, completeReviewProbe, recoveredReviewIDs } from "./review-recovery.ts";
import { createTestDatabase } from "../services/feed/test-database.ts";
const run = "recovery", stageID = "stage-1", batch = "batch-0006", now = Date.parse("2026-10-20T07:00:00Z");
const old = { jobID: `${run}:batch-0001:review`, batch: "batch-0001", attempt: 1, manifestSHA: "a".repeat(64), ledgerSHA: "b".repeat(64), evidenceSHA: null };
const manifest = { version: 1, id: batch, createdAt: "2026-10-20T06:00:00Z", leads: [{ id: "99", authorID: "2", reason: "prompt", kind: "image", visual: true, sourceDate: "2026-10-19T00:00:00Z", evidence: "synthetic" }] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "recovery-"));
  const path = join(root, "stage-evidence.json"); await atomic(path, {});
  await activateCampaignStage(root, { version: 1, id: stageID, run, authorizedAt: "2026-10-20T00:00:00Z", baselineCount: 1, seedReadyAtStart: 0, newReadyAtStart: 0, additionalQualified: 1000,
    evidencePath: path, evidenceSHA256: createHash("sha256").update(await readFile(path)).digest("hex") });
  await atomic(join(root, run, batch, "manifest.json"), manifest);
  let rows: any[] = [{ id: old.jobID, stage: "review", state: "reconcile", attempts: 1, finished_at: "2026-10-20T06:00:00Z" },
    ...["collect", "review"].map(stage => ({ id: `${run}:${batch}:${stage}`, stage, state: "queued", attempts: 0 }))];
  let success: any;
  const queue = new StageQueue({ query: async (sql: string) => ({ rows: sql.startsWith("select attempts") ? success ? [success] : [] : rows }) } as any);
  const setSuccess = async (accepted = true) => {
    const source = { prompts: accepted ? [{ id: "synthetic" }] : [] }; await atomic(join(root, run, batch, "source-catalog.json"), source);
    success = { attempts: 1, payload: { manifestSHA: queueIdentity(manifest) }, output: { count: accepted ? 1 : 0, sourceSHA: queueIdentity(source) } };
    const attempt = { day: "2026-10-20", requests: 1, model: "gpt-5.6-luna", reservedAt: "2026-10-20T07:00:00Z", candidateIDs: ["x-post-99"], inputCharacters: 100, state: "completed" };
    await atomic(join(root, run, batch, "editorial-ledger.json"), { schemaVersion: 2, day: attempt.day, requests: 1, attempts: [attempt] });
    await atomic(join(root, run, batch, "visual-ledger.json"), { schemaVersion: 2, day: attempt.day, requests: 1, attempts: [{ ...attempt, identities: ["a".repeat(64)], attachments: 1, attachmentBytes: 100 }] });
  };
  return { root, queue, rows, setSuccess, close: () => rm(root, { recursive: true, force: true }) };
}

test("fresh probe preserves unknowns and requires actual provider success before recovery; restart verifies evidence", async () => {
  const f = await fixture(); try {
    const before = JSON.stringify(f.rows);
    const probe = await reserveReviewProbe(f.queue, f.root, run, batch, [old], now);
    await assert.rejects(recoveredReviewIDs(f.queue, f.root, run, [old], now), /successful fresh probe/);
    await assert.rejects(completeReviewProbe(f.queue, f.root, probe, now), /no completed/);
    await f.setSuccess(); await completeReviewProbe(f.queue, f.root, probe, now);
    assert.deepEqual(await recoveredReviewIDs(f.queue, f.root, run, [old], now), new Set([old.jobID]));
    assert.equal(JSON.stringify(f.rows), before, "no old SQL job or attempt mutations");
    await assert.rejects(recoveredReviewIDs(f.queue, f.root, run, [{ ...old, ledgerSHA: "c".repeat(64) }], now), /Quarantined evidence changed/);
    await assert.rejects(recoveredReviewIDs(f.queue, f.root, run, [old], now + 12 * 3600_000), /expired/);
    await atomic(join(f.root, run, batch, "source-catalog.json"), { changed: true });
    await assert.rejects(recoveredReviewIDs(f.queue, f.root, run, [old], now), /source changed/);
  } finally { await f.close(); }
});

test("probe rejects live leases, cooldown, attempted jobs and oversized batch before reserving", async () => {
  const f = await fixture(); try {
    f.rows[1].state = "leased"; await assert.rejects(reserveReviewProbe(f.queue, f.root, run, batch, [old], now), /Drain leases/); f.rows[1].state = "queued";
    await assert.rejects(reserveReviewProbe(f.queue, f.root, run, batch, [old], now - 31 * 60_000), /cooldown/);
    f.rows[2].attempts = 1; await assert.rejects(reserveReviewProbe(f.queue, f.root, run, batch, [old], now), /never have been attempted/); f.rows[2].attempts = 0;
    await atomic(join(f.root, run, batch, "manifest.json"), { ...manifest, leads: [...manifest.leads, { ...manifest.leads[0], id: "100" }] });
    await assert.rejects(reserveReviewProbe(f.queue, f.root, run, batch, [old], now), /exactly one/);
  } finally { await f.close(); }
});

test("crashed or failed probes consume persistent three-slot bound and cannot replay", async () => {
  const f = await fixture(); try {
    await reserveReviewProbe(f.queue, f.root, run, batch, [old], now);
    await assert.rejects(reserveReviewProbe(f.queue, f.root, run, batch, [old], now + 3600_000), /identity changed/);
    for (let i = 2; i <= 4; i++) {
      const next = `batch-000${5 + i}`;
      await atomic(join(f.root, run, next, "manifest.json"), { ...manifest, id: next, leads: [{ ...manifest.leads[0], id: String(i + 100) }] });
      f.rows.push(...["collect", "review"].map(stage => ({ id: `${run}:${next}:${stage}`, stage, state: "queued", attempts: 0 })));
      if (i <= 3) await reserveReviewProbe(f.queue, f.root, run, next, [old], now + i * 3600_000);
      else await assert.rejects(reserveReviewProbe(f.queue, f.root, run, next, [old], now + i * 3600_000), /budget exhausted/);
    }
  } finally { await f.close(); }
});

test("targeted queue claims never consume unrelated work or replay unknown jobs", async () => {
  const { pg, writer } = await createTestDatabase(); try {
    const q = new StageQueue(writer);
    for (const id of ["unrelated", "probe"]) await q.enqueue({ id, run, stage: "review", payload: {} });
    let selected = "";
    await assert.rejects(workStage(q, run, ["review"], async job => { selected = job.id; throw Error("timeout"); }, "probe"));
    assert.equal(selected, "probe");
    assert.equal(await workStage(q, run, ["review"], async () => { throw Error("must not replay"); }, "probe"), false);
    const rows = (await pg.query<{ id: string; state: string }>("select id,state from prompix.queue_jobs order by id")).rows;
    assert.deepEqual(rows, [{ id: "probe", state: "reconcile" }, { id: "unrelated", state: "queued" }]);
  } finally { await pg.close(); }
});


test("a valid visual rejection proves health without admitting content or repeating a request", async () => {
  const f = await fixture(); try {
    const probe = await reserveReviewProbe(f.queue, f.root, run, batch, [old], now);
    await f.setSuccess(false);
    const before = await readFile(join(f.root, run, batch, "visual-ledger.json"));
    await completeReviewProbe(f.queue, f.root, probe, now);
    assert.deepEqual(await recoveredReviewIDs(f.queue, f.root, run, [old], now), new Set([old.jobID]));
    assert.deepEqual(JSON.parse(await readFile(join(f.root, run, batch, "source-catalog.json"), "utf8")).prompts, []);
    assert.deepEqual(await readFile(join(f.root, run, batch, "visual-ledger.json")), before);
    const p = join(f.root, run, batch, "visual-ledger.json");
    await atomic(p, { schemaVersion: 2, day: "2026-10-20", requests: 0, attempts: [] });
    await assert.rejects(recoveredReviewIDs(f.queue, f.root, run, [old], now), /Too small|completed call/);
  } finally { await f.close(); }
});
