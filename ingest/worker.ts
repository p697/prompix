import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { trustSystemCertificates } from "./models/http.ts";
import { appendEvent, pipelineRoot, processAlive, readConfig, readWorkerStatus, writeWorkerStatus, type WorkerStatus } from "./pipeline-control.ts";
import { pipelineEnvironment, runMaintenance } from "./worker-maintenance.ts";

/** Verifications last 24 hours, so twice a day keeps every publication unblocked. */
export const maintenanceIntervalMs = 12 * 3600000;
export const retryAfterFailureMs = 30 * 60000;
const tickMs = 60000;

export type Job = { name: string; interval: number; run: () => Promise<string> };
type Clock = { now: () => number };

/** True when the job never ran, its last run is older than the interval, or a failed run
 * has waited out its backoff. A run still marked as started (the worker was killed) is due. */
export function jobDue(job: Pick<Job, "name" | "interval">, status: WorkerStatus | undefined, now: number): boolean {
  const last = status?.jobs?.[job.name];
  if (!last) return true;
  const started = Date.parse(last.startedAt);
  if (!last.finishedAt) return true;
  return now - started >= (last.ok === false ? retryAfterFailureMs : job.interval);
}

/** One pass: heartbeat, then at most one due job. Jobs never overlap. */
export async function tick(root: string, startedAt: string, jobs: Job[], clock: Clock = { now: Date.now }) {
  const config = await readConfig(root);
  const previous = await readWorkerStatus(root);
  const at = new Date(clock.now()).toISOString();
  const state: WorkerStatus["state"] = config.desired === "running" ? "running" : config.desired === "paused" ? "paused" : "idle";
  const base: WorkerStatus = { pid: process.pid, startedAt, heartbeatAt: at, state,
    today: previous?.today.date === at.slice(0, 10) ? previous.today : { date: at.slice(0, 10), published: 0, reviewed: 0, held: 0, rejected: 0 },
    ...(previous?.jobs ? { jobs: previous.jobs } : {}), ...(previous?.lastError ? { lastError: previous.lastError } : {}) };
  await writeWorkerStatus(root, base);
  const job = jobs.find(candidate => jobDue(candidate, base, clock.now()));
  if (!job) return;
  const running = { ...base.jobs, [job.name]: { startedAt: at } };
  await writeWorkerStatus(root, { ...base, stage: job.name, jobs: running });
  try {
    const summary = await job.run();
    const finishedAt = new Date(clock.now()).toISOString();
    await writeWorkerStatus(root, { ...base, heartbeatAt: finishedAt, jobs: { ...running, [job.name]: { startedAt: at, finishedAt, ok: true, summary: summary.slice(0, 500) } } });
    await appendEvent(root, "worker", "job.finished", { job: job.name, summary });
  } catch (error) {
    const finishedAt = new Date(clock.now()).toISOString(), message = (error as Error).message.slice(0, 500);
    await writeWorkerStatus(root, { ...base, heartbeatAt: finishedAt, lastError: { at: finishedAt, message: `${job.name}: ${message}` },
      jobs: { ...running, [job.name]: { startedAt: at, finishedAt, ok: false, summary: message } } });
    await appendEvent(root, "worker", "job.failed", { job: job.name, error: message });
  }
}

export function maintenanceJob(env: NodeJS.ProcessEnv): Job {
  return { name: "maintenance", interval: maintenanceIntervalMs, run: async () => {
    const report = await runMaintenance(env);
    const x = report.x as { recheck?: { checked?: number; verified?: number } } | undefined;
    return `X 复查 ${x?.recheck?.checked ?? 0} 条，确认在线 ${x?.recheck?.verified ?? 0} 条；来源已删 ${report.removed} 条，本次下架 ${report.takenDown.length} 条`;
  } };
}

/** A second worker exits at once; a lock left by a killed worker is taken over. */
async function singleInstance(root: string): Promise<(() => Promise<void>) | undefined> {
  await mkdir(root, { recursive: true });
  const path = join(root, "worker.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await handle.close();
      return () => rm(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readFile(path, "utf8").then(text => JSON.parse(text) as { pid?: number }, () => ({} as { pid?: number }));
      if (owner.pid && owner.pid !== process.pid && processAlive(owner.pid)) return undefined;
      await rm(path, { force: true });
    }
  }
  return undefined;
}

async function main() {
  trustSystemCertificates();
  const root = pipelineRoot();
  const release = await singleInstance(root);
  if (!release) { console.log(JSON.stringify({ event: "worker_already_running" })); return; }
  const env = await pipelineEnvironment();
  const startedAt = new Date().toISOString(), jobs = [maintenanceJob(env)];
  let stopping = false, sleeping: (() => void) | undefined;
  const stop = () => { stopping = true; sleeping?.(); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  await appendEvent(root, "worker", "worker.started", { pid: process.pid });
  try {
    while (!stopping) {
      try { await tick(root, startedAt, jobs); }
      catch (error) { console.error(JSON.stringify({ event: "worker_tick_failed", message: (error as Error).message })); }
      await new Promise<void>(resolve => { sleeping = resolve; setTimeout(resolve, tickMs); });
    }
    const last = await readWorkerStatus(root);
    if (last) await writeWorkerStatus(root, { ...last, state: "stopping", heartbeatAt: new Date().toISOString() });
    await appendEvent(root, "worker", "worker.stopped", { pid: process.pid });
  } finally { await release(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
