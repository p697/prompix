import { z } from "zod";
import type { Database } from "../services/feed/database.ts";
import { withPublisherDatabase } from "./database-publication.ts";
import { loadPublicationState } from "./release-publication.ts";

const runSchema = z.object({ runID: z.uuid(), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().optional(),
  state: z.enum(["running", "succeeded", "failed"]), published: z.boolean(), version: z.string().optional() });
const states = new Set(["ok", "success", "succeeded", "failed", "error", "skipped", "disabled", "retired", "unavailable", "complete", "partial", "budget-exhausted", "cached"]);

/** Only bounded numeric counters and known states enter SQL; raw errors and URLs stay out. */
function counters(value: unknown, depth = 0): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return {};
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 64)) {
    if (!/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/.test(key)) continue;
    if (typeof child === "number" && Number.isSafeInteger(child) && child >= 0 && child <= 100000000) result[key] = child;
    else if (key === "status" && typeof child === "string" && states.has(child)) result[key] = child;
    else if (child && typeof child === "object" && !Array.isArray(child)) {
      const nested = counters(child, depth + 1); if (Object.keys(nested).length) result[key] = nested;
    }
  }
  return result;
}

export async function recordDatabaseRun(db: Database, raw: Record<string, unknown>): Promise<void> {
  const run = runSchema.parse(raw);
  const counts = JSON.stringify(counters(raw.counts)), sources = JSON.stringify(counters(raw.sources));
  if (Buffer.byteLength(counts) > 64000 || Buffer.byteLength(sources) > 64000) throw new Error("Run summary exceeds byte limit");
  const result = await db.query(`insert into prompix.ingest_runs(id,started_at,finished_at,state,published,release_id,counts,sources,failure_code)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9)
    on conflict(id) do update set finished_at=excluded.finished_at,state=excluded.state,published=excluded.published,
      release_id=excluded.release_id,counts=excluded.counts,sources=excluded.sources,failure_code=excluded.failure_code
    where prompix.ingest_runs.started_at=excluded.started_at and
      (prompix.ingest_runs.state='running' or prompix.ingest_runs.state=excluded.state or excluded.state='failed') returning id`,
  [run.runID, run.startedAt, run.finishedAt ?? null, run.state, run.published,
    run.version && /^feed-[a-f0-9]{64}$/.test(run.version) ? run.version : null, counts, sources,
    raw.statusWriteError ? "status_persistence_failed" : run.state === "failed" ? "run_failed" : null]);
  if (result.rows.length !== 1) throw new Error("Run audit state conflict");
}

export async function auditDailyRun(root: string, record: Record<string, unknown>): Promise<void> {
  const state = await loadPublicationState(root);
  if (process.env.PROMPIX_DATABASE_ENABLED !== "true" && !state.databaseInitialized && !state.pending?.database) return;
  await withPublisherDatabase(db => recordDatabaseRun(db, record));
}
