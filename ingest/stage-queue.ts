import { hasUncertainCommit } from "../services/feed/postgres.ts";
import { transientQueryError } from "./transient-retry.ts";
import { VerifiedCapacityRejection } from "./provider-capacity.ts";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { TransactionalDatabase } from "../services/feed/database.ts";

export const queueStages = ["collect", "review", "translate", "semantic", "locale"] as const;
export type QueueStage = typeof queueStages[number];
export const queueIdentity = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const inputSchema = z.object({ id: z.string().min(1).max(200), run: z.string().min(1).max(100), stage: z.enum(queueStages),
  payload: z.record(z.string(), z.unknown()), dependency: z.string().max(200).optional(), priority: z.number().int().min(0).max(10).default(0),
  maxAttempts: z.number().int().min(1).max(5).default(3) });
export type QueueInput = z.input<typeof inputSchema>;
export type QueueJob = { id: string; run_id: string; stage: QueueStage; identity: string; payload: Record<string, unknown>; dependency: string | null;
  attempts: number; max_attempts?: number; lease_token: string };

/** SQL operations finish before any network/model work. Unknown attempts are never automatically replayed. */
export class StageQueue {
  constructor(readonly db: TransactionalDatabase) {}
  async enqueue(raw: QueueInput) {
    const input = inputSchema.parse(raw), identity = queueIdentity(input);
    if (Buffer.byteLength(JSON.stringify(input.payload)) > 60000) throw new Error("Queue payload too large");
    const result = await this.db.query(`insert into prompix.queue_jobs(id,run_id,stage,identity,payload,dependency,priority,max_attempts)
      values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(id) do update set id=excluded.id
      where prompix.queue_jobs.identity=excluded.identity returning id`,
    [input.id, input.run, input.stage, identity, JSON.stringify(input.payload), input.dependency ?? null, input.priority, input.maxAttempts]);
    if (result.rows.length !== 1) throw new Error("Immutable queue identity conflict");
  }
  async claim(run: string, stages: readonly QueueStage[], leaseSeconds = 900, onlyJobID?: string): Promise<QueueJob | undefined> {
    if (!run || !stages.length || stages.some(s => !queueStages.includes(s)) || !Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600) throw new Error("Invalid queue claim");
    const token = randomUUID();
    try { return await this.db.transaction(async tx => {
      // One short lock provides a global cap across runs/processes, not a per-worker multiplier.
      const control = (await tx.query<{ max_active: number }>("select max_active from prompix.queue_controls where id='ingest' for update")).rows[0];
      await tx.query(`with expired as (
        update prompix.queue_jobs set state='reconcile',lease_token=null,lease_until=null
        where state='leased' and lease_until<=now() returning id,attempts
      ) update prompix.queue_attempts a set outcome='reconcile',finished_at=now(),evidence='{"reason":"lease-expired"}'
        from expired e where a.job_id=e.id and a.attempt=e.attempts and a.outcome='reserved'`);
      const active = (await tx.query<{ count: number }>("select count(*)::int as count from prompix.queue_jobs where state='leased'")).rows[0].count;
      if (!control || active >= control.max_active) return;
      const claimed = await tx.query<QueueJob>(`with candidate as (
        select j.id from prompix.queue_jobs j where j.run_id=$1 and j.stage=any($2::text[])
        and ($5::text is null or j.id=$5)
        and j.state in ('queued','retry') and j.available_at<=now() and j.attempts<j.max_attempts
        and (j.dependency is null or exists(select 1 from prompix.queue_jobs d where d.id=j.dependency and d.state='succeeded'))
        order by j.priority desc,j.created_at,j.id for update of j skip locked limit 1
      ) update prompix.queue_jobs j set state='leased',attempts=attempts+1,lease_token=$3,lease_until=now()+$4*interval '1 second'
        from candidate c where j.id=c.id returning j.*`, [run, stages, token, leaseSeconds, onlyJobID ?? null]);
      const job = claimed.rows[0];
      if (job) await tx.query("insert into prompix.queue_attempts(job_id,attempt,token) values($1,$2,$3)", [job.id, job.attempts, token]);
      return job;
    }); } catch (error) {
      if (!hasUncertainCommit(error) || !transientQueryError(error)) throw error;
      // No handler has started. The control lock is a barrier behind the original transaction:
      // once acquired, absence of this exact token proves there was no committed claim.
      return this.db.transaction(async tx => {
        await tx.query("select max_active from prompix.queue_controls where id='ingest' for update");
        const rows = (await tx.query<QueueJob & { state: string; attempt_outcome: string; lease_live: boolean }>(`
          select j.*,a.outcome as attempt_outcome,(j.lease_until>now()) as lease_live
          from prompix.queue_attempts a join prompix.queue_jobs j on j.id=a.job_id
          where a.token=$1`, [token])).rows;
        if (!rows.length) return undefined;
        if (rows.length !== 1) throw new Error("Ambiguous queue claim token");
        const job = rows[0];
        if (job.run_id !== run || !stages.includes(job.stage) || (onlyJobID && job.id !== onlyJobID) ||
          job.state !== "leased" || job.lease_token !== token || !job.lease_live || job.attempt_outcome !== "reserved")
          throw new Error("Recovered queue claim is no longer exclusively owned");
        return job;
      });
    }
  }
  async renew(job: QueueJob, seconds = 900) {
    if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) throw new Error("Invalid lease extension");
    const result = await this.db.query("update prompix.queue_jobs set lease_until=now()+$3*interval '1 second' where id=$1 and lease_token=$2 and state='leased' and lease_until>now() returning id", [job.id, job.lease_token, seconds]);
    if (!result.rows.length) throw new Error("Queue lease lost");
  }
  async finish(job: QueueJob, outcome: "succeeded" | "retry" | "reconcile" | "rejected", evidence: Record<string, unknown>) {
    if (Buffer.byteLength(JSON.stringify(evidence)) > 60000) throw new Error("Queue evidence too large");
    return this.db.transaction(async tx => {
      const result = await tx.query(`update prompix.queue_jobs set state=case when $3='retry' and attempts>=max_attempts then 'rejected' else $3 end,
        output=$4,lease_token=null,lease_until=null,finished_at=now(),available_at=now()+least(3600,30*power(2,attempts))*interval '1 second'
        where id=$1 and lease_token=$2 and state='leased' and lease_until>now() returning state`,
      [job.id, job.lease_token, outcome, JSON.stringify(evidence)]);
      if (!result.rows.length) throw new Error("Queue lease lost; result must be reconciled");
      await tx.query("update prompix.queue_attempts set outcome=$3,evidence=$4,finished_at=now() where job_id=$1 and token=$2 and outcome='reserved'",
        [job.id, job.lease_token, result.rows[0].state, JSON.stringify(evidence)]);
    });
  }
  /** A lost COMMIT acknowledgement may hide success. Read both rows; never replay the handler. */
  async confirmsSuccess(job: QueueJob, evidence: Record<string, unknown>) {
    const row = (await this.db.query<{ output: unknown; evidence: unknown }>(`select j.output,a.evidence
      from prompix.queue_jobs j join prompix.queue_attempts a on a.job_id=j.id and a.attempt=j.attempts
      where j.id=$1 and j.identity=$2 and j.attempts=$3 and j.state='succeeded'
        and a.token=$4 and a.outcome='succeeded'`, [job.id, job.identity, job.attempts, job.lease_token])).rows[0];
    return !!row && isDeepStrictEqual(row.output, evidence) && isDeepStrictEqual(row.evidence, evidence);
  }
  async counts(run: string) {
    return (await this.db.query("select stage,state,count(*)::int as count from prompix.queue_jobs where run_id=$1 group by stage,state order by stage,state", [run])).rows;
  }
}

export async function workStage(queue: StageQueue, run: string, stages: QueueStage[], handler: (job: QueueJob) => Promise<Record<string, unknown>>, onlyJobID?: string) {
  const job = await queue.claim(run, stages, 900, onlyJobID);
  if (!job) return false;
  let leaseError: unknown;
  const timer = setInterval(() => { void queue.renew(job).catch(e => { leaseError = e; }); }, 60000);
  try {
    const result = await handler(job);
    clearInterval(timer);
    // A transient renewal error is not proof of lease loss. This fresh CAS must
    // succeed with the same unexpired token before accepting the retained result.
    if (leaseError) await queue.renew(job);
    try { await queue.finish(job, "succeeded", result); }
    catch (error) {
      if (!await queue.confirmsSuccess(job, result)) throw error;
    }
  } catch (error) {
    if (!leaseError && job.stage === "semantic" && error instanceof VerifiedCapacityRejection
      && job.attempts < Math.min(3, job.max_attempts ?? 3)) {
      await queue.finish(job, "retry", { reason: "verified-capacity-before-output", eventsSHA256: error.eventsSHA256, sameModel: true });
      return true;
    }
    // Exhausted capacity rejections and unknown outcomes retain evidence and stop for inspection.
    // No blanket retry of external calls after timeout or ambiguous commit.
    await queue.finish(job, "reconcile", { reason: "handler-failed", message: error instanceof Error ? error.message.slice(0, 500) : "unknown" }).catch(() => {});
    throw error;
  } finally { clearInterval(timer); }
  return true;
}
