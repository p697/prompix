import { z } from "zod";

export const heartbeatSchema = z.object({
  runID: z.uuid(), startedAt: z.iso.datetime(),
  state: z.enum(["running", "succeeded", "failed"]),
  finishedAt: z.iso.datetime().optional(), published: z.boolean(), degraded: z.boolean().optional(), added: z.number().int().min(0).max(100000).optional(),
}).strict().superRefine((event, ctx) => {
  if (event.state !== "running" && (!event.finishedAt || Date.parse(event.finishedAt) < Date.parse(event.startedAt)))
    ctx.addIssue({ code: "custom", message: "Invalid completion time" });
  if (event.state === "running" && (event.finishedAt || event.published))
    ctx.addIssue({ code: "custom", message: "Invalid running state" });
  if (event.added && !event.published) ctx.addIssue({ code: "custom", message: "Additions require a publication" });
});
export type Heartbeat = z.infer<typeof heartbeatSchema>;
export type Incident = "run_failed" | "run_stalled" | "schedule_missed" | "publication_stale" | "content_stale" | "source_degraded";
export type Notice = { id: string; kind: Incident | "recovered"; at: number; attempts: number; nextAttempt: number };
export type MonitorState = {
  armedAt: number; degradedRuns?: number; last?: Heartbeat; lastSuccess?: number; lastPublication?: number; lastAddition?: number;
  incident?: Incident; incidentAt?: number; sequence: number; outbox: Notice[];
};
export const HOUR = 3600000;
export function initialState(now: number): MonitorState {
  return { armedAt: now, sequence: 0, outbox: [] };
}

/** Event identity and terminal-state ordering make heartbeat retries idempotent. */
export function acceptHeartbeat(state: MonitorState, event: Heartbeat, now: number): boolean {
  const start = Date.parse(event.startedAt);
  if (start > now + 300000 || Date.parse(event.finishedAt ?? event.startedAt) > now + 300000) throw new Error("Future heartbeat");
  if (state.last) {
    const previousStart = Date.parse(state.last.startedAt);
    if (start < previousStart) return false;
    if (start === previousStart && state.last.runID !== event.runID) return false;
    if (state.last.runID === event.runID) {
      if (state.last.startedAt !== event.startedAt) throw new Error("Run identity conflict");
      if (state.last.state !== "running" || event.state === "running") return false;
    }
  }
  state.last = event;
  if (event.state !== "running") state.degradedRuns = event.degraded ? (state.degradedRuns ?? 0) + 1 : 0;
  if (event.state === "succeeded") state.lastSuccess = Date.parse(event.finishedAt!);
  if (event.published) state.lastPublication = Date.parse(event.finishedAt!);
  // Older clients did not report additions. Preserve their compatibility during
  // rollout; current clients always distinguish an unchanged publication.
  if (event.published && (event.added === undefined || event.added > 0)) state.lastAddition = Date.parse(event.finishedAt!);
  evaluate(state, now);
  return true;
}

/** A start is not recovery. Only a successful completion clears a failed run. */
export function evaluate(state: MonitorState, now: number): void {
  const last = state.last;
  let problem: Incident | undefined;
  if (last?.state === "failed") problem = "run_failed";
  else if (last?.state === "running" && now - Date.parse(last.startedAt) >= 2 * HOUR) problem = "run_stalled";
  else if (now - (state.lastSuccess ?? state.armedAt) >= 8 * HOUR) problem = "schedule_missed";
  else if (now - (state.lastPublication ?? state.armedAt) >= 26 * HOUR) problem = "publication_stale";
  else if (now - (state.lastAddition ?? state.armedAt) >= 26 * HOUR) problem = "content_stale";
  else if ((state.degradedRuns ?? 0) >= 2) problem = "source_degraded";
  else if (last?.state === "running" || (state.incident === "source_degraded" && last?.degraded)) return;
  if (problem && !state.incident) {
    state.incident = problem; state.incidentAt = now;
    enqueue(state, problem, now);
  } else if (!problem && state.incident && last?.state === "succeeded") {
    delete state.incident; delete state.incidentAt;
    enqueue(state, "recovered", now);
  }
}
function enqueue(state: MonitorState, kind: Notice["kind"], now: number) {
  // Keep the earliest undelivered incident and the latest transitions during a mail outage.
  if (state.outbox.length >= 32) state.outbox.splice(1, 1);
  state.outbox.push({ id: `${state.armedAt}-${++state.sequence}`, kind, at: now, attempts: 0, nextAttempt: now });
}
export function acknowledge(state: MonitorState, id: string): void {
  state.outbox = state.outbox.filter(notice => notice.id !== id);
}
export function defer(state: MonitorState, id: string, now: number): void {
  const notice = state.outbox.find(item => item.id === id);
  if (notice) { notice.attempts++; notice.nextAttempt = now + Math.min(60, 5 * 2 ** Math.min(notice.attempts - 1, 4)) * 60000; }
}
export function nextAlarm(state: MonitorState, now: number): number {
  return Math.max(now + 1000, Math.min(now + 5 * 60000, state.outbox[0]?.nextAttempt ?? Infinity));
}
