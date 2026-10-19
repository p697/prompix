import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { json, writeImmutableBytes } from "./publication.ts";
import { historyBatchSchema } from "./history-cohort.ts";
import { editorialLedgerSchema } from "./editorial-runner.ts";
import { visualLedgerSchema } from "./visual-review.ts";
import { isPreOutputCapacityRejection } from "./provider-capacity.ts";
import { StageQueue, queueIdentity } from "./stage-queue.ts";

const messages = ["Historical visual attempt requires inspection", "Historical editorial attempt requires inspection"] as const;
export const isIsolatableReviewError = (error: unknown) => error instanceof Error && messages.some(message => message === error.message);
const rowSchema = z.object({ id: z.string(), stage: z.literal("review"), attempts: z.number().int().positive(),
  payload: z.object({ batch: z.string().regex(/^batch-\d{4}$/), manifestSHA: z.string().regex(/^[a-f0-9]{64}$/) }),
  output: z.object({ reason: z.literal("handler-failed"), message: z.enum(messages) }) });
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const absent = async (path: string) => {
  try { await readFile(path); throw new Error("Retained response requires inspection before isolation"); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; }
};

/** Keep failed jobs and their descendants pending inspection, never approve or replay them.
 * Only the two observed, evidenced provider conditions may leave unrelated batches running.
 * A persistent five-batch circuit breaker prevents an outage draining the campaign budget. */
export async function inspectHistoryIsolation(queue: StageQueue, root: string, run: string) {
  if (!/^[a-z0-9-]{1,80}$/.test(run)) throw new Error("Invalid isolation run");
  const rows = (await queue.db.query("select id,stage,attempts,payload,output from prompix.queue_jobs where run_id=$1 and state='reconcile' order by id", [run])).rows;
  if (rows.length >= 5) throw new Error("Five unresolved batches; campaign isolation circuit open");
  const proofs = [];
  for (const raw of rows) {
    const row = rowSchema.parse(raw), directory = join(root, run, row.payload.batch);
    if (row.id !== `${run}:${row.payload.batch}:review`) throw new Error("Isolation job identity changed");
    const manifest = historyBatchSchema.parse(await json(join(directory, "manifest.json"), null));
    if (manifest.id !== row.payload.batch || queueIdentity(manifest) !== row.payload.manifestSHA) throw new Error("Isolation manifest changed");
    const visual = row.output.message === messages[0], prefix = visual ? "visual" : "editorial";
    const bytes = await readFile(join(directory, `${prefix}-ledger.json`));
    const ledger = visual ? visualLedgerSchema.parse(JSON.parse(bytes.toString())) : editorialLedgerSchema.parse(JSON.parse(bytes.toString()));
    const last = ledger.attempts.at(-1);
    if (!last || last.state !== "failed" || ledger.attempts.slice(0, -1).some(a => a.state !== "completed")) throw new Error("Unclassified review attempts require inspection");
    const ids = new Set(manifest.leads.map(l => `x-post-${l.id}`));
    if (ledger.attempts.some(a => a.candidateIDs.some(id => !ids.has(id)))) throw new Error("Isolation candidate identity changed");
    await absent(join(directory, `${prefix}-responses`, `${ledger.requests}.json`));
    let evidenceSHA: string | null = null;
    if (visual) {
      if (last.error !== "Visual provider timed out; daily attempt remains consumed") throw new Error("Unclassified visual failure");
    } else {
      if (last.error !== "Editorial provider exited 1") throw new Error("Unclassified editorial failure");
      const evidence = await readFile(join(directory, "editorial-attempts", `${ledger.requests}.json`));
      const attempt = JSON.parse(evidence.toString());
      if (attempt.model !== last.model || attempt.exitCode !== 1 || attempt.eventsTruncated !== false
        || attempt.outputBytes !== null || attempt.outputText !== null || typeof attempt.events !== "string"
        || !isPreOutputCapacityRejection(attempt.events)) throw new Error("Editorial failure is not a verified pre-output capacity rejection");
      evidenceSHA = hash(evidence);
    }
    const proof = { version: 1, jobID: row.id, batch: row.payload.batch, attempt: row.attempts, manifestSHA: row.payload.manifestSHA,
      reason: visual ? "visual-timeout-no-response" : "editorial-capacity-before-output", ledgerSHA: hash(bytes), evidenceSHA,
      consumedRequests: ledger.requests, candidateIDs: last.candidateIDs, qualified: 0, replayed: false };
    await writeImmutableBytes(join(root, "isolated-reviews", `${row.payload.batch}-${row.attempts}.json`), Buffer.from(JSON.stringify(proof) + "\n"));
    proofs.push(proof);
  }
  return proofs;
}

/** Exclude only validated isolated batches from scheduling pressure; their SQL rows are untouched. */
export async function activeHistoryBatches(queue: StageQueue, run: string, isolated: readonly { batch: string }[]) {
  const rows = await queue.db.query<{ count: number }>(`select count(distinct payload->>'batch')::int as count
    from prompix.queue_jobs where run_id=$1 and state in ('queued','leased','retry')
    and not (payload->>'batch'=any($2::text[]))`, [run, isolated.map(p => p.batch)]);
  return rows.rows[0].count;
}
