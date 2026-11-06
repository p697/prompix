import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { reportSchema, type DailyReport } from "../services/monitor/report.ts";
import { withPublisherDatabase } from "./database-publication.ts";
import { estimateUSD } from "./models/pricing.ts";
import type { ModelUsage } from "./models/types.ts";
import { pipelineRoot, readConfig, readEvents, stageLabels, type PipelineEvent, type PipelineStage } from "./pipeline-control.ts";

export const reportWindowMs = 24 * 3600000;
export type ReportInput = { start: number; end: number; target: number; desired: string; events: readonly PipelineEvent[];
  database?: { added: number; removed: number; live: number }; databaseError?: string; xSpendUSD?: number };

const jobNames: Record<string, string> = { intake: "每日采集发布", maintenance: "来源维护复查" };
const local = (at: number) => new Date(at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const clock = (at: string) => new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
const usd = (value: number) => `$${value.toFixed(2)}`;
function duration(ms: number) {
  const minutes = Math.round(ms / 60000);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

/** The owner's daily summary: outcome first, then what changed online, what ran, and cost. */
export function buildDailyReport(input: ReportInput): DailyReport {
  const events = input.events.filter(event => { const at = Date.parse(event.at); return at >= input.start && at < input.end; });
  const runs = events.filter(event => (event.type === "job.finished" || event.type === "job.failed") && event.job !== "report");
  const problems: string[] = [], notes: string[] = [];
  const done: string[] = [];
  let total = 0, excluded = 0, held = 0, editorial = 0, visual = 0;
  for (const name of [...new Set(runs.map(event => String(event.job)))]) {
    const own = runs.filter(event => event.job === name), failed = own.filter(event => event.type === "job.failed");
    const spent = own.reduce((sum, event) => sum + Number(event.durationMs ?? 0), 0);
    total += spent;
    done.push(`- ${jobNames[name] ?? name}：${own.length} 次（成功 ${own.length - failed.length}，失败 ${failed.length}），用时 ${duration(spent)}`);
    for (const event of own) done.push(`  · ${clock(event.at)} ${event.type === "job.failed" ? `失败：${String(event.error).slice(0, 160)}` : event.summary}`);
    if (own.at(-1)?.type === "job.failed") problems.push(`${jobNames[name] ?? name}最近一次失败`);
    else if (failed.length) notes.push(`${jobNames[name] ?? name}曾失败 ${failed.length} 次，之后已自动恢复`);
    for (const event of own) {
      excluded += Number(event.excluded ?? 0); held += Number(event.translationsHeld ?? 0);
      editorial += Number(event.editorialRequests ?? 0); visual += Number(event.visualRequests ?? 0);
    }
  }
  if (input.desired === "running" && !runs.some(event => event.job === "intake" && event.type === "job.finished")) problems.push("这一天没有成功完成的每日采集发布");
  if (input.databaseError) problems.push(`读取线上数据失败：${input.databaseError.slice(0, 160)}`);

  // Metered calls are priced; subscription calls are counted by stage.
  const metered = new Map<string, { calls: number; usd: number }>(), subscription = new Map<string, number>();
  for (const event of events.filter(event => event.type === "model.call")) {
    const model = String(event.model), stage = stageLabels[event.stage as PipelineStage] ?? String(event.stage);
    const cost = estimateUSD(model, event.usage as ModelUsage | undefined);
    if (event.provider === "codex-cli" || event.provider === "claude-cli" || event.provider === "kimi-code") subscription.set(stage, (subscription.get(stage) ?? 0) + 1);
    else { const key = `${stage} ${model}`, entry = metered.get(key) ?? { calls: 0, usd: 0 }; entry.calls++; entry.usd += cost; metered.set(key, entry); }
  }
  if (editorial) subscription.set("编辑审核", editorial);
  if (visual) subscription.set("图片审核", visual);
  const fallbacks = events.filter(event => event.type === "route.fallback").length;
  if (fallbacks) notes.push(`主模型不可用时改用备用模型 ${fallbacks} 次`);
  const apiUSD = [...metered.values()].reduce((sum, entry) => sum + entry.usd, 0), xUSD = input.xSpendUSD ?? 0;

  const added = input.database?.added;
  const lines = [
    `结论：${problems.length ? `有问题，${problems.join("；")}` : "每日任务正常完成"}`,
    `统计时段：${local(input.start)} – ${local(input.end)}（本机时间）`,
    "",
    "线上变化",
    input.database ? `- 新增 ${added} 条（目标 ${input.target}）${added! < input.target ? `，差 ${input.target - added!} 条` : ""}` : "- 新增：读取失败",
    ...(input.database ? [`- 下架 ${input.database.removed} 条，线上共 ${input.database.live} 条`] : []),
    `- 2.0 审核自动排除 ${excluded} 条，译文复核拦下 ${held} 处`,
    "",
    "做了哪些事",
    ...(done.length ? done : ["- 没有运行任何任务"]),
    `- 合计用时 ${duration(total)}`,
    ...(notes.length ? ["", "备注", ...notes.map(note => `- ${note}`)] : []),
    "",
    "成本（估算）",
    `- 模型 API：${usd(apiUSD)}${metered.size ? `（${[...metered].map(([key, entry]) => `${key} ${entry.calls} 次 ${usd(entry.usd)}`).join("；")}）` : ""}`,
    `- X 接口（twitterapi.io）：${usd(xUSD)}`,
    ...(subscription.size ? [`- Codex 订阅：${[...subscription].map(([stage, calls]) => `${stage} ${calls} 次`).join("，")}（订阅内，不单独计费）`] : []),
    `- 按量付费合计：${usd(apiUSD + xUSD)}`,
  ];
  return reportSchema.parse({ date: new Date(input.start).toISOString().slice(0, 10), ok: problems.length === 0, text: lines.join("\n") });
}

/** Completed X provider spend recorded by the shared ledger, in USD. */
async function xSpend(start: number, end: number, environment: NodeJS.ProcessEnv) {
  const directory = environment.PROMPIX_X_SPEND_DIR ?? join(homedir(), ".local/share/prompix/x-spend");
  let micro = 0;
  for (const month of new Set([new Date(start).toISOString().slice(0, 7), new Date(end - 1).toISOString().slice(0, 7)])) {
    const ledger = await readFile(join(directory, `${month}.json`), "utf8").then(text => JSON.parse(text) as { entries?: { at: string; accounted?: number }[] }, () => ({ entries: [] }));
    for (const entry of ledger.entries ?? []) { const at = Date.parse(entry.at); if (at >= start && at < end) micro += entry.accounted ?? 0; }
  }
  return micro / 1e6;
}

export async function collectDailyReport(start: number, end: number, environment: NodeJS.ProcessEnv, root = pipelineRoot()): Promise<DailyReport> {
  const config = await readConfig(root);
  const input: ReportInput = { start, end, target: config.dailyTarget, desired: config.desired, events: await readEvents(root, Number.MAX_SAFE_INTEGER),
    xSpendUSD: await xSpend(start, end, environment) };
  try {
    input.database = await withPublisherDatabase(async db => (await db.query<{ added: number; removed: number; live: number }>(`select
      count(*) filter (where first_published_at >= $1 and first_published_at < $2)::integer as added,
      count(*) filter (where removed_at >= $1 and removed_at < $2)::integer as removed,
      count(*) filter (where first_published_at is not null and removed_at is null)::integer as live
      from prompix.content`, [new Date(start).toISOString(), new Date(end).toISOString()])).rows[0], environment);
  } catch (error) { input.databaseError = (error as Error).message; }
  return buildDailyReport(input);
}

/** Delivered by the monitor Worker to its configured recipient; the endpoint sits beside the heartbeat. */
export async function sendDailyReport(report: DailyReport, environment: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch) {
  const endpoint = environment.PROMPIX_MONITOR_URL, secret = environment.PROMPIX_MONITOR_SECRET;
  if (!endpoint || !secret) throw new Error("The monitor is not configured; the report was not sent");
  const url = new URL("/report", endpoint);
  if (url.protocol !== "https:") throw new Error("Invalid monitor endpoint");
  for (let attempt = 0; ; attempt++) {
    const response = await fetcher(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify(report) }).catch(() => undefined);
    await response?.body?.cancel();
    if (response?.ok) return;
    if (attempt === 2 || (response && response.status < 500 && response.status !== 429)) throw new Error(`Report delivery failed (${response?.status ?? "network"})`);
    await new Promise(resolve => setTimeout(resolve, [2000, 6000][attempt]));
  }
}
