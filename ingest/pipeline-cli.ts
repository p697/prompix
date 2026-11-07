import { parseArgs } from "node:util";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { completeValidated } from "./models/call.ts";
import { trustSystemCertificates } from "./models/http.ts";
import { createProvider, isProviderId, modelEnvironment, providerAvailability, providerDefinitions } from "./models/registry.ts";
import { ModelProviderError, providerIds, type ModelImage } from "./models/types.ts";
import { appendEvent, pipelineRoot, pipelineStages, readEvents, snapshot, stageLabels, updateConfig, type PipelineEvent, type PipelineSnapshot, type StageRoute } from "./pipeline-control.ts";
import { repo } from "./publication.ts";
import { installWorker, restartWorker, uninstallWorker, workerPlistPath } from "./worker-launchd.ts";
import { pipelineEnvironment, runMaintenance } from "./worker-maintenance.ts";
import { collectDailyReport, reportWindowMs, sendDailyReport } from "./daily-report.ts";
import { nightly, slotStart } from "./worker.ts";
import { collectItemStates, readFunnelSnapshot, saveFunnelSnapshot, summarizeFunnel, type FunnelSummary, type ItemState, type ItemStatus } from "./item-state.ts";
import { contentRoot } from "./publication.ts";

const usage = `用法：npm run pipeline -- <命令> [参数]

查看
  status [--brief] [--json]              管线现在的状态、模型路由和最近变更
  log [--tail 20] [--json]               变更和模型调用记录
  providers [--json]                     所有模型提供方，以及本机能不能用
  funnel [--json]                        每个来源的条目各在什么状态：线上、已下架、已排除、排队中、悬空
  item <id> [--json]                     一条内容现在卡在哪一步、为什么

修改（都要写 --by，说明是谁改的；可加 --reason）
  start | pause | resume | stop          设置期望状态，后台进程按它执行
  target <每天条数>                       每天目标，0–1000
  route <环节> <提供方> [--model m] [--effort low|medium|high]
        [--fallback <提供方>|none] [--fallback-model m] [--fallback-effort e]   主路由不可用或限流时改用备用；不写则保留原备用
  note <文字>                            留一条备注给其他 agent
  set legacyContentDir <路径>             旧定时任务的内容目录

测试
  test-provider <提供方> [--model m] [--image 图片路径]   发一次很小的结构化请求

后台进程（launchd 保活，开机自启；每天凌晨 2:45 来源维护复查，3:00 采集发布，8:30 发日报，均为日本时间）
  worker install | uninstall | restart   安装、卸载，或在更新代码后重启
  maintenance                            立刻做一次来源维护复查（X、ClawHub），确认已删的来源自动下架
  report [--since 时间] [--send]          生成日报（默认最近一次 08:30 之前的 24 小时；--since 到现在），--send 发到监控邮箱

环节：${pipelineStages.join(", ")}
提供方：${providerIds.join(", ")}`;

const describeTarget = (route: Omit<StageRoute, "fallback">) =>
  `${route.provider} · ${route.model ?? providerDefinitions[route.provider].defaultModel ?? "未指定模型"}${route.effort ? ` · ${route.effort}` : ""}`;
const describeRoute = (route: StageRoute) => describeTarget(route) + (route.fallback ? `（备用 ${describeTarget(route.fallback)}）` : "");
const time = (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "未知";
const ago = (value: string) => { const minutes = Math.round((Date.now() - Date.parse(value)) / 60000); return minutes < 1 ? "刚刚" : minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`; };
const stateLabels: Record<ItemState, string> = { live: "线上", removed: "已下架", excluded: "已排除", waiting: "排队中", stalled: "悬空" };
const stageNames: Record<string, string> = { source: "来源", editorial: "编辑审核", library: "上架规则", visual: "图片审核", quality: "质量暂扣", enrichment: "2.0 审核", publication: "发布" };
const states = Object.keys(stateLabels) as ItemState[];

function describeFunnel(summary: FunnelSummary): string {
  const row = (counts: Record<ItemState, number>) => states.map(state => `${stateLabels[state]} ${counts[state]}`).join(" · ");
  const sources = Object.entries(summary.bySource).sort(([a], [b]) => a.localeCompare(b)).map(([source, counts]) => `  ${source}：${row(counts)}`);
  const stalled = summary.stalled.map(group => `  ${group.count} 条  ${group.stage ? `[${stageNames[group.stage]}] ` : ""}${group.reason}`);
  return [`候选共 ${summary.total} 条：${row(summary.counts)}（${time(summary.at)}）`, "按来源：", ...sources,
    ...(stalled.length ? [`悬空原因（过去 24 小时新增 ${summary.newlyStalled} 条）：`, ...stalled] : ["没有悬空条目"]),
    "不含历史补库 campaign 里尚未上线的条目。"].join("\n");
}
const describeItem = (item: ItemStatus) => [`${item.id}（${item.source}，${item.kind}）`, `状态：${stateLabels[item.state]}${item.stage ? ` · ${stageNames[item.stage]}` : ""}`,
  `原因：${item.reason}`, ...(item.since ? [`自：${time(item.since)}`] : [])].join("\n");

const desiredLabel = { stopped: "已停止", running: "运行", paused: "暂停" } as const;
const jobLabels: Record<string, string> = { maintenance: "来源维护复查", intake: "每日采集发布", report: "每日日报" };

function describeEvent(event: PipelineEvent): string {
  const head = `${time(event.at)}  ${event.actor}`;
  if (event.type === "config.changed") {
    const changes = (event.changes as { path: string; from: unknown; to: unknown }[] | undefined) ?? [];
    return `${head}  改了 ${changes.map(change => `${change.path}: ${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}`).join("；") || "（无变化）"}${event.reason ? `（${event.reason}）` : ""}`;
  }
  if (event.type === "note") return `${head}  备注：${event.text}`;
  if (event.type === "job.finished") return `${head}  ${jobLabels[String(event.job)] ?? event.job}完成：${event.summary}`;
  if (event.type === "job.failed") return `${head}  ${jobLabels[String(event.job)] ?? event.job}失败：${event.error}`;
  if (event.type === "provider.test" || event.type === "model.call") {
    const tokens = event.usage as { inputTokens?: number; outputTokens?: number } | undefined;
    return `${head}  ${event.type === "provider.test" ? "测试" : "调用"} ${event.provider}·${event.model} ${event.ok ? "成功" : `失败（${event.error}）`} ${event.durationMs} ms${tokens?.inputTokens !== undefined ? ` · 输入 ${tokens.inputTokens} / 输出 ${tokens.outputTokens} token` : ""}`;
  }
  return `${head}  ${event.type}`;
}

function describeLegacy(state: PipelineSnapshot["legacy"]): string[] {
  const lines = [`旧的定时任务：${state.scheduled ? "已启用（launchd，每天 4 次）" : "未启用"}`];
  if (state.lastRun) {
    const stale = state.lastRun.state === "running" && !(state.lock?.alive);
    lines.push(`  上次运行：${time(state.lastRun.startedAt)} 开始，记录状态 ${state.lastRun.state}${stale ? "（进程已不在，这条记录已过期）" : ""}`);
  }
  if (state.lock) lines.push(`  锁：进程 ${state.lock.pid ?? "未知"} ${state.lock.alive ? "仍在运行" : "已退出（下次运行会自动接管）"}，自 ${time(state.lock.since)}`);
  return lines;
}

function describeStatus(view: PipelineSnapshot & { funnel?: FunnelSummary }, brief: boolean): string {
  const { config, worker } = view;
  const workerLine = !worker ? "新管线：没有后台进程在运行"
    : worker.stale ? `新管线：进程 ${worker.pid} 已 ${ago(worker.heartbeatAt)} 没有心跳，可能已退出`
    : `新管线：${worker.state} · 心跳 ${ago(worker.heartbeatAt)}${worker.stage ? ` · 正在 ${worker.stage}` : ""} · 今天发布 ${worker.today.published}/${config.dailyTarget}，复核中 ${worker.today.held}`;
  const desired = `期望状态：${desiredLabel[config.desired]} · 每天目标 ${config.dailyTarget} 条 · ${config.updatedBy === "default" ? "默认配置，还没人改过" : `最后修改 ${time(config.updatedAt)}（${config.updatedBy}）`}`;
  const funnel = view.funnel ? `悬空 ${view.funnel.counts.stalled} 条、排队中 ${view.funnel.counts.waiting} 条（${time(view.funnel.at)} 统计，详情 funnel）` : undefined;
  if (brief) return [workerLine, desired, funnel, worker?.lastError ? `最近错误：${time(worker.lastError.at)} ${worker.lastError.message}` : undefined].filter(Boolean).join("\n");
  const routes = pipelineStages.map(stage => {
    const route = config.routing[stage];
    return `  ${stageLabels[stage]}：${describeRoute(route)}`;
  });
  const jobs = Object.entries(worker?.jobs ?? {}).map(([name, job]) => `  ${jobLabels[name] ?? name}：${time(job.startedAt)} ${
    !job.finishedAt ? "进行中" : job.ok ? `完成，${job.summary ?? ""}` : `失败，${job.summary ?? ""}`}`);
  return [workerLine, desired, ...(funnel ? [funnel] : []), ...(jobs.length ? ["后台任务：", ...jobs] : []), ...describeLegacy(view.legacy), "模型路由：", ...routes,
    "最近记录：", ...(view.events.length ? view.events.slice(-5).map(event => `  ${describeEvent(event)}`) : ["  （还没有记录）"]),
    `控制目录：${view.root}`].join("\n");
}

function actorOf(values: { by?: string }): string {
  const actor = values.by ?? process.env.PROMPIX_ACTOR;
  if (!actor) throw new Error("修改需要 --by <agent 或人名>，例如 --by codex、--by claude-code、--by lucy");
  return actor;
}

const mediaTypes: Record<string, ModelImage["mediaType"]> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

async function testProvider(id: string, model: string | undefined, imagePath: string | undefined, actor: string, json: boolean) {
  if (!isProviderId(id)) throw new Error(`未知提供方 ${id}`);
  const { env } = await modelEnvironment();
  const provider = createProvider(id, model, env);
  const image = imagePath ? { path: resolve(imagePath), mediaType: mediaTypes[extname(imagePath).toLowerCase()] } : undefined;
  if (image && !image.mediaType) throw new Error("只支持 jpg、png、webp、gif 图片");
  const request = image
    ? { instructions: "Name the single most dominant color in the attached image in one lowercase English word.", input: "Attached image only.",
        schema: { type: "object", properties: { color: { type: "string" } }, required: ["color"], additionalProperties: false }, images: [image], effort: "low" as const, maxOutputTokens: 2000 }
    : { instructions: "Return the color named in the source data, as one lowercase English word.", input: "The sky in this sentence is blue.",
        schema: { type: "object", properties: { color: { type: "string" } }, required: ["color"], additionalProperties: false }, effort: "low" as const, maxOutputTokens: 2000 };
  const root = pipelineRoot();
  try {
    const { value, result } = await completeValidated(provider, "test", request, z.object({ color: z.string() }).strict(),
      summary => appendEvent(root, actor, "provider.test", summary).then(() => undefined));
    const line = { ok: true, provider: id, model: result.model, answer: value.color, usage: result.usage,
      durationMs: Date.parse(result.finishedAt) - Date.parse(result.startedAt) };
    console.log(json ? JSON.stringify(line) : `✓ ${providerDefinitions[id].label} · ${result.model}：返回 "${value.color}"，${line.durationMs} ms${result.usage.inputTokens !== undefined ? `，输入 ${result.usage.inputTokens} / 输出 ${result.usage.outputTokens} token` : ""}`);
  } catch (error) {
    const code = error instanceof ModelProviderError ? error.code : "failed";
    console.log(json ? JSON.stringify({ ok: false, provider: id, error: code, message: (error as Error).message }) : `✗ ${providerDefinitions[id].label}：${(error as Error).message}（${code}）`);
    process.exitCode = 1;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    json: { type: "boolean" }, brief: { type: "boolean" }, by: { type: "string" }, reason: { type: "string" },
    model: { type: "string" }, effort: { type: "string" }, fallback: { type: "string" }, "fallback-model": { type: "string" }, "fallback-effort": { type: "string" }, image: { type: "string" }, tail: { type: "string" }, send: { type: "boolean" }, since: { type: "string" }, help: { type: "boolean", short: "h" } } });
  const [command, ...rest] = positionals;
  const root = pipelineRoot();
  switch (command) {
    case undefined: case "help": console.log(usage); return;
    case "status": {
      const view = { ...await snapshot(root), funnel: await readFunnelSnapshot(root) };
      console.log(values.json ? JSON.stringify(view, null, 2) : describeStatus(view, Boolean(values.brief)));
      return;
    }
    case "funnel": case "item": {
      if (command === "item" && !rest[0]) throw new Error("请写条目 ID，例如 item x-post-2109651736860438585");
      const now = Date.now(), statuses = await collectItemStates(contentRoot, await pipelineEnvironment(), now);
      if (command === "item") {
        const item = statuses.find(entry => entry.id === rest[0]);
        if (!item) throw new Error(`${rest[0]} 不在每日流程的候选里（可能来自历史补库，或从未采集）`);
        console.log(values.json ? JSON.stringify(item) : describeItem(item));
        return;
      }
      const summary = summarizeFunnel(statuses, now);
      await saveFunnelSnapshot(root, summary);
      console.log(values.json ? JSON.stringify(summary, null, 2) : describeFunnel(summary));
      return;
    }
    case "log": {
      const events = await readEvents(root, Number(values.tail ?? 20));
      console.log(values.json ? events.map(event => JSON.stringify(event)).join("\n") : events.map(describeEvent).join("\n") || "（还没有记录）");
      return;
    }
    case "providers": {
      const { env, warning } = await modelEnvironment();
      const rows = await Promise.all(providerIds.map(id => providerAvailability(id, env)));
      if (values.json) { console.log(JSON.stringify(rows, null, 2)); return; }
      for (const row of rows) console.log(`${row.ready ? "✓" : "·"} ${row.id.padEnd(14)} ${row.label}（${row.kind === "subscription" ? "订阅" : "按量"}）默认模型 ${row.defaultModel ?? "需指定"}${row.images ? " · 可看图" : ""}${row.missing ? ` · ${row.missing}` : ""}${row.note ? `\n    ${row.note}` : ""}`);
      if (warning) console.log(`注意：${warning}`);
      return;
    }
    case "start": case "pause": case "resume": case "stop": {
      const desired = command === "start" || command === "resume" ? "running" : command === "pause" ? "paused" : "stopped";
      const { after } = await updateConfig(root, actorOf(values), values.reason, config => ({ ...config, desired }));
      console.log(`期望状态已设为「${desiredLabel[after.desired]}」`);
      return;
    }
    case "target": {
      const target = Number(rest[0]);
      if (!Number.isInteger(target)) throw new Error("请给出每天的条数，例如 target 100");
      const { after } = await updateConfig(root, actorOf(values), values.reason, config => ({ ...config, dailyTarget: target }));
      console.log(`每天目标已设为 ${after.dailyTarget} 条`);
      return;
    }
    case "route": {
      const [stage, provider] = rest;
      if (!pipelineStages.includes(stage as never)) throw new Error(`未知环节 ${stage}，可选：${pipelineStages.join(", ")}`);
      if (!provider || !isProviderId(provider)) throw new Error(`未知提供方 ${provider}，可选：${providerIds.join(", ")}`);
      if (values.fallback && values.fallback !== "none" && !isProviderId(values.fallback)) throw new Error(`未知备用提供方 ${values.fallback}，可选：${providerIds.join(", ")} 或 none`);
      const { after } = await updateConfig(root, actorOf(values), values.reason, config => {
        const kept = config.routing[stage as keyof typeof config.routing].fallback;
        const fallback = values.fallback === "none" ? undefined : values.fallback ? { provider: values.fallback,
          ...(values["fallback-model"] ? { model: values["fallback-model"] } : {}), ...(values["fallback-effort"] ? { effort: values["fallback-effort"] } : {}) } : kept;
        return { ...config, routing: { ...config.routing, [stage]: { provider, ...(values.model ? { model: values.model } : {}),
          ...(values.effort ? { effort: values.effort } : {}), ...(fallback ? { fallback } : {}) } } };
      });
      const route = after.routing[stage as keyof typeof after.routing];
      console.log(`${stageLabels[stage as keyof typeof stageLabels]} 改用 ${describeRoute(route)}`);
      return;
    }
    case "set": {
      const [key, value] = rest;
      if (key !== "legacyContentDir" || !value) throw new Error("目前只能 set legacyContentDir <路径>");
      await updateConfig(root, actorOf(values), values.reason, config => ({ ...config, legacyContentDir: resolve(value) }));
      console.log(`legacyContentDir 已设为 ${resolve(value)}`);
      return;
    }
    case "note": {
      if (!rest.length) throw new Error("请写备注内容");
      await appendEvent(root, actorOf(values), "note", { text: rest.join(" ") });
      console.log("已记录");
      return;
    }
    case "worker": {
      const action = rest[0];
      if (action === "install") {
        await installWorker({ node: process.execPath, repo, root });
        await appendEvent(root, actorOf(values), "worker.installed", { plist: workerPlistPath(), repo });
        console.log(`已安装并启动后台进程（${workerPlistPath()}），代码目录 ${repo}`);
      } else if (action === "uninstall") {
        await uninstallWorker();
        await appendEvent(root, actorOf(values), "worker.uninstalled", {});
        console.log("已停止并卸载后台进程");
      } else if (action === "restart") {
        await restartWorker();
        await appendEvent(root, actorOf(values), "worker.restarted", {});
        console.log("已重启后台进程");
      } else throw new Error("用法：worker install | uninstall | restart");
      return;
    }
    case "maintenance": {
      const actor = actorOf(values);
      const report = await runMaintenance(await pipelineEnvironment());
      await appendEvent(root, actor, "job.finished", { job: "maintenance", summary: `手动：来源已删 ${report.removed} 条，本次下架 ${report.takenDown.length} 条`, report });
      console.log(values.json ? JSON.stringify(report) : `来源维护复查完成：来源已删 ${report.removed} 条，本次下架 ${report.takenDown.length} 条`);
      return;
    }
    case "report": {
      const actor = values.send ? actorOf(values) : "manual";
      const end = values.since ? Date.now() : slotStart(nightly.report, Date.now());
      const start = values.since ? Date.parse(values.since) : end - reportWindowMs;
      if (!Number.isFinite(start) || start >= end) throw new Error("--since 要写一个过去的时间，例如 2026-11-06T15:00:00Z");
      const env = await pipelineEnvironment(), report = await collectDailyReport(start, end, env, root);
      console.log(values.json ? JSON.stringify(report) : report.text);
      if (values.send) {
        await sendDailyReport(report, env);
        await appendEvent(root, actor, "report.sent", { date: report.date, ok: report.ok, since: new Date(start).toISOString(), fullDay: !values.since });
        console.log("\n已发送到监控邮箱");
      }
      return;
    }
    case "test-provider":
      if (!rest[0]) throw new Error("请写要测试的提供方");
      await testProvider(rest[0], values.model, values.image, values.by ?? process.env.PROMPIX_ACTOR ?? "manual-test", Boolean(values.json));
      return;
    default:
      throw new Error(`未知命令 ${command}\n\n${usage}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  trustSystemCertificates();
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
