import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sendHeartbeat } from "./monitor-heartbeat.ts";
const env = { PROMPIX_MONITOR_URL: "https://monitor.example/heartbeat", PROMPIX_MONITOR_SECRET: "fixture-secret" };
const record = { runID: randomUUID(), startedAt: "2026-10-15T00:00:00Z", state: "running", published: false, error: "credentials must never leave", sources: { private: "text" } };
test("heartbeat retries the same sanitized event after timeouts and server errors", async () => {
  const bodies: string[] = [], waits: number[] = []; let calls = 0;
  await sendHeartbeat(record, { env, sleep: async ms => { waits.push(ms); }, fetcher: async (_url, init) => {
    bodies.push(String(init?.body)); assert.equal(init?.redirect, "error");
    if (++calls === 1) throw new Error("Network failed");
    return new Response(null, { status: calls === 2 ? 503 : 200 });
  } });
  assert.equal(calls, 3); assert.equal(new Set(bodies).size, 1); assert.deepEqual(waits, [1000, 3000]);
  assert.equal(bodies[0].includes("credentials"), false); assert.equal(bodies[0].includes("sources"), false);
});
test("heartbeat does not retry permanent rejection, leak provider text or send to insecure endpoints", async () => {
  let calls = 0;
  await assert.rejects(sendHeartbeat(record, { env, fetcher: async () => { calls++; return new Response("private", { status: 401 }); } }), /^Error: Monitor heartbeat could not be delivered$/);
  assert.equal(calls, 1);
  for (const url of ["http://monitor.example/heartbeat", "https://monitor.example/heartbeat?token=abc", "https://user:pass@monitor.example/heartbeat"])
    await assert.rejects(sendHeartbeat(record, { env: { ...env, PROMPIX_MONITOR_URL: url } }), /Invalid monitor/);
});
test("optional monitor is disabled only when both configuration values are absent", async () => {
  await sendHeartbeat(record, { env: {} });
  await assert.rejects(sendHeartbeat(record, { env: { PROMPIX_MONITOR_SECRET: "fixture" } }), /Incomplete/);
});
test("heartbeat reports only committed addition counts, without transmitting content changes", async () => {
  const bodies: any[] = [];
  for (const published of [false, true]) await sendHeartbeat({ ...record, state: "succeeded", finishedAt: "2026-10-15T00:01:00Z", published,
    changes: { added: { total: 4 }, private: "source contents" } }, { env, fetcher: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(null); } });
  assert.deepEqual(bodies.map(body => body.added), [0, 4]);
  assert.ok(bodies.every(body => body.changes === undefined));
});
