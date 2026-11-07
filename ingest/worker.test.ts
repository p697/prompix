import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Prompt } from "../packages/schema/catalog.ts";
import { createTestDatabase } from "../services/feed/test-database.ts";
import { activatePublication, stagePublication } from "../services/feed/publication.ts";
import { readEvents, readWorkerStatus, updateConfig, type WorkerStatus } from "./pipeline-control.ts";
import { intakeJob, intakeWindowMs, jobDue, reportJob, maintenanceIntervalMs, retryAfterFailureMs, tick, type Job } from "./worker.ts";
import { runMaintenance, takedownLimit } from "./worker-maintenance.ts";
import { workerPlist } from "./worker-launchd.ts";

const hour = 3600000, now = Date.parse("2026-11-06T12:00:00Z");
const at = (offset: number) => new Date(now - offset).toISOString();
const status = (job?: NonNullable<WorkerStatus["jobs"]>[string]): WorkerStatus => ({ pid: 1, startedAt: at(0), heartbeatAt: at(0), state: "idle",
  today: { date: "2026-11-06", published: 0, reviewed: 0, held: 0, rejected: 0 }, ...(job ? { jobs: { maintenance: job } } : {}) });
const job = { name: "maintenance", interval: maintenanceIntervalMs };

test("a job is due when it never ran, its interval passed, a failure waited out its backoff, or a run was cut off", () => {
  assert.equal(jobDue(job, undefined, now), true);
  assert.equal(jobDue(job, status({ startedAt: at(hour), finishedAt: at(hour), ok: true }), now), false);
  assert.equal(jobDue(job, status({ startedAt: at(13 * hour), finishedAt: at(13 * hour), ok: true }), now), true);
  assert.equal(jobDue(job, status({ startedAt: at(retryAfterFailureMs / 3), finishedAt: at(retryAfterFailureMs / 3), ok: false }), now), false);
  assert.equal(jobDue(job, status({ startedAt: at(retryAfterFailureMs + 1), finishedAt: at(retryAfterFailureMs), ok: false }), now), true);
  assert.equal(jobDue(job, status({ startedAt: at(hour) }), now), true);
});

test("the heartbeat continues while a long job runs", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = join(await mkdtemp(join(tmpdir(), "prompix-worker-")), "pipeline");
  let clock = now, finish!: () => void;
  const running = tick(root, at(0), [{ name: "maintenance", interval: maintenanceIntervalMs, run: () => new Promise<string>(resolve => { finish = () => resolve("done"); }) }], { now: () => clock });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  clock += 2 * hour; t.mock.timers.tick(60000);
  for (let i = 0; i < 20 && (await readWorkerStatus(root))?.heartbeatAt !== new Date(clock).toISOString(); i++) await new Promise(resolve => setImmediate(resolve));
  const during = await readWorkerStatus(root);
  assert.equal(during?.heartbeatAt, new Date(clock).toISOString());
  assert.equal(during?.stage, "maintenance");
  finish(); await running;
  assert.equal((await readWorkerStatus(root))?.jobs?.maintenance.summary, "done");
});

test("the intake runs once per six-hour UTC window and only while the pipeline is running", async () => {
  const window = { name: "maintenance", interval: intakeWindowMs, aligned: true };
  // now is 12:00 UTC, the start of the third window.
  assert.equal(jobDue(window, status({ startedAt: at(1), finishedAt: at(0), ok: true }), now), true, "11:59 belongs to the previous window");
  assert.equal(jobDue(window, status({ startedAt: at(-1), finishedAt: at(-1), ok: true }), now + 5 * hour), false);
  const root = join(await mkdtemp(join(tmpdir(), "prompix-worker-")), "pipeline");
  let runs = 0;
  const jobs = [{ ...intakeJob({}, async env => { runs++; assert.equal(env.PROMPIX_TRANSLATION_PROVIDER, "pipeline"); return 0; }), name: "intake" }];
  await tick(root, at(0), jobs, { now: () => now });
  assert.equal(runs, 0, "a stopped pipeline collects nothing");
  await updateConfig(root, "codex", undefined, config => ({ ...config, desired: "running" }));
  await tick(root, at(0), jobs, { now: () => now });
  assert.equal(runs, 1);
});

test("the daily report covers the UTC day that just ended, once the worker has run an intake", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "prompix-worker-")), "pipeline");
  const sent: string[] = [];
  const job = reportJob({}, root, async report => { sent.push(report.date); }, { now: () => now });
  assert.equal(await job.run(), "每日采集还没开始，不发日报");
  await updateConfig(root, "codex", undefined, config => config);
  const { appendEvent } = await import("./pipeline-control.ts");
  await appendEvent(root, "worker", "job.failed", { job: "intake", error: "x", durationMs: 1 });
  const later = reportJob({}, root, async report => { sent.push(report.date); }, { now: () => Date.now() + 24 * hour });
  await later.run();
  assert.deepEqual(sent, [new Date(Date.now()).toISOString().slice(0, 10)]);
});

test("each tick writes a heartbeat, runs a due job once and records success or failure", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "prompix-worker-")), "pipeline");
  let runs = 0, fail = false;
  const jobs: Job[] = [{ name: "maintenance", interval: maintenanceIntervalMs, run: async () => {
    runs++; if (fail) throw new Error("provider down"); return "all verified"; } }];
  let clock = now;
  await updateConfig(root, "codex", undefined, config => ({ ...config, desired: "paused" }));
  await tick(root, at(0), jobs, { now: () => clock });
  let current = await readWorkerStatus(root);
  assert.equal(current?.state, "paused");
  assert.equal(current?.jobs?.maintenance.ok, true);
  assert.equal(current?.jobs?.maintenance.summary, "all verified");
  clock += hour;
  await tick(root, at(0), jobs, { now: () => clock });
  assert.equal(runs, 1, "not due again within the interval");
  assert.equal((await readWorkerStatus(root))?.heartbeatAt, new Date(clock).toISOString());
  clock += maintenanceIntervalMs; fail = true;
  await tick(root, at(0), jobs, { now: () => clock });
  current = await readWorkerStatus(root);
  assert.equal(runs, 2);
  assert.equal(current?.jobs?.maintenance.ok, false);
  assert.match(current?.lastError?.message ?? "", /maintenance: provider down/);
  const types = (await readEvents(root)).map(event => event.type);
  assert.deepEqual(types.filter(type => type.startsWith("job.")), ["job.finished", "job.failed"]);
});

function item(index: number): Prompt {
  return { id: `x-post-${100 + index}`, kind: "image", title: `Work ${index}`, summary: "Fixture", prompt: "Original test body", example: "Example",
    tags: ["test"], model: "Synthetic", artwork: "test", previewLabel: "Preview", toolURL: null, presentation: "general",
    source: { name: "Prompix", url: null, license: "CC0", method: "test" },
    media: { image: null, video: null, demoURL: null, imageURL: "https://api.prompix.dev/media/test.jpg" } };
}

async function maintenanceFixture(removedCount: number) {
  const content = await mkdtemp(join(tmpdir(), "prompix-content-"));
  const { pg, writer } = await createTestDatabase();
  const release = await stagePublication(writer, { schemaVersion: 1, version: "fixture", prompts: Array.from({ length: removedCount + 2 }, (_, i) => item(i)) });
  await activatePublication(writer, release, "0");
  const calls: string[] = [];
  const removed = Object.fromEntries(Array.from({ length: removedCount }, (_, i) => [`x-post-${100 + i}`, { removed: true }]));
  const overrides = {
    lock: async () => { calls.push("lock"); return async () => { calls.push("unlock"); }; },
    admission: async () => { calls.push("admission"); return { publishedIDs: new Set<string>(), attemptedIDs: new Set<string>(), maxDrafts: 0 }; },
    availability: async (_root: string, options: { admission?: unknown }) => { calls.push(options.admission ? "availability+admission" : "availability");
      return { state: { ...removed, "x-post-999": { removed: true } }, report: { status: "checked" } }; },
    database: <T>(work: (db: typeof writer) => Promise<T>) => work(writer),
  } as unknown as Parameters<typeof runMaintenance>[2];
  return { content, pg, writer, calls, overrides };
}

test("maintenance rechecks with the published IDs, then takes down live items whose source is gone", async t => {
  const { content, pg, writer, calls, overrides } = await maintenanceFixture(2);
  t.after(() => pg.close());
  const report = await runMaintenance({ PROMPIX_X_DISCOVERY_PROVIDER: "third-party" }, content, overrides);
  assert.deepEqual(calls, ["lock", "admission", "availability+admission", "unlock"]);
  assert.deepEqual(report.takenDown, ["x-post-100", "x-post-101"]);
  assert.equal(report.removed, 3, "an ID that was never published is recorded but not taken down");
  const live = (await writer.query<{ id: string }>("select id from prompix.content where removed_at is null order by id")).rows.map(row => row.id);
  assert.deepEqual(live, ["x-post-102", "x-post-103"]);
  const moderation = JSON.parse(await readFile(join(content, "moderation.json"), "utf8"));
  assert.deepEqual(moderation.removedIDs, ["x-post-100", "x-post-101", "x-post-999"]);
  const again = await runMaintenance({ PROMPIX_X_DISCOVERY_PROVIDER: "third-party" }, content, overrides);
  assert.deepEqual(again.takenDown, [], "already removed items are not removed twice");
});

test("a mass removal is refused and nothing is taken down", async t => {
  const { content, pg, writer, calls, overrides } = await maintenanceFixture(takedownLimit + 1);
  t.after(() => pg.close());
  await assert.rejects(runMaintenance({ PROMPIX_X_DISCOVERY_PROVIDER: "third-party" }, content, overrides), /Refusing to take down 51/);
  assert.equal((await writer.query("select id from prompix.content where removed_at is not null")).rows.length, 0);
  assert.equal(calls.at(-1), "unlock");
});

test("the launchd job keeps the worker alive from the main checkout", () => {
  const plist = workerPlist({ node: "/opt/node/bin/node", repo: "/Users/me/prompix & co", root: "/Users/me/.local/share/prompix/pipeline" });
  assert.match(plist, /<string>dev\.prompix\.worker<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<string>\/Users\/me\/prompix &amp; co<\/string>/);
  assert.match(plist, /<string>ingest\/worker\.ts<\/string>/);
  assert.match(plist, /\/opt\/node\/bin:/);
});
