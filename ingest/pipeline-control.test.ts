import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, defaultPipelineConfig, legacyState, readConfig, readEvents, snapshot, updateConfig, writeWorkerStatus, type LegacyProbe } from "./pipeline-control.ts";

const notScheduled: LegacyProbe = { launchdLoaded: () => false };
const exitedPid = () => spawnSync(process.execPath, ["-e", "0"]).pid!;

async function root() {
  const directory = await mkdtemp(join(tmpdir(), "prompix-pipeline-"));
  return { pipeline: join(directory, "pipeline"), content: join(directory, "content") };
}

test("a fresh control directory reports the default routing with the heavy stages on Codex", async () => {
  const { pipeline } = await root();
  const config = await readConfig(pipeline);
  assert.equal(config.desired, "stopped");
  assert.equal(config.dailyTarget, 100);
  assert.ok(Object.values(config.routing).every(route => route.provider === "codex-cli"));
});

test("changes are validated, attributed and logged with a field-level diff", async () => {
  const { pipeline } = await root();
  await assert.rejects(updateConfig(pipeline, " ", undefined, config => config), /--by/);
  const { after } = await updateConfig(pipeline, "claude-code", "Kimi has unused quota", config => ({ ...config, desired: "running",
    routing: { ...config.routing, review: { provider: "kimi-code", model: "k3.1-pro" } } }));
  assert.equal(after.updatedBy, "claude-code");
  assert.deepEqual(await readConfig(pipeline), after);
  const [event] = await readEvents(pipeline);
  assert.equal(event.type, "config.changed");
  assert.equal(event.actor, "claude-code");
  assert.equal(event.reason, "Kimi has unused quota");
  assert.deepEqual((event.changes as { path: string }[]).map(change => change.path).sort(), ["desired", "routing.review.effort", "routing.review.model", "routing.review.provider"]);
});

test("an invalid change leaves the previous configuration untouched", async () => {
  const { pipeline } = await root();
  await updateConfig(pipeline, "codex", undefined, config => ({ ...config, dailyTarget: 200 }));
  const before = await readFile(join(pipeline, "config.json"), "utf8");
  await assert.rejects(updateConfig(pipeline, "codex", undefined, config => ({ ...config, dailyTarget: 5000 })));
  await assert.rejects(updateConfig(pipeline, "codex", undefined, config => ({ ...config, routing: { ...config.routing, review: { provider: "unknown" as never } } })));
  assert.equal(await readFile(join(pipeline, "config.json"), "utf8"), before);
  assert.equal((await readEvents(pipeline)).length, 1);
});

test("concurrent writers from different agents both land", async () => {
  const { pipeline } = await root();
  await Promise.all([
    updateConfig(pipeline, "codex", undefined, config => ({ ...config, dailyTarget: 300 })),
    updateConfig(pipeline, "claude-code", undefined, config => ({ ...config, desired: "paused" })),
  ]);
  const config = await readConfig(pipeline);
  assert.equal(config.dailyTarget, 300);
  assert.equal(config.desired, "paused");
  assert.equal((await readEvents(pipeline)).length, 2);
});

test("a lock left by an exited agent is taken over", async () => {
  const { pipeline } = await root();
  await mkdir(pipeline, { recursive: true });
  await writeFile(join(pipeline, "config.lock"), JSON.stringify({ pid: exitedPid() }));
  const { after } = await updateConfig(pipeline, "codex", undefined, config => ({ ...config, dailyTarget: 50 }));
  assert.equal(after.dailyTarget, 50);
});

test("status separates a live worker, a silent worker and the old cron job", async () => {
  const { pipeline, content } = await root();
  await updateConfig(pipeline, "codex", undefined, config => ({ ...config, legacyContentDir: content }));
  await mkdir(join(content, "daily.lock"), { recursive: true });
  const deadPid = exitedPid();
  await writeFile(join(content, "daily.lock", "owner.json"), JSON.stringify({ pid: deadPid }));
  await writeFile(join(content, "status.json"), JSON.stringify({ runID: "r1", state: "running", startedAt: "2026-10-26T05:00:06.661Z" }));
  const now = Date.now();
  const today = { date: "2026-11-06", published: 12, reviewed: 40, held: 2, rejected: 5 };
  await writeWorkerStatus(pipeline, { pid: process.pid, startedAt: new Date(now - 3600000).toISOString(), heartbeatAt: new Date(now - 30000).toISOString(), state: "running", stage: "review", today });
  const live = await snapshot(pipeline, notScheduled, now);
  assert.equal(live.worker?.stale, false);
  assert.deepEqual(live.legacy.lock && { pid: live.legacy.lock.pid, alive: live.legacy.lock.alive }, { pid: deadPid, alive: false });
  assert.equal(live.legacy.lastRun?.state, "running");
  assert.equal(live.legacy.scheduled, false);
  await writeWorkerStatus(pipeline, { pid: process.pid, startedAt: new Date(now - 3600000).toISOString(), heartbeatAt: new Date(now - 10 * 60000).toISOString(), state: "running", today });
  assert.equal((await snapshot(pipeline, notScheduled, now)).worker?.stale, true);
});

test("the event log keeps notes and call summaries in order and tails cheaply", async () => {
  const { pipeline } = await root();
  for (let index = 0; index < 30; index++) await appendEvent(pipeline, "worker", "model.call", { index });
  await appendEvent(pipeline, "lucy", "note", { text: "先跑 100 条看质量" });
  const tail = await readEvents(pipeline, 5);
  assert.equal(tail.length, 5);
  assert.equal(tail.at(-1)?.text, "先跑 100 条看质量");
  assert.equal(tail[0].index, 26);
});

test("legacy probe reports nothing when the old content directory is absent", async () => {
  const state = await legacyState(join(tmpdir(), "prompix-missing-content-dir"), notScheduled);
  assert.deepEqual(state, { scheduled: false, lastRun: undefined, lock: undefined });
  assert.equal(defaultPipelineConfig().version, 1);
});
