import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Prompt } from "../packages/schema/catalog.ts";
import { createTestDatabase } from "../services/feed/test-database.ts";
import { activatePublication, stagePublication } from "../services/feed/publication.ts";
import { readEvents, readWorkerStatus, updateConfig, type WorkerStatus } from "./pipeline-control.ts";
import { extraIntakeJob, intakeJob, intakeRequestFile, jobDue, nightly, reportJob, retryAfterFailureMs, slotStart, tick, trialJob, trialRequestFile, type Job } from "./worker.ts";
import { runMaintenance, takedownLimit } from "./worker-maintenance.ts";
import { workerPlist } from "./worker-launchd.ts";

const hour = 3600000, now = Date.parse("2026-11-06T18:30:00Z"); // 03:30 in Japan, after the 03:00 intake slot
const at = (offset: number) => new Date(now - offset).toISOString();
const status = (job?: NonNullable<WorkerStatus["jobs"]>[string]): WorkerStatus => ({ pid: 1, startedAt: at(0), heartbeatAt: at(0), state: "idle",
  today: { date: "2026-11-06", published: 0, reviewed: 0, held: 0, rejected: 0 }, ...(job ? { jobs: { intake: job } } : {}) });
const job = { name: "intake", at: nightly.intake };

test("a nightly job runs once per slot, catches up after a missed night and retries a failure twice", () => {
  assert.equal(slotStart(nightly.intake, now), Date.parse("2026-11-06T18:00:00Z"));
  assert.equal(jobDue(job, undefined, now), true);
  assert.equal(jobDue(job, status({ startedAt: at(20 * 60000), finishedAt: at(0), ok: true }), now), false, "tonight's run is done");
  assert.equal(jobDue(job, status({ startedAt: at(24 * hour), finishedAt: at(23 * hour), ok: true }), now), true, "last night's run does not count");
  assert.equal(jobDue(job, status({ startedAt: at(24 * hour), finishedAt: at(23 * hour), ok: true }), now - hour), false, "not before 03:00");
  assert.equal(jobDue(job, status({ startedAt: at(40 * hour), finishedAt: at(39 * hour), ok: true }), now), true, "a missed night catches up");
  assert.equal(jobDue(job, status({ startedAt: at(10 * 60000), finishedAt: at(5 * 60000), ok: false, attempts: 1 }), now), false, "waits out the backoff");
  assert.equal(jobDue(job, status({ startedAt: at(retryAfterFailureMs), finishedAt: at(0), ok: false, attempts: 2 }), now), true);
  assert.equal(jobDue(job, status({ startedAt: at(retryAfterFailureMs), finishedAt: at(0), ok: false, attempts: 3 }), now), false, "three attempts a night");
  assert.equal(jobDue(job, status({ startedAt: at(hour) }), now), true, "a run cut off by a restart is due");
});

test("the heartbeat continues while a long job runs", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = join(await mkdtemp(join(tmpdir(), "prompix-worker-")), "pipeline");
  let clock = now, finish!: () => void;
  const running = tick(root, at(0), [{ name: "maintenance", at: nightly.maintenance, run: () => new Promise<string>(resolve => { finish = () => resolve("done"); }) }], { now: () => clock });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  clock += 2 * hour; t.mock.timers.tick(60000);
  for (let i = 0; i < 20 && (await readWorkerStatus(root))?.heartbeatAt !== new Date(clock).toISOString(); i++) await new Promise(resolve => setImmediate(resolve));
  const during = await readWorkerStatus(root);
  assert.equal(during?.heartbeatAt, new Date(clock).toISOString());
  assert.equal(during?.stage, "maintenance");
  finish(); await running;
  assert.equal((await readWorkerStatus(root))?.jobs?.maintenance.summary, "done");
});

test("the intake runs only while the pipeline is running, and a missing drive or a third failure alerts at once", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "prompix-worker-")), "pipeline"), content = await mkdtemp(join(tmpdir(), "prompix-content-"));
  let runs = 0;
  const alerts: string[] = [];
  const alert = async (text: string) => { alerts.push(text); };
  const jobs = [intakeJob({}, async env => { runs++; assert.equal(env.PROMPIX_TRANSLATION_PROVIDER, "pipeline"); return 1; }, alert, content)];
  await tick(root, at(0), jobs, { now: () => now });
  assert.equal(runs, 0, "a stopped pipeline collects nothing");
  await updateConfig(root, "codex", undefined, config => ({ ...config, desired: "running" }));
  for (let attempt = 0; attempt < 4; attempt++) await tick(root, at(0), jobs, { now: () => now + attempt * retryAfterFailureMs });
  assert.equal(runs, 3, "three attempts, then nothing until tomorrow");
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /连续 3 次失败/);
  const missing = intakeJob({}, async () => 0, alert, join(content, "not-mounted"));
  await assert.rejects(missing.run(1), /外置硬盘/);
  await assert.rejects(missing.run(2), /外置硬盘/);
  assert.equal(alerts.length, 2, "a missing drive is reported on the first attempt only");
});

test("an extra intake runs once per request, can import trials, and neither alerts nor uses the night's attempts", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "prompix-worker-")), "pipeline"), content = await mkdtemp(join(tmpdir(), "prompix-content-"));
  const runs: (string | undefined)[] = [];
  const translations: (string | undefined)[] = [];
  const alerts: string[] = [];
  let exit = 0;
  const spawn = async (env: NodeJS.ProcessEnv) => { runs.push(env.PROMPIX_IMPORT_TRIALS); translations.push(env.PROMPIX_TRANSLATION_MAX_REQUESTS); return exit; };
  const jobs = [intakeJob({}, spawn, async text => { alerts.push(text); }, content), extraIntakeJob({}, spawn, content, root)];
  await updateConfig(root, "codex", undefined, config => ({ ...config, desired: "running" }));
  const morning = Date.parse("2026-11-07T08:00:00Z");
  await tick(root, at(0), jobs, { now: () => morning });
  assert.deepEqual(runs, [undefined], "the first tick catches up last night's slot");
  const { atomic } = await import("./publication.ts");
  await atomic(join(root, intakeRequestFile), { at: new Date(morning + 60_000).toISOString(), by: "test", importTrials: ["2026-11-07T06-27-06-637Z", "../bad"], translationRequests: 300 });
  await tick(root, at(0), jobs, { now: () => morning + 120_000 });
  await tick(root, at(0), jobs, { now: () => morning + hour });
  assert.deepEqual(runs, [undefined, "2026-11-07T06-27-06-637Z"], "a request runs once, with only valid trial ids");
  assert.deepEqual(translations, [undefined, "300"], "a request may translate more than a night");
  exit = 1;
  for (let attempt = 0; attempt < 3; attempt++) {
    await atomic(join(root, intakeRequestFile), { at: new Date(morning + 2 * hour + attempt * hour).toISOString(), by: "test" });
    await tick(root, at(0), jobs, { now: () => morning + 2 * hour + attempt * hour + 60_000 });
  }
  assert.equal(runs.length, 5, "three failed extra runs, each requested");
  assert.equal(alerts.length, 0, "a failed extra run never alerts");
  exit = 0;
  await tick(root, at(0), jobs, { now: () => Date.parse("2026-11-07T18:01:00Z") });
  assert.equal(runs.length, 6, "the night's run still happens");
});

test("the 08:30 report covers the 24 hours before it, once the worker has run an intake", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "prompix-worker-")), "pipeline");
  const sent: string[] = [];
  const morning = Date.parse("2026-11-06T23:40:00Z");
  const job = reportJob({}, root, async report => { sent.push(report.date); }, { now: () => morning });
  assert.equal(await job.run(1), "每日采集还没开始，不发日报");
  await updateConfig(root, "codex", undefined, config => config);
  const { appendEvent } = await import("./pipeline-control.ts");
  await appendEvent(root, "worker", "job.failed", { job: "intake", error: "x", durationMs: 1 });
  const later = reportJob({}, root, async report => { sent.push(report.date); }, { now: () => Date.now() + 24 * hour });
  await later.run(1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0], new Date(slotStart(nightly.report, Date.now() + 24 * hour)).toLocaleDateString("sv-SE"));
});

test("a trial runs once per request and is never retried on its own", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "prompix-worker-")), "pipeline");
  let runs = 0;
  const jobs = [trialJob({}, root, async () => { runs++; return 0; })];
  await tick(root, at(0), jobs, { now: () => now });
  assert.equal(runs, 0, "nothing requested");
  const { atomic } = await import("./publication.ts");
  await atomic(join(root, trialRequestFile), { at: new Date(now - 1000).toISOString(), by: "test" });
  await tick(root, at(0), jobs, { now: () => now });
  await tick(root, at(0), jobs, { now: () => now + hour });
  assert.equal(runs, 1);
});

test("each tick writes a heartbeat, runs a due job once and records success or failure", async () => {
  const root = join(await mkdtemp(join(tmpdir(), "prompix-worker-")), "pipeline");
  let runs = 0, fail = false;
  const jobs: Job[] = [{ name: "maintenance", at: nightly.maintenance, run: async () => {
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
  assert.equal(runs, 1, "not due again the same night");
  assert.equal((await readWorkerStatus(root))?.heartbeatAt, new Date(clock).toISOString());
  clock += 24 * hour; fail = true;
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
