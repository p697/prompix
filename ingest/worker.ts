import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { trustSystemCertificates } from "./models/http.ts";
import { appendEvent, pipelineRoot, processAlive, readConfig, readEvents, readWorkerStatus, writeWorkerStatus, type PipelineConfig, type WorkerStatus } from "./pipeline-control.ts";
import { contentRoot, json, repo } from "./publication.ts";
import { pipelineEnvironment, runMaintenance } from "./worker-maintenance.ts";
import { collectDailyReport, reportWindowMs, sendDailyReport } from "./daily-report.ts";

/** Verifications last 24 hours, so twice a day keeps every publication unblocked. */
export const maintenanceIntervalMs = 12 * 3600000;
export const retryAfterFailureMs = 30 * 60000;
/** The daily allowances open in four cumulative UTC windows (ingest/discovery-budget.ts). */
export const intakeWindowMs = 6 * 3600000;
const intakeTimeoutMs = 3 * 3600000;
const tickMs = 60000;

export type JobResult = string | { summary: string; published?: number; details?: Record<string, unknown> };
/** `aligned` jobs run once per interval-sized UTC window instead of an interval after the last
 * run; `enabled` gates a job on the desired state (source maintenance ignores it). */
export type Job = { name: string; interval: number; aligned?: boolean; enabled?: (config: PipelineConfig) => boolean; run: () => Promise<JobResult> };
type Clock = { now: () => number };

/** True when the job never ran, its last run is older than the interval, or a failed run
 * has waited out its backoff. A run still marked as started (the worker was killed) is due. */
export function jobDue(job: Pick<Job, "name" | "interval" | "aligned">, status: WorkerStatus | undefined, now: number): boolean {
  const last = status?.jobs?.[job.name];
  if (!last) return true;
  const started = Date.parse(last.startedAt);
  if (!last.finishedAt) return true;
  if (last.ok === false) return now - started >= retryAfterFailureMs;
  return job.aligned ? Math.floor(started / job.interval) < Math.floor(now / job.interval) : now - started >= job.interval;
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
  const job = jobs.find(candidate => (candidate.enabled?.(config) ?? true) && jobDue(candidate, base, clock.now()));
  if (!job) return;
  const running = { ...base.jobs, [job.name]: { startedAt: at } };
  await writeWorkerStatus(root, { ...base, stage: job.name, jobs: running });
  // A job can run for hours; the heartbeat keeps going so the worker never looks gone.
  let beats = Promise.resolve();
  const beat = setInterval(() => { beats = beats.then(() => writeWorkerStatus(root, { ...base, stage: job.name, jobs: running,
    heartbeatAt: new Date(clock.now()).toISOString() })).catch(() => undefined); }, tickMs);
  const settle = async () => { clearInterval(beat); await beats; };
  try {
    const result = await job.run().finally(settle), summary = typeof result === "string" ? result : result.summary;
    const published = typeof result === "string" ? 0 : result.published ?? 0;
    const finishedAt = new Date(clock.now()).toISOString();
    const today = base.today.date === finishedAt.slice(0, 10) ? { ...base.today, published: base.today.published + published } : base.today;
    await writeWorkerStatus(root, { ...base, today, heartbeatAt: finishedAt, jobs: { ...running, [job.name]: { startedAt: at, finishedAt, ok: true, summary: summary.slice(0, 500) } } });
    await appendEvent(root, "worker", "job.finished", { job: job.name, summary, durationMs: Date.parse(finishedAt) - Date.parse(at), published,
      ...(typeof result === "string" ? {} : result.details ?? {}) });
  } catch (error) {
    const finishedAt = new Date(clock.now()).toISOString(), message = (error as Error).message.slice(0, 500);
    await writeWorkerStatus(root, { ...base, heartbeatAt: finishedAt, lastError: { at: finishedAt, message: `${job.name}: ${message}` },
      jobs: { ...running, [job.name]: { startedAt: at, finishedAt, ok: false, summary: message } } });
    await appendEvent(root, "worker", "job.failed", { job: job.name, error: message, durationMs: Date.parse(finishedAt) - Date.parse(at) });
  }
}

export function maintenanceJob(env: NodeJS.ProcessEnv): Job {
  return { name: "maintenance", interval: maintenanceIntervalMs, run: async () => {
    const report = await runMaintenance(env);
    const x = report.x as { recheck?: { checked?: number; verified?: number } } | undefined;
    return `X 复查 ${x?.recheck?.checked ?? 0} 条，确认在线 ${x?.recheck?.verified ?? 0} 条；来源已删 ${report.removed} 条，本次下架 ${report.takenDown.length} 条`;
  } };
}

type IntakeReport = { published?: boolean; error?: string; changes?: { added?: { total?: number } };
  editorial?: { requests?: number }; visualReview?: { requests?: number };
  sources?: { enrichment?: { enriched?: number; excluded?: number; deferred?: number };
    "translation-check"?: { passed?: number; held?: number; withheld?: number } } };

/** The owner's email for the UTC day that just ended, sent at the first tick after midnight UTC.
 * Days before the worker's first intake have nothing to report. */
export function reportJob(env: NodeJS.ProcessEnv, root = pipelineRoot(), send = sendDailyReport, clock: Clock = { now: Date.now }): Job {
  return { name: "report", interval: reportWindowMs, aligned: true, run: async () => {
    const end = Math.floor(clock.now() / reportWindowMs) * reportWindowMs;
    const intakes = (await readEvents(root, Number.MAX_SAFE_INTEGER)).filter(event => event.job === "intake" && Date.parse(event.at) < end);
    if (!intakes.length) return "每日采集还没开始，不发日报";
    const report = await collectDailyReport(end - reportWindowMs, end, env, root);
    await send(report, env);
    return `已发送 ${report.date} 的日报${report.ok ? "" : "（有问题）"}`;
  } };
}

/** Collection, editorial and visual review, the 2.0 review, translation and publication: the
 * daily pipeline in its own process, with every existing gate and allowance. Translation uses
 * the pipeline's translate route; history campaigns are not drained here, since their items
 * have no 2.0 review. Runs only while the desired state is running. */
export function intakeJob(env: NodeJS.ProcessEnv, spawnDaily = runDaily): Job {
  return { name: "intake", interval: intakeWindowMs, aligned: true, enabled: config => config.desired === "running" && config.dailyTarget > 0, run: async () => {
    const { PROMPIX_HISTORY_CAMPAIGN: _, ...rest } = env;
    const code = await spawnDaily({ ...rest, PROMPIX_TRANSLATION_PROVIDER: "pipeline" });
    const report = await json<IntakeReport>(join(contentRoot, "status.json"), {});
    if (code !== 0) throw new Error(report.error ?? `daily exited with ${code}`);
    const added = report.changes?.added?.total ?? 0, enrichment = report.sources?.enrichment, check = report.sources?.["translation-check"];
    return { published: added, summary: `新发布 ${added} 条；2.0 审核通过 ${enrichment?.enriched ?? 0} 条，排除 ${enrichment?.excluded ?? 0} 条，顺延 ${enrichment?.deferred ?? 0} 条`,
      // Subscription calls outside the provider layer, for the daily report.
      details: { editorialRequests: report.editorial?.requests ?? 0, visualRequests: report.visualReview?.requests ?? 0,
        excluded: enrichment?.excluded ?? 0, translationsHeld: check?.held ?? 0 } };
  } };
}

function runDaily(env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "ingest/daily.ts", "--publish"], { cwd: repo, env, stdio: ["ignore", "inherit", "inherit"] });
    const timer = setTimeout(() => child.kill("SIGTERM"), intakeTimeoutMs);
    child.on("error", reject);
    child.on("exit", code => { clearTimeout(timer); resolve(code ?? 1); });
  });
}

/** This Mac inspects HTTPS with a root kept in the system keychain. The worker trusts it
 * in-process (trustSystemCertificates), but Node children, including the wrangler uploads the
 * daily pipeline runs, only accept it from a file: export the keychain roots for them. */
export async function childCertificates(root: string): Promise<NodeJS.ProcessEnv> {
  if (process.env.NODE_EXTRA_CA_CERTS || process.platform !== "darwin") return {};
  const { stdout } = await promisify(execFile)("/usr/bin/security", ["find-certificate", "-a", "-p",
    "/Library/Keychains/System.keychain", "/System/Library/Keychains/SystemRootCertificates.keychain"], { maxBuffer: 16 * 1024 * 1024 });
  const path = join(root, "system-roots.pem");
  await writeFile(path, stdout, { mode: 0o600 });
  return { NODE_EXTRA_CA_CERTS: path };
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
  const env = { ...await pipelineEnvironment(), ...await childCertificates(root) };
  // Maintenance first: it keeps the verifications every publication requires current.
  const startedAt = new Date().toISOString(), jobs = [maintenanceJob(env), reportJob(env, root), intakeJob(env)];
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
