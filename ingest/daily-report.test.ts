import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDailyReport, sendDailyReport } from "./daily-report.ts";
import type { PipelineEvent } from "./pipeline-control.ts";

const start = Date.parse("2026-11-06T00:00:00Z"), end = start + 24 * 3600000;
let n = 0;
const event = (at: string, type: string, details: Record<string, unknown>): PipelineEvent => ({ id: String(++n), at, actor: "worker", type, ...details });

test("the report leads with the outcome and covers changes, work, time and cost", () => {
  const report = buildDailyReport({ start, end, target: 100, desired: "running", xSpendUSD: 0.05,
    database: { added: 80, removed: 1, live: 3645 }, events: [
      event("2026-11-05T23:00:00Z", "job.finished", { job: "intake", summary: "outside the window", durationMs: 1 }),
      event("2026-11-06T00:30:00Z", "job.failed", { job: "intake", error: "network", durationMs: 60000 }),
      event("2026-11-06T01:10:00Z", "job.finished", { job: "intake", summary: "新发布 80 条", durationMs: 3600000, published: 80,
        excluded: 4, translationsHeld: 2, editorialRequests: 12, visualRequests: 6 }),
      event("2026-11-06T01:15:00Z", "job.finished", { job: "maintenance", summary: "X 复查 60 条", durationMs: 120000 }),
      event("2026-11-06T01:00:00Z", "model.call", { actor: "pipeline", stage: "review", provider: "anthropic-api", model: "claude-haiku-5-5", usage: { inputTokens: 1_000_000, outputTokens: 0 } }),
      event("2026-11-06T01:00:00Z", "model.call", { actor: "pipeline", stage: "translationCheck", provider: "anthropic-api", model: "claude-sonnet-5-5", usage: { inputTokens: 100_000, outputTokens: 10_000 } }),
      event("2026-11-06T01:00:00Z", "model.call", { actor: "pipeline", stage: "translate", provider: "codex-cli", model: "gpt-6.1-terra", usage: {} }),
      event("2026-11-06T01:00:00Z", "route.fallback", { stage: "translate" }),
      event("2026-11-06T02:00:00Z", "model.call", { actor: "claude-code", stage: "review", provider: "anthropic-api", model: "claude-sonnet-5-5", usage: { inputTokens: 1_000_000 } }),
      event("2026-11-06T03:00:00Z", "job.finished", { job: "maintenance", summary: "old run" }),
    ] });
  assert.equal(report.ok, true, "a failure followed by a success has recovered");
  assert.equal(report.date, new Date(end).toLocaleDateString("sv-SE"), "named after the morning it is read");
  const text = report.text;
  assert.match(text, /^结论：每日任务正常完成/);
  assert.match(text, /新增 80 条，其中每日流程发布 80 条（每日目标 100，差 20 条）/);
  assert.match(text, /下架 1 条，线上共 3645 条/);
  assert.match(text, /审核自动排除 4 条/);
  assert.match(text, /每日采集发布：2 次（成功 1，失败 1），用时 1 小时 1 分钟/);
  assert.match(text, /合计用时 1 小时 3 分钟（另有 1 次没有记录用时）/);
  assert.match(text, /其他会话的模型调用（例如补库）：1 次，\$2\.00/);
  assert.match(text, /曾失败 1 次，之后已自动恢复/);
  assert.match(text, /备用模型 1 次/);
  assert.match(text, /每日流程的模型 API：\$0\.40/);
  assert.match(text, /Codex 订阅：翻译 1 次，编辑审核 12 次，图片审核 6 次/);
  assert.match(text, /按量付费合计：\$2\.45/);
  assert.doesNotMatch(text, /outside the window/);
});

test("a last failure, no successful intake or unreadable data marks the day as having problems", () => {
  const failed = buildDailyReport({ start, end, target: 100, desired: "running", databaseError: "timeout",
    events: [event("2026-11-06T06:00:00Z", "job.failed", { job: "intake", error: "boom", durationMs: 1000 })] });
  assert.equal(failed.ok, false);
  assert.match(failed.text, /^结论：有问题，每日采集发布最近一次失败；这一天没有成功完成的每日采集发布；读取线上数据失败：timeout/);
  const idle = buildDailyReport({ start, end, target: 100, desired: "running", database: { added: 500, removed: 0, live: 1 },
    events: [event("2026-11-06T06:00:00Z", "job.finished", { job: "intake", summary: "新发布 0 条", durationMs: 1000 })] });
  assert.match(idle.text, /^结论：有问题，每日流程这一天没有发布新内容/);
  assert.match(idle.text, /新增 500 条，其中每日流程发布 0 条/);
  assert.equal(buildDailyReport({ start, end, target: 100, desired: "stopped", database: { added: 0, removed: 0, live: 1 }, events: [] }).ok, true);
});

test("newly stalled items are a problem; the funnel section names the largest stalled groups", () => {
  const funnel = { at: new Date(end).toISOString(), total: 10, counts: { live: 5, removed: 0, excluded: 1, waiting: 2, stalled: 2 }, bySource: {},
    newlyStalled: 1, stalled: [{ reason: "编辑审核暂缓：内容类型对不上", stage: "editorial" as const, count: 2 }] };
  const report = buildDailyReport({ start, end, target: 100, desired: "stopped", database: { added: 0, removed: 0, live: 5 }, events: [], funnel });
  assert.equal(report.ok, false);
  assert.match(report.text, /^结论：有问题，1 条内容新进入悬空状态/);
  assert.match(report.text, /排队中 2 条，悬空 2 条（这一天新增 1 条）\n  · 2 条：编辑审核暂缓：内容类型对不上/);
  assert.equal(buildDailyReport({ start, end, target: 100, desired: "stopped", database: { added: 0, removed: 0, live: 5 }, events: [],
    funnel: { ...funnel, newlyStalled: 0 } }).ok, true);
});

test("delivery goes to the monitor's report endpoint with the shared secret and retries server errors", async () => {
  const calls: { url: string; auth: string | null }[] = [];
  let status = 503;
  const fetcher = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init.headers).get("Authorization") });
    const response = new Response(null, { status }); status = 200; return response;
  }) as unknown as typeof fetch;
  await sendDailyReport({ date: "2026-11-06", ok: true, text: "x" }, { PROMPIX_MONITOR_URL: "https://monitor.example/heartbeat", PROMPIX_MONITOR_SECRET: "s" }, fetcher);
  assert.deepEqual(calls, [{ url: "https://monitor.example/report", auth: "Bearer s" }, { url: "https://monitor.example/report", auth: "Bearer s" }]);
  await assert.rejects(sendDailyReport({ date: "2026-11-06", ok: true, text: "x" }, {}), /not configured/);
});
