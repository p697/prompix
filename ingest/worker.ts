import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { trustSystemCertificates } from "./models/http.ts";
import { appendEvent, pipelineRoot, processAlive, readConfig, readEvents, readWorkerStatus, writeWorkerStatus, type PipelineConfig, type WorkerStatus } from "./pipeline-control.ts";
import { contentRoot, json, repo } from "./publication.ts";
import { pipelineEnvironment, runMaintenance } from "./worker-maintenance.ts";
import { collectDailyReport, sendAlert, sendDailyReport } from "./daily-report.ts";

export const retryAfterFailureMs = 30 * 60000;
const dayMs = 24 * 3600000, intakeTimeoutMs = 3 * 3600000;
/** One nightly run, in UTC; the owner is in Japan (UTC+9): source maintenance at 02:45, the intake
 * at 03:00 and the report at 08:30 local time. A failed job retries every 30 minutes, three times. */
export const nightly = { maintenance: 17.75 * 3600000, intake: 18 * 3600000, report: 23.5 * 3600000 } as const;
export const maxAttempts = 3;
const tickMs = 60000;

export type JobResult = string | { summary: string; published?: number; details?: Record<string, unknown> };
/** A daily job: `at` is its time after 00:00 UTC. `enabled` gates it on the desired state (source
 * maintenance ignores it). `onGiveUp` hears about the last failed attempt of a day. */
export type Job = { name: string; at: number; enabled?: (config: PipelineConfig) => boolean;
  /** On-demand jobs replace the nightly slot with their own readiness check. */
  ready?: (last: NonNullable<WorkerStatus["jobs"]>[string] | undefined) => Promise<boolean>;
  run: (attempt: number) => Promise<JobResult>; onGiveUp?: (message: string) => Promise<void> };
type Clock = { now: () => number };

/** The most recent daily slot at or before now. */
export function slotStart(at: number, now: number) { return Math.floor((now - at) / dayMs) * dayMs + at; }

/** Due once per daily slot: never ran, ran before the current slot (also catching up after the
 * Mac was off), was cut off, or failed with attempts left and its 30-minute backoff waited out. */
export function jobDue(job: Pick<Job, "name" | "at">, status: WorkerStatus | undefined, now: number): boolean {
  const last = status?.jobs?.[job.name];
  if (!last) return true;
  const started = Date.parse(last.startedAt);
  if (!last.finishedAt || started < slotStart(job.at, now)) return true;
  return last.ok === false && (last.attempts ?? 1) < maxAttempts && now - started >= retryAfterFailureMs;
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
  let job: Job | undefined;
  for (const candidate of jobs) {
    if (!(candidate.enabled?.(config) ?? true)) continue;
    if (candidate.ready ? await candidate.ready(base.jobs?.[candidate.name]) : jobDue(candidate, base, clock.now())) { job = candidate; break; }
  }
  if (!job) return;
  const prior = base.jobs?.[job.name];
  const attempts = prior?.ok === false && Date.parse(prior.startedAt) >= slotStart(job.at, clock.now()) ? (prior.attempts ?? 1) + 1 : 1;
  const running = { ...base.jobs, [job.name]: { startedAt: at, attempts } };
  await writeWorkerStatus(root, { ...base, stage: job.name, jobs: running });
  // A job can run for hours; the heartbeat keeps going so the worker never looks gone.
  let beats = Promise.resolve();
  const beat = setInterval(() => { beats = beats.then(() => writeWorkerStatus(root, { ...base, stage: job.name, jobs: running,
    heartbeatAt: new Date(clock.now()).toISOString() })).catch(() => undefined); }, tickMs);
  const settle = async () => { clearInterval(beat); await beats; };
  try {
    const result = await job.run(attempts).finally(settle), summary = typeof result === "string" ? result : result.summary;
    const published = typeof result === "string" ? 0 : result.published ?? 0;
    const finishedAt = new Date(clock.now()).toISOString();
    const today = base.today.date === finishedAt.slice(0, 10) ? { ...base.today, published: base.today.published + published } : base.today;
    await writeWorkerStatus(root, { ...base, today, heartbeatAt: finishedAt, jobs: { ...running, [job.name]: { startedAt: at, attempts, finishedAt, ok: true, summary: summary.slice(0, 500) } } });
    await appendEvent(root, "worker", "job.finished", { job: job.name, summary, durationMs: Date.parse(finishedAt) - Date.parse(at), published,
      ...(typeof result === "string" ? {} : result.details ?? {}) });
  } catch (error) {
    const finishedAt = new Date(clock.now()).toISOString(), message = (error as Error).message.slice(0, 500);
    await writeWorkerStatus(root, { ...base, heartbeatAt: finishedAt, lastError: { at: finishedAt, message: `${job.name}: ${message}` },
      jobs: { ...running, [job.name]: { startedAt: at, attempts, finishedAt, ok: false, summary: message } } });
    await appendEvent(root, "worker", "job.failed", { job: job.name, error: message, durationMs: Date.parse(finishedAt) - Date.parse(at) });
    if (attempts >= maxAttempts && job.onGiveUp) await job.onGiveUp(message).catch(error =>
      appendEvent(root, "worker", "alert.failed", { job: job.name, error: (error as Error).message.slice(0, 300) }));
  }
}

export function maintenanceJob(env: NodeJS.ProcessEnv): Job {
  return { name: "maintenance", at: nightly.maintenance, run: async () => {
    const report = await runMaintenance(env);
    const x = report.x as { recheck?: { checked?: number; verified?: number } } | undefined;
    return `X 复查 ${x?.recheck?.checked ?? 0} 条，确认在线 ${x?.recheck?.verified ?? 0} 条；来源已删 ${report.removed} 条，本次下架 ${report.takenDown.length} 条`;
  } };
}

type IntakeReport = { published?: boolean; error?: string; changes?: { added?: { total?: number } };
  editorial?: { requests?: number }; visualReview?: { requests?: number };
  sources?: { enrichment?: { enriched?: number; excluded?: number; deferred?: number } } };

/** The owner's 08:30 email about the 24 hours before it, which hold that night's run. Nothing is
 * sent before the worker's first intake, or when that day's report was already sent by hand. */
export function reportJob(env: NodeJS.ProcessEnv, root = pipelineRoot(), send = sendDailyReport, clock: Clock = { now: Date.now }): Job {
  return { name: "report", at: nightly.report, run: async () => {
    const end = slotStart(nightly.report, clock.now()), start = end - dayMs;
    const events = await readEvents(root, Number.MAX_SAFE_INTEGER);
    if (!events.some(event => event.job === "intake" && Date.parse(event.at) < end)) return "每日采集还没开始，不发日报";
    const report = await collectDailyReport(start, end, env, root);
    if (events.some(event => event.type === "report.sent" && event.date === report.date && event.fullDay)) return `${report.date} 的日报已经手动发过`;
    await send(report, env);
    return `已发送 ${report.date} 的日报${report.ok ? "" : "（有问题）"}`;
  } };
}

/** Collection, editorial and visual review, the 2.0 review, translation and publication: the
 * daily pipeline in its own process, with every existing gate. Translation uses the pipeline's
 * translate route; history campaigns are not drained here, since their items have no 2.0 review.
 * Runs nightly while the desired state is running. The content directory lives on the external
 * drive: a missing drive is reported at once, and the third failed attempt sends an alert. */
export function intakeJob(env: NodeJS.ProcessEnv, spawnDaily = runDaily, alert = sendAlert, root = contentRoot): Job {
  return { name: "intake", at: nightly.intake, enabled: config => config.desired === "running" && config.dailyTarget > 0,
    onGiveUp: message => alert(`每日采集发布今天连续 ${maxAttempts} 次失败，今天不会再重试。最后一次的错误：${message}`, env),
    run: async attempt => {
      if (!await access(root).then(() => true, () => false)) {
        const message = `内容目录 ${root} 读不到，外置硬盘可能没有连接`;
        if (attempt === 1) await alert(`${message}。接上硬盘后，管线会在 30 分钟内自动重试。`, env);
        throw new Error(message);
      }
      const { PROMPIX_HISTORY_CAMPAIGN: _, ...rest } = env;
      const code = await spawnDaily({ ...rest, PROMPIX_TRANSLATION_PROVIDER: "pipeline" });
      const report = await json<IntakeReport>(join(root, "status.json"), {});
      if (code !== 0) throw new Error(report.error ?? `daily exited with ${code}`);
      const added = report.changes?.added?.total ?? 0, enrichment = report.sources?.enrichment;
      return { published: added, summary: `新发布 ${added} 条；2.0 审核通过 ${enrichment?.enriched ?? 0} 条，排除 ${enrichment?.excluded ?? 0} 条，顺延 ${enrichment?.deferred ?? 0} 条`,
        // Subscription calls outside the provider layer, for the daily report.
        details: { editorialRequests: report.editorial?.requests ?? 0, visualRequests: report.visualReview?.requests ?? 0,
          excluded: enrichment?.excluded ?? 0 } };
    } };
}

export const trialRequestFile = "trial-request.json";
/** A trial of the new pipeline, run when requested (`npm run pipeline -- trial`): real search,
 * review and translation, nothing published. Never retried on its own; request it again. */
export function trialJob(env: NodeJS.ProcessEnv, root = pipelineRoot(), spawnTrial = (environment: NodeJS.ProcessEnv) => runScript("ingest/trial.ts", environment)): Job {
  return { name: "trial", at: 0,
    ready: async last => {
      const request = await json<{ at?: string } | null>(join(root, trialRequestFile), null);
      return !!request?.at && (!last || Date.parse(last.startedAt) < Date.parse(request.at));
    },
    run: async () => {
      const code = await spawnTrial(env);
      if (code !== 0) throw new Error(`trial exited with ${code}`);
      const finished = (await readEvents(root, 50)).filter(event => event.type === "trial.finished").at(-1);
      return `试跑完成：${JSON.stringify(finished?.counts ?? {})}`;
    } };
}

function runDaily(env: NodeJS.ProcessEnv): Promise<number> {
  return runScript("ingest/daily.ts", env, ["--publish"]);
}

function runScript(script: string, env: NodeJS.ProcessEnv, args: string[] = []): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, ...args], { cwd: repo, env, stdio: ["ignore", "inherit", "inherit"] });
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
  const startedAt = new Date().toISOString(), jobs = [maintenanceJob(env), reportJob(env, root), intakeJob(env), trialJob(env, root)];
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
