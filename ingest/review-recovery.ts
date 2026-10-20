/** Recovery never resolves old requests. A fresh, single-source probe proves health;
 * its bounded stage-scoped receipt allows unrelated work until the next failure. */
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { z } from "zod";
import { json, atomic, writeImmutableBytes } from "./publication.ts";
import { readCampaignStage } from "./campaign-stage.ts";
import { historyBatchSchema } from "./history-cohort.ts";
import { editorialLedgerSchema } from "./editorial-runner.ts";
import { visualLedgerSchema } from "./visual-review.ts";
import { queueIdentity, type StageQueue } from "./stage-queue.ts";

export type ReviewProof = { jobID: string; batch: string; attempt: number; manifestSHA: string; ledgerSHA: string; evidenceSHA: string | null };
const schema = z.object({ version: z.literal(1), run: z.string().regex(/^[a-z0-9-]{1,80}$/), stageID: z.string().regex(/^[a-z0-9-]{1,80}$/),
  sequence: z.number().int().min(1).max(3), batch: z.string().regex(/^batch-\d{4}$/), manifestSHA: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), failures: z.array(z.object({ jobID: z.string(), identity: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(100) }).strict();
export type ReviewProbe = z.infer<typeof schema>;
const directory = (root: string, stage: string) => join(root, "review-recovery", stage);
const freeze = (proofs: readonly ReviewProof[]) => proofs.map(p => ({ jobID: p.jobID, identity: queueIdentity(p) }));

/** Caller holds the campaign root lock. Reserve before making any external request;
 * crashes, rejects and unknown results all consume one of three durable slots. */
export async function reserveReviewProbe(queue: StageQueue, root: string, run: string, batch: string, proofs: readonly ReviewProof[], now = Date.now()) {
  const stage = await readCampaignStage(root);
  if (!stage || stage.run !== run) throw Error("Recovery requires an active matching stage");
  if (!/^batch-\d{4}$/.test(batch) || !proofs.length || proofs.some(p => p.batch === batch)) throw Error("Probe must be an unrelated new batch");
  const rows = (await queue.db.query<{ id: string; stage: string; state: string; attempts: number; finished_at: string | Date }>(
    "select id,stage,state,attempts,finished_at from prompix.queue_jobs where run_id=$1", [run])).rows;
  if (rows.some(r => r.state === "leased")) throw Error("Drain leases before recovery");
  const unresolved = rows.filter(r => r.state === "reconcile");
  if (unresolved.length !== proofs.length || unresolved.some(r => !proofs.some(p => p.jobID === r.id && p.attempt === r.attempts))) throw Error("Recovery failure snapshot changed");
  const failureTimes = unresolved.map(r => new Date(r.finished_at).getTime());
  if (failureTimes.some(t => !Number.isFinite(t) || t > now) || now - Math.max(...failureTimes) < 30 * 60_000) throw Error("Recovery requires 30 minutes of cooldown");
  for (const kind of ["collect", "review"]) {
    const row = rows.find(r => r.id === `${run}:${batch}:${kind}`);
    if (!row || row.stage !== kind || row.state !== "queued" || row.attempts !== 0) throw Error("Probe must never have been attempted");
  }
  for (const name of ["editorial-ledger.json", "visual-ledger.json", "source-catalog.json"])
    if (await json(join(root, run, batch, name), null)) throw Error("Probe already has provider artifacts");
  const manifest = historyBatchSchema.parse(await json(join(root, run, batch, "manifest.json"), null));
  if (manifest.id !== batch || manifest.leads.length !== 1 || !["image", "video", "web"].includes(manifest.leads[0].kind ?? "")) throw Error("Probe requires exactly one visual source");
  const batches = (await readdir(join(root, run))).filter(name => /^batch-\d{4}$/.test(name));
  for (const name of batches) {
    if (name === batch) continue;
    const previous = historyBatchSchema.parse(await json(join(root, run, name, "manifest.json"), null));
    if (previous.leads.some(lead => lead.id === manifest.leads[0].id)) throw Error("Probe source was already assigned");
  }
  const files = (await readdir(directory(root, stage.id)).catch(e => { if (e.code === "ENOENT") return []; throw e; })).filter(f => /^attempt-[123]\.json$/.test(f)).sort();
  if (files.length >= 3) throw Error("Stage recovery probe budget exhausted");
  for (let i = 0; i < files.length; i++) {
    const prior = schema.parse(await json(join(directory(root, stage.id), files[i]), null));
    if (prior.sequence !== i + 1 || prior.run !== run || prior.stageID !== stage.id || prior.batch === batch) throw Error("Recovery attempt identity changed");
    if (Date.parse(prior.createdAt) > now || now - Date.parse(prior.createdAt) < 30 * 60_000) throw Error("Recovery requires 30 minutes of cooldown");
  }
  const probe = schema.parse({ version: 1, run, stageID: stage.id, sequence: files.length + 1, batch, manifestSHA: queueIdentity(manifest),
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 12 * 3600_000).toISOString(), failures: freeze(proofs) });
  await writeImmutableBytes(join(directory(root, stage.id), `attempt-${probe.sequence}.json`), Buffer.from(JSON.stringify(probe) + "\n"));
  // Immediately invalidate any earlier success; a failed new probe cannot reuse it.
  await atomic(join(root, "review-recovery", "active.json"), { version: 1, stageID: stage.id, sequence: probe.sequence });
  return probe;
}

async function probeEvidence(queue: StageQueue, root: string, probe: ReviewProbe) {
  const base = join(root, probe.run, probe.batch);
  const manifest = historyBatchSchema.parse(await json(join(base, "manifest.json"), null));
  if (queueIdentity(manifest) !== probe.manifestSHA || manifest.leads.length !== 1) throw Error("Probe manifest changed");
  const row = (await queue.db.query<{ attempts: number; output: { count?: number; sourceSHA?: string }; payload: { manifestSHA?: string } }>(
    "select attempts,output,payload from prompix.queue_jobs where id=$1 and run_id=$2 and stage='review' and state='succeeded'",
    [`${probe.run}:${probe.batch}:review`, probe.run])).rows[0];
  if (!row || row.attempts !== 1 || row.payload.manifestSHA !== probe.manifestSHA || row.output.count !== 1) throw Error("Probe has no successful reviewed source");
  const source = await json(join(base, "source-catalog.json"), null);
  if (!source || queueIdentity(source) !== row.output.sourceSHA) throw Error("Probe source changed");
  const editorial = editorialLedgerSchema.parse(await json(join(base, "editorial-ledger.json"), null));
  const visual = visualLedgerSchema.parse(await json(join(base, "visual-ledger.json"), null));
  // Both providers must actually have returned, not merely found a cache hit or rejected an empty batch.
  for (const ledger of [editorial, visual]) if (ledger.requests !== 1 || ledger.attempts.length !== 1 || ledger.attempts[0].state !== "completed" || Date.parse(ledger.attempts[0].reservedAt) < Date.parse(probe.createdAt) || Date.parse(ledger.attempts[0].reservedAt) >= Date.parse(probe.expiresAt)) throw Error("Probe requires one completed call to each review provider");
  return { sourceSHA: row.output.sourceSHA, editorialSHA: queueIdentity(editorial), visualSHA: queueIdentity(visual) };
}

export async function completeReviewProbe(queue: StageQueue, root: string, raw: ReviewProbe, now = Date.now()) {
  const probe = schema.parse(raw), stage = await readCampaignStage(root);
  if (!stage || stage.id !== probe.stageID || stage.run !== probe.run || now < Date.parse(probe.createdAt) || now >= Date.parse(probe.expiresAt)) throw Error("Recovery stage or time changed");
  const retained = schema.parse(await json(join(directory(root, stage.id), `attempt-${probe.sequence}.json`), null));
  if (queueIdentity(retained) !== queueIdentity(probe)) throw Error("Recovery reservation changed");
  const evidence = await probeEvidence(queue, root, probe);
  const receipt = { version: 1, probeSHA: queueIdentity(probe), evidence };
  await writeImmutableBytes(join(directory(root, stage.id), `success-${probe.sequence}.json`), Buffer.from(JSON.stringify(receipt) + "\n"));
  return receipt;
}

export async function recoveredReviewIDs(queue: StageQueue, root: string, run: string, proofs: readonly ReviewProof[], now = Date.now()): Promise<Set<string> | null> {
  const raw = await json(join(root, "review-recovery", "active.json"), null);
  if (!raw) return null;
  const pointer = z.object({ version: z.literal(1), stageID: schema.shape.stageID, sequence: schema.shape.sequence }).strict().parse(raw);
  const stage = await readCampaignStage(root);
  if (!stage || stage.run !== run || stage.id !== pointer.stageID) throw Error("Recovery does not match active stage");
  const probe = schema.parse(await json(join(directory(root, stage.id), `attempt-${pointer.sequence}.json`), null));
  if (probe.run !== run || probe.stageID !== stage.id || probe.sequence !== pointer.sequence || now < Date.parse(probe.createdAt) || now >= Date.parse(probe.expiresAt)) throw Error("Recovery expired or identity changed");
  const receipt = await json<any>(join(directory(root, stage.id), `success-${pointer.sequence}.json`), null);
  if (!receipt || receipt.probeSHA !== queueIdentity(probe)) throw Error("Review circuit awaits a successful fresh probe");
  const current = new Map(freeze(proofs).map(p => [p.jobID, p.identity]));
  if (probe.failures.some(p => current.get(p.jobID) !== p.identity)) throw Error("Quarantined evidence changed; inspect before recovery");
  if (queueIdentity(await probeEvidence(queue, root, probe)) !== queueIdentity(receipt.evidence)) throw Error("Successful probe evidence changed");
  return new Set(probe.failures.map(p => p.jobID));
}
