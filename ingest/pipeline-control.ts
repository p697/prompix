import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { providerIds } from "./models/types.ts";

/** The control plane is a directory any agent can read or change through the pipeline CLI:
 * config.json is the desired state, status.json is what the worker last reported, and
 * events.jsonl is an append-only record of every change and every model call. */

export const pipelineStages = ["prefilter", "review", "safety", "translate", "translationCheck"] as const;
export type PipelineStage = typeof pipelineStages[number];

export const stageLabels: Record<PipelineStage, string> = {
  prefilter: "预筛（只看文字）", review: "合并审核（图和文字）", safety: "安全复核", translate: "翻译", translationCheck: "翻译检查",
};

const routeSchema = z.object({
  provider: z.enum(providerIds),
  model: z.string().min(1).max(120).optional(),
  effort: z.enum(["low", "medium", "high"]).optional(),
}).strict();
export type StageRoute = z.infer<typeof routeSchema>;

export const pipelineConfigSchema = z.object({
  version: z.literal(1),
  desired: z.enum(["stopped", "running", "paused"]),
  dailyTarget: z.number().int().min(0).max(1000),
  routing: z.object(Object.fromEntries(pipelineStages.map(stage => [stage, routeSchema])) as Record<PipelineStage, typeof routeSchema>).strict(),
  legacyContentDir: z.string().min(1),
  updatedAt: z.string(),
  updatedBy: z.string(),
}).strict();
export type PipelineConfig = z.infer<typeof pipelineConfigSchema>;

export const workerStatusSchema = z.object({
  pid: z.number().int(),
  startedAt: z.string(),
  heartbeatAt: z.string(),
  state: z.enum(["running", "paused", "idle", "stopping"]),
  stage: z.string().optional(),
  today: z.object({ date: z.string(), published: z.number().int(), reviewed: z.number().int(), held: z.number().int(), rejected: z.number().int() }),
  lastError: z.object({ at: z.string(), message: z.string() }).optional(),
}).strict();
export type WorkerStatus = z.infer<typeof workerStatusSchema>;

export type PipelineEvent = { id: string; at: string; actor: string; type: string } & Record<string, unknown>;

export const pipelineRoot = () => process.env.PROMPIX_PIPELINE_DIR ?? join(homedir(), ".local/share/prompix/pipeline");

/** Codex subscription carries the heavy stages by default, matching the owner's routing. */
export function defaultPipelineConfig(now = new Date()): PipelineConfig {
  return {
    version: 1, desired: "stopped", dailyTarget: 100,
    routing: {
      prefilter: { provider: "codex-cli", model: "gpt-5.6-luna", effort: "low" },
      review: { provider: "codex-cli", model: "gpt-5.6-luna", effort: "low" },
      // A ChatGPT-account Codex login serves only the models Codex lists for it
      // (gpt-6-astra and gpt-5.6-sol/terra/luna on 2026-11-06); gpt-6.1-sol and gpt-6-luna are refused.
      safety: { provider: "codex-cli", model: "gpt-6-astra", effort: "medium" },
      translate: { provider: "codex-cli", model: "gpt-5.6-terra", effort: "low" },
      translationCheck: { provider: "codex-cli", model: "gpt-6-astra", effort: "medium" },
    },
    legacyContentDir: process.env.PROMPIX_CONTENT_DIR ?? join(homedir(), ".local/share/prompix/content"),
    updatedAt: now.toISOString(), updatedBy: "default",
  };
}

async function writeAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}

export async function readConfig(root = pipelineRoot()): Promise<PipelineConfig> {
  const text = await readFile(join(root, "config.json"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  return text === undefined ? defaultPipelineConfig() : pipelineConfigSchema.parse(JSON.parse(text));
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** One writer at a time. A lock whose owner has exited is taken over, so a killed agent
 * never leaves the pipeline unchangeable. */
async function withLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true });
  const path = join(root, "config.lock");
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await handle.close();
      try { return await work(); } finally { await rm(path, { force: true }); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readFile(path, "utf8").then(text => JSON.parse(text) as { pid?: number }, () => ({} as { pid?: number }));
      const age = Date.now() - (await stat(path).then(info => info.mtimeMs, () => Date.now()));
      if (!owner.pid || !processAlive(owner.pid) || age > 60000) { await rm(path, { force: true }); continue; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error("配置正被另一个进程修改，请稍后再试");
}

export async function appendEvent(root: string, actor: string, type: string, details: Record<string, unknown> = {}): Promise<PipelineEvent> {
  const event: PipelineEvent = { id: randomUUID(), at: new Date().toISOString(), actor, type, ...details };
  await mkdir(root, { recursive: true });
  await appendFile(join(root, "events.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
  return event;
}

export async function readEvents(root = pipelineRoot(), tail = 20): Promise<PipelineEvent[]> {
  const text = await readFile(join(root, "events.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).slice(-tail).flatMap(line => { try { return [JSON.parse(line) as PipelineEvent]; } catch { return []; } });
}

/** Applies a change, validates the whole result and records who changed what and why. */
export async function updateConfig(root: string, actor: string, reason: string | undefined, change: (config: PipelineConfig) => PipelineConfig): Promise<{ before: PipelineConfig; after: PipelineConfig }> {
  if (!actor.trim()) throw new Error("请用 --by 说明是谁在修改");
  return withLock(root, async () => {
    const before = await readConfig(root);
    const after = pipelineConfigSchema.parse({ ...change(structuredClone(before)), updatedAt: new Date().toISOString(), updatedBy: actor });
    await writeAtomic(join(root, "config.json"), after);
    await appendEvent(root, actor, "config.changed", { reason, changes: diffConfig(before, after) });
    return { before, after };
  });
}

export function diffConfig(before: PipelineConfig, after: PipelineConfig): { path: string; from: unknown; to: unknown }[] {
  const changes: { path: string; from: unknown; to: unknown }[] = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (key !== "updatedAt" && key !== "updatedBy") walk((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
      }
    } else if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ path, from: a, to: b });
  };
  walk(before, after, "");
  return changes;
}

export async function writeWorkerStatus(root: string, status: WorkerStatus) {
  await writeAtomic(join(root, "status.json"), workerStatusSchema.parse(status));
}

export async function readWorkerStatus(root = pipelineRoot()): Promise<WorkerStatus | undefined> {
  const text = await readFile(join(root, "status.json"), "utf8").catch(() => undefined);
  if (!text) return undefined;
  const parsed = workerStatusSchema.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : undefined;
}

export type LegacyState = {
  scheduled: boolean;
  lastRun?: { runID?: string; state?: string; startedAt?: string; finishedAt?: string };
  lock?: { pid?: number; alive: boolean; since: string };
};

export type LegacyProbe = { launchdLoaded(label: string): boolean };
export const systemLegacyProbe: LegacyProbe = {
  launchdLoaded: label => process.platform === "darwin" && typeof process.getuid === "function"
    && spawnSync("launchctl", ["print", `gui/${process.getuid()}/${label}`], { stdio: "ignore" }).status === 0,
};

/** The cron-driven daily job that predates the worker. Reported so no agent mistakes a
 * stale "running" file or an orphaned lock for live work. */
export async function legacyState(contentDir: string, probe: LegacyProbe = systemLegacyProbe): Promise<LegacyState> {
  const status = await readFile(join(contentDir, "status.json"), "utf8").then(text => JSON.parse(text) as Record<string, unknown>, () => undefined);
  const lockInfo = await stat(join(contentDir, "daily.lock")).catch(() => undefined);
  let lock: LegacyState["lock"];
  if (lockInfo) {
    const owner = await readFile(join(contentDir, "daily.lock", "owner.json"), "utf8").then(text => JSON.parse(text) as { pid?: number }, () => ({} as { pid?: number }));
    lock = { pid: owner.pid, alive: owner.pid ? processAlive(owner.pid) : false, since: lockInfo.mtime.toISOString() };
  }
  return {
    scheduled: probe.launchdLoaded("dev.prompix.collect"),
    lastRun: status && { runID: status.runID as string, state: status.state as string, startedAt: status.startedAt as string, finishedAt: status.finishedAt as string },
    lock,
  };
}

export type PipelineSnapshot = {
  root: string;
  config: PipelineConfig;
  worker?: WorkerStatus & { stale: boolean };
  legacy: LegacyState;
  events: PipelineEvent[];
};

/** A worker that has not reported for five minutes is treated as gone. */
export async function snapshot(root = pipelineRoot(), probe: LegacyProbe = systemLegacyProbe, now = Date.now()): Promise<PipelineSnapshot> {
  const config = await readConfig(root);
  const worker = await readWorkerStatus(root);
  return {
    root, config,
    worker: worker && { ...worker, stale: now - Date.parse(worker.heartbeatAt) > 5 * 60000 || !processAlive(worker.pid) },
    legacy: await legacyState(config.legacyContentDir, probe),
    events: await readEvents(root, 10),
  };
}
