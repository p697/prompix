import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { acceptHeartbeat, acknowledge, defer, evaluate, heartbeatSchema, HOUR, initialState, nextAlarm, type Heartbeat } from "./state.ts";
const origin = Date.parse("2026-10-15T00:00:00Z");
function event(start: number, state: Heartbeat["state"], published = false): Heartbeat {
  return { runID: randomUUID(), startedAt: new Date(start).toISOString(), state, published,
    ...(state !== "running" ? { finishedAt: new Date(start + 60000).toISOString() } : {}) };
}
test("run failure is deduplicated across retries and subsequent failed runs; only success recovers", () => {
  const s = initialState(origin), failed = event(origin, "failed");
  assert.equal(acceptHeartbeat(s, failed, origin + 60000), true);
  assert.equal(acceptHeartbeat(s, failed, origin + 60000), false);
  acceptHeartbeat(s, event(origin + HOUR, "failed"), origin + 2 * HOUR);
  const running = event(origin + 2 * HOUR, "running");
  acceptHeartbeat(s, running, origin + 2 * HOUR);
  assert.deepEqual(s.outbox.map(n => n.kind), ["run_failed"]);
  acceptHeartbeat(s, { ...running, state: "succeeded", finishedAt: new Date(origin + 3 * HOUR).toISOString(), published: true }, origin + 3 * HOUR);
  assert.deepEqual(s.outbox.map(n => n.kind), ["run_failed", "recovered"]);
  assert.equal(s.incident, undefined);
});
test("out-of-order starts, delayed older completions and conflicting identities cannot overwrite newer state", () => {
  const s = initialState(origin), done = event(origin + HOUR, "succeeded", true);
  acceptHeartbeat(s, done, origin + 2 * HOUR);
  assert.equal(acceptHeartbeat(s, { ...done, state: "running", finishedAt: undefined, published: false }, origin + 2 * HOUR), false);
  assert.equal(acceptHeartbeat(s, event(origin, "failed"), origin + 2 * HOUR), false);
  assert.equal(acceptHeartbeat(s, event(origin + HOUR, "failed"), origin + 2 * HOUR), false);
  assert.equal(s.last?.state, "succeeded");
  assert.equal(s.outbox.length, 0);
  assert.throws(() => acceptHeartbeat(s, event(origin + 3 * HOUR, "running"), origin), /Future/);
});
test("cloud alarm detects missed schedules even without any incoming heartbeat", () => {
  const s = initialState(origin);
  evaluate(s, origin + 8 * HOUR - 1); assert.equal(s.outbox.length, 0);
  evaluate(s, origin + 8 * HOUR); evaluate(s, origin + 16 * HOUR);
  assert.deepEqual(s.outbox.map(n => n.kind), ["schedule_missed"]);
  assert.equal(nextAlarm(s, origin + 16 * HOUR), origin + 16 * HOUR + 1000);
});
test("a hung run alerts after two hours and a new start does not hide the incident", () => {
  const s = initialState(origin);
  acceptHeartbeat(s, event(origin, "running"), origin);
  evaluate(s, origin + 2 * HOUR); assert.equal(s.incident, "run_stalled");
  acceptHeartbeat(s, event(origin + 3 * HOUR, "running"), origin + 3 * HOUR);
  assert.equal(s.incident, "run_stalled"); assert.equal(s.outbox.length, 1);
});
test("successful runs without publication cannot hide a stale publication", () => {
  const s = initialState(origin);
  for (let hour = 0; hour <= 30; hour += 6) acceptHeartbeat(s, event(origin + hour * HOUR, "succeeded"), origin + hour * HOUR + 60000);
  assert.equal(s.incident, "publication_stale");
  acceptHeartbeat(s, event(origin + 31 * HOUR, "succeeded", true), origin + 32 * HOUR);
  assert.equal(s.incident, undefined); assert.equal(s.outbox.at(-1)?.kind, "recovered");
});
test("successful unchanged publications cannot hide a stalled discovery pipeline", () => {
  const s = initialState(origin);
  for (let hour = 0; hour <= 30; hour += 6) acceptHeartbeat(s, { ...event(origin + hour * HOUR, "succeeded", true), added: 0 }, origin + hour * HOUR + 60000);
  assert.equal(s.incident, "content_stale"); assert.equal(s.outbox.length, 1);
  acceptHeartbeat(s, { ...event(origin + 31 * HOUR, "succeeded", true), added: 2 }, origin + 32 * HOUR);
  assert.equal(s.incident, undefined); assert.equal(s.outbox.at(-1)?.kind, "recovered");
});
test("email retries retain the notice and acknowledging it preserves concurrent recovery", () => {
  const s = initialState(origin);
  acceptHeartbeat(s, event(origin, "failed"), origin + 60000);
  const id = s.outbox[0].id;
  defer(s, id, origin); assert.equal(s.outbox[0].nextAttempt, origin + 300000);
  for (let i = 0; i < 20; i++) defer(s, id, origin);
  assert.equal(s.outbox[0].nextAttempt, origin + HOUR);
  acceptHeartbeat(s, event(origin + HOUR, "succeeded", true), origin + 2 * HOUR);
  acknowledge(s, id); assert.deepEqual(s.outbox.map(n => n.kind), ["recovered"]);
  acknowledge(s, id); assert.equal(s.outbox.length, 1);
});
test("schema rejects raw diagnostics, invalid times and forged running publications", () => {
  const good = event(origin, "succeeded", true);
  assert.equal(heartbeatSchema.safeParse(good).success, true);
  for (const invalid of [{ ...good, error: "secret" }, { ...good, finishedAt: undefined }, { ...good, finishedAt: "2020-01-01T00:00:00Z" }, { ...good, state: "running" }])
    assert.equal(heartbeatSchema.safeParse(invalid).success, false);
});

test("consecutive source failures alert even if the run successfully republishes cached content", () => {
  const s = initialState(origin);
  acceptHeartbeat(s, { ...event(origin, "succeeded", true), degraded: true }, origin + HOUR);
  assert.equal(s.outbox.length, 0);
  acceptHeartbeat(s, { ...event(origin + 6 * HOUR, "succeeded", true), degraded: true }, origin + 7 * HOUR);
  assert.equal(s.incident, "source_degraded"); assert.equal(s.outbox.length, 1);
  acceptHeartbeat(s, { ...event(origin + 12 * HOUR, "succeeded", true), degraded: false }, origin + 13 * HOUR);
  assert.equal(s.incident, undefined); assert.equal(s.outbox.at(-1)?.kind, "recovered");
});
