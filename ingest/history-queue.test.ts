import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { catalogSchema } from "../packages/schema/catalog.ts";
import { processHistoryStage, enqueueHistoryPipeline, exportQueueReady, readHistoryQualityHolds } from "./history-queue.ts";
import { StageQueue, queueIdentity, type QueueJob } from "./stage-queue.ts";
import { atomic } from "./publication.ts";
import { verifyReviewedHistory } from "./history-stage-verification.ts";
import { ingestLanguagePolicy } from "./ingest-language-policy.ts";

test("semantic stage hashes persisted JSON before schema normalization and rejects tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-queue-identity-"));
  try {
    const run = "identity-test", batch = { version: 1, id: "batch-0001", createdAt: "2026-10-19T00:00:00Z", leads: [
      { id: "1", authorID: "2", reason: "prompt", kind: "image", visual: true, sourceDate: "2026-08-10T00:00:00Z", evidence: "synthetic" }] };
    const item = { id: "synthetic", kind: "text", title: "Synthetic title", summary: "Summary", prompt: "Draw a paper garden.", example: "Example", tags: ["art"], model: "Any", toolURL: null, artwork: "paper", previewLabel: "Preview", media: { image: null, video: null, demoURL: null }, source: { name: "Synthetic", url: null, license: "CC0", method: "test" } };
    const raw = { prompts: [item], version: "synthetic", schemaVersion: 1 };
    let expected = queueIdentity(raw);
    assert.notEqual(queueIdentity(catalogSchema.parse(raw)), expected);
    const directory = join(root, run, batch.id);
    await atomic(join(directory, "manifest.json"), batch);
    await atomic(join(directory, "complete.json"), raw);
    const queue = new StageQueue({ query: async () => ({ rows: [{ output: { translatedSHA: expected } }] }) } as any);
    const job: QueueJob = { id: "synthetic", run_id: run, stage: "semantic", identity: "unused", payload: { batch: batch.id, manifestSHA: queueIdentity(batch), policy: ingestLanguagePolicy, start: 4 }, dependency: "translation", attempts: 1, lease_token: "unused" };
    // An empty semantic slot proves the boundary without making any provider call.
    assert.deepEqual(await processHistoryStage(queue, root, root, job), { pass: 0, held: 0, published: 0 });
    await atomic(join(directory, "complete.json"), { ...raw, ignoredField: "tampered" });
    await assert.rejects(processHistoryStage(queue, root, root, job), /Translated stage artifact changed/);
    const empty = { ...raw, prompts: [] };
    expected = queueIdentity(empty);
    await atomic(join(directory, "complete.json"), empty);
    await atomic(join(directory, "source-catalog.json"), empty);
    assert.deepEqual(await verifyReviewedHistory(directory, root), []);
    assert.deepEqual(await processHistoryStage(queue, root, root, job), { pass: 0, held: 0, published: 0 });
    const invalid = { ...raw, prompts: [{ ...item, title: "" }] };
    expected = queueIdentity(invalid);
    await atomic(join(directory, "complete.json"), invalid);
    await assert.rejects(processHistoryStage(queue, root, root, job), /Too small/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("resumed enqueue preserves exclusion bytes across key normalization and rejects value changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-exclusions-"));
  try {
    const run = "resume-test", batch = { version: 1 as const, id: "batch-0002", createdAt: "2026-10-19T00:00:00Z", leads: [
      { id: "1", authorID: "2", reason: "prompt" as const, kind: "image" as const, visual: true, sourceDate: "2026-08-10T00:00:00Z", evidence: "synthetic" }] };
    const item = { source: { method: "test", license: "CC0", url: null, name: "Synthetic" },
      previewLabel: "Preview", artwork: "paper", toolURL: null, model: "Any", tags: ["art"], example: "Example", prompt: "Draw a paper garden.", summary: "Summary", title: "Title", kind: "text", id: "synthetic", media: { image: null, video: null, demoURL: null } };
    const normalized = catalogSchema.parse({ schemaVersion: 1, version: "test", prompts: [item] }).prompts;
    const path = join(root, run, "exclusions.json");
    await atomic(path, [item]);
    const before = await readFile(path);
    const jobs: string[] = [];
    const queue = { enqueue: async (job: { id: string }) => { jobs.push(job.id); } } as unknown as StageQueue;
    await enqueueHistoryPipeline(queue, root, run, batch, normalized);
    assert.equal(jobs.length, 4);
    assert.deepEqual(await readFile(path), before);
    await enqueueHistoryPipeline(queue, root, run, { ...batch, id: "batch-0003" }, normalized);
    assert.equal(jobs.length, 8);
    await assert.rejects(enqueueHistoryPipeline(queue, root, run, { ...batch, id: "batch-0004" }, [{ ...normalized[0], title: "Changed" }]), /Immutable queue exclusions changed/);
    assert.equal(jobs.length, 8);
    assert.deepEqual(await readFile(path), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("owner holds exclude ready items while immutable evidence and surviving approvals remain mandatory", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-ready-hold-"));
  try {
    const run = "hold-test", batch = "batch-0001";
    const ready = [{ id: "held", prompt: "Draw two circles." }];
    const path = join(root, run, batch, "ready-0.json");
    await atomic(path, ready);
    await atomic(join(root, run, "exclusions.json"), []);
    const hold = { schemaVersion: 1, holds: { held: { sourceIdentitySHA256: "a".repeat(64), evidenceSHA256: "b".repeat(64),
      reason: "Owner found an inconsistent requirement", reviewerID: "owner", reviewedAt: "2026-10-01T00:00:00Z" } } };
    await atomic(join(root, "quality-holds.json"), hold);
    const queue = new StageQueue({ query: async () => ({ rows: [{ payload: { batch, start: 0, manifestSHA: "c".repeat(64), policy: ingestLanguagePolicy }, output: { pass: 1, readySHA: queueIdentity(ready) } }] }) } as any);
    const before = await readFile(path);
    assert.deepEqual(await exportQueueReady(queue, root, root, run), []);
    assert.deepEqual(await readFile(path), before, "A hold must not rewrite the original approved evidence");
    await atomic(path, [{ ...ready[0], prompt: "Tampered" }]);
    await assert.rejects(exportQueueReady(queue, root, root, run), /Ready evidence changed/);
    await atomic(path, ready);
    await atomic(join(root, "quality-holds.json"), { schemaVersion: 1, holds: {} });
    await assert.rejects(exportQueueReady(queue, root, root, run), /History editorial\/source approval changed|ENOENT/, "Without a hold full source/media approval is still mandatory");
    await atomic(join(root, "quality-holds.json"), { invalid: true });
    await assert.rejects(exportQueueReady(queue, root, root, run));
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("campaign owner holds exclude output while shared publication lock remains independent", async () => {
  const root = await mkdtemp(join(tmpdir(), "campaign-owner-hold-")), shared = await mkdtemp(join(tmpdir(), "public-owner-hold-"));
  try {
    const record = { sourceIdentitySHA256: "a".repeat(64), evidenceSHA256: "b".repeat(64), reason: "Metadata contradicts original prompt",
      reviewerID: "owner", reviewedAt: "2026-10-19T00:00:00Z" };
    await atomic(join(shared, "quality-holds.json"), { schemaVersion: 1, holds: { global: record } });
    await atomic(join(shared, "daily.lock", "owner.json"), { pid: process.pid });
    await atomic(join(root, "quality-holds.json"), { schemaVersion: 1, holds: { local: record } });
    assert.deepEqual(Object.keys((await readHistoryQualityHolds(root, shared)).holds).sort(), ["global", "local"]);
    const run = "local-hold", batch = "batch-0001", ready = [{ id: "local", prompt: "Draw two circles." }];
    const file = join(root, run, batch, "ready-0.json"); await atomic(file, ready);
    await atomic(join(root, run, "exclusions.json"), []);
    const queue = new StageQueue({ query: async () => ({ rows: [{ payload: { batch, start: 0, manifestSHA: "c".repeat(64), policy: ingestLanguagePolicy }, output: { pass: 1, readySHA: queueIdentity(ready) } }] }) } as any);
    const before = await readFile(file), globalBefore = await readFile(join(shared, "quality-holds.json"));
    assert.deepEqual(await exportQueueReady(queue, root, shared, run), []);
    assert.deepEqual(await readFile(file), before); assert.deepEqual(await readFile(join(shared, "quality-holds.json")), globalBefore);
    await atomic(join(root, "quality-holds.json"), { malformed: true });
    await assert.rejects(exportQueueReady(queue, root, shared, run));
  } finally { await rm(root, { recursive: true, force: true }); await rm(shared, { recursive: true, force: true }); }
});
