import { DurableObject } from "cloudflare:workers";
import { EmailMessage } from "cloudflare:email";
import { timingSafeEqual } from "node:crypto";
import { acceptHeartbeat, acknowledge, defer, evaluate, heartbeatSchema, initialState, nextAlarm, type Heartbeat, type MonitorState, type Notice } from "./state.ts";

export class IngestMonitor extends DurableObject<MonitorEnv> {
  constructor(ctx: DurableObjectState, env: MonitorEnv) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS monitor (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
  }
  private read(): MonitorState | undefined {
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM monitor WHERE id=1").toArray()[0];
    return row ? JSON.parse(row.value) : undefined;
  }
  private write(state: MonitorState) {
    this.ctx.storage.sql.exec("INSERT INTO monitor(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", JSON.stringify(state));
  }
  async heartbeat(event: Heartbeat) {
    const now = Date.now(), state = this.read() ?? initialState(now);
    const accepted = acceptHeartbeat(state, heartbeatSchema.parse(event), now);
    this.write(state);
    await this.ctx.storage.setAlarm(nextAlarm(state, now));
    return { accepted };
  }
  status() {
    const state = this.read();
    return state ? { armed: true, last: state.last, lastSuccess: state.lastSuccess, lastPublication: state.lastPublication,
      incident: state.incident, pendingNotifications: state.outbox.length, notificationAttempts: state.outbox[0]?.attempts ?? 0 } : { armed: false };
  }
  async alarm() {
    const state = this.read(); if (!state) return;
    const now = Date.now(); evaluate(state, now); this.write(state);
    // Persist a fallback before external I/O. A provider outage cannot disarm monitoring.
    await this.ctx.storage.setAlarm(now + 5 * 60000);
    const notice = state.outbox[0];
    if (notice && notice.nextAttempt <= now) {
      try {
        await this.env.ALERT_EMAIL.send(new EmailMessage("alerts@prompix.dev", this.env.ALERT_RECIPIENT,
          message(notice, this.env.ALERT_RECIPIENT, this.env.MONITOR_LABEL)));
        const current = this.read()!; acknowledge(current, notice.id); this.write(current);
        console.log(JSON.stringify({ event: "notification_accepted", id: notice.id, kind: notice.kind }));
      } catch {
        const current = this.read()!; defer(current, notice.id, Date.now()); this.write(current);
        console.error(JSON.stringify({ event: "notification_failed", id: notice.id }));
      }
    }
    await this.ctx.storage.setAlarm(nextAlarm(this.read()!, Date.now()));
  }
}
function message(notice: Notice, recipient: string, label: string): string {
  if (!/^[^\s<>\r\n]+@[^\s<>\r\n]+$/.test(recipient)) throw new Error("Invalid recipient configuration");
  const descriptions: Record<Notice["kind"], string> = {
    source_degraded: "连续两次采集出现来源或审核服务失败。内容库可能仍可访问，但新增供给受影响，请检查分阶段运行记录。",
    run_failed: "采集任务失败。安全重试已耗尽或遇到不可重试错误，请检查采集状态和日志。",
    run_stalled: "采集任务已运行超过 2 小时，可能卡住。请检查运行中的任务。",
    schedule_missed: "超过 8 小时没有成功完成采集。请检查电脑、外接磁盘、网络和定时任务。",
    publication_stale: "超过 26 小时没有成功发布。请检查质量审核、发布队列和发布服务。",
    recovered: "采集已成功完成，之前的告警条件已解除。",
  };
  const subject = `${label === "production" ? "" : "[验收测试] "}Prompix · ${notice.kind === "recovered" ? "采集恢复" : "采集告警"}`;
  const body = `${descriptions[notice.kind]}\n\n时间（UTC）：${new Date(notice.at).toISOString()}\n通知编号：${notice.id}\n\n此邮件来自 Prompix 自动监控。同一故障不会重复发送告警；恢复后会通知。\n`;
  const base64 = (text: string) => Buffer.from(text).toString("base64");
  return [`From: Prompix <alerts@prompix.dev>`, `To: ${recipient}`, `Subject: =?UTF-8?B?${base64(subject)}?=`,
    `Message-ID: <${notice.id}@prompix.dev>`, `Date: ${new Date(notice.at).toUTCString()}`, "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", base64(body).match(/.{1,76}/g)!.join("\r\n")].join("\r\n");
}

export default {
  async fetch(request: Request, env: MonitorEnv): Promise<Response> {
    const headers = { "Cache-Control": "no-store" };
    const supplied = Buffer.from(request.headers.get("Authorization") ?? ""), expected = Buffer.from(`Bearer ${env.HEARTBEAT_SECRET}`);
    if (!env.HEARTBEAT_SECRET || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return new Response("Unauthorized", { status: 401, headers });
    const path = new URL(request.url).pathname;
    const monitor = env.MONITOR.getByName("collector");
    if (request.method === "GET" && path === "/status") return Response.json(await monitor.status(), { headers });
    if (request.method !== "POST" || path !== "/heartbeat") return new Response("Not found", { status: 404, headers });
    try {
      if (!request.body) return new Response("Missing body", { status: 400, headers });
      const reader = request.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > 2048) { await reader.cancel(); return new Response("Too large", { status: 413, headers }); }
        chunks.push(value);
      }
      const event = heartbeatSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!event.success || Date.parse(event.data.finishedAt ?? event.data.startedAt) > Date.now() + 300000)
        return new Response("Invalid event", { status: 400, headers });
      return Response.json(await monitor.heartbeat(event.data), { headers });
    } catch {
      return new Response("Heartbeat unavailable", { status: 503, headers });
    }
  },
} satisfies ExportedHandler<MonitorEnv>;
