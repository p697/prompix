import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomic, lockContent } from "./publication.ts";
import { withDailyStatus } from "./daily-status.ts";

const fullDisk = Object.assign(new Error("ENOSPC: status storage is full"), { code: "ENOSPC" });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "prompix-daily-status-"));
  const path = join(root, "status.json"), logs: Record<string, unknown>[] = [];
  const prior = { startedAt: "2026-10-12T00:00:00Z", finishedAt: "2026-10-12T00:01:00Z", published: true };
  await atomic(path, prior);
  return {
    root, path, prior, logs, report: { startedAt: new Date().toISOString(), published: false },
    log: (record: unknown) => { logs.push(structuredClone(record) as Record<string, unknown>); },
    read: async () => JSON.parse(await readFile(path, "utf8")),
    unlocked: () => assert.rejects(stat(join(root, "daily.lock")), { code: "ENOENT" }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("daily persists running under the real content lock before collection and records early completion", async () => {
  const f = await fixture();
  try {
    await withDailyStatus(f.root, f.report, async () => {
      const start = await f.read();
      assert.equal(start.state, "running");
      assert.equal(start.published, false);
      assert.equal(start.finishedAt, undefined);
      assert.ok(start.runID);
      await assert.rejects(lockContent(f.root), /Another content operation/);
      // Held/staging paths may legitimately complete without publication.
    }, { log: f.log });
    const final = await f.read();
    assert.equal(final.state, "succeeded");
    assert.equal(final.published, false);
    assert.equal(final.runID, f.logs[0].runID);
    assert.ok(final.finishedAt);
    await f.unlocked();
  } finally { await f.cleanup(); }
});

test("competing runs leave the owner's persisted status untouched", async () => {
  const f = await fixture();
  const unlock = await lockContent(f.root);
  try {
    await assert.rejects(withDailyStatus(f.root, f.report, async () => assert.fail("Must not collect"), { log: f.log }), /Another content operation/);
    assert.deepEqual(await f.read(), f.prior);
    assert.equal(f.logs.length, 0);
  } finally { await unlock(); await f.cleanup(); }
});

test("initial write failure invalidates stale success and prevents all work", async () => {
  const f = await fixture();
  try {
    await assert.rejects(withDailyStatus(f.root, f.report, async () => assert.fail("Must not collect or reserve calls"), {
      log: f.log, write: async () => { throw fullDisk; },
    }), error => error === fullDisk);
    await assert.rejects(f.read(), { code: "ENOENT" });
    assert.equal(f.logs.at(-1)?.started, false);
    assert.equal(f.logs.at(-1)?.state, "failed");
    assert.match(String(f.logs.at(-1)?.statusWriteError), /ENOSPC/);
    await f.unlocked();
  } finally { await f.cleanup(); }
});

test("an unwritable and non-removable status explicitly reports stale-file risk", async () => {
  const f = await fixture();
  try {
    await assert.rejects(withDailyStatus(f.root, f.report, async () => assert.fail("Must not collect"), {
      log: f.log, write: async () => { throw fullDisk; }, invalidate: async () => { throw new Error("Read-only volume"); },
    }), error => error === fullDisk);
    assert.deepEqual(await f.read(), f.prior);
    assert.match(String(f.logs.at(-1)?.statusInvalidationError), /Read-only/);
    await f.unlocked();
  } finally { await f.cleanup(); }
});

test("transient initial-write failure can record failure but never starts collection", async () => {
  const f = await fixture(); let writes = 0;
  try {
    await assert.rejects(withDailyStatus(f.root, f.report, async () => assert.fail("Must not collect"), {
      log: f.log, write: async (path, value) => { if (++writes === 1) throw fullDisk; await atomic(path, value); },
    }), error => error === fullDisk);
    assert.equal((await f.read()).state, "failed");
    assert.match((await f.read()).error, /ENOSPC/);
    await f.unlocked();
  } finally { await f.cleanup(); }
});

test("collection failure survives simultaneous final status and unlock failures", async () => {
  const f = await fixture(); const original = new Error("Publication verification failed"); let writes = 0;
  try {
    await assert.rejects(withDailyStatus(f.root, f.report, async () => { throw original; }, {
      log: f.log,
      write: async (path, value) => { if (++writes === 2) throw fullDisk; await atomic(path, value); },
      lock: async root => { const unlock = await lockContent(root); return async () => { await unlock(); throw new Error("Unlock failure"); }; },
    }), error => error === original);
    assert.equal((await f.read()).state, "running");
    const terminal = f.logs.at(-1)!;
    assert.equal(terminal.error, String(original));
    assert.equal(terminal.state, "failed");
    assert.match(String(terminal.statusWriteError), /ENOSPC/);
    assert.match(String(terminal.unlockError), /Unlock failure/);
    assert.ok(terminal.finishedAt);
    await f.unlocked();
  } finally { await f.cleanup(); }
});

test("successful activation with failed final status rejects without claiming rollback", async () => {
  const f = await fixture(); let writes = 0;
  try {
    await assert.rejects(withDailyStatus(f.root, f.report, async () => { f.report.published = true; }, {
      log: f.log, write: async (path, value) => { if (++writes === 2) throw fullDisk; await atomic(path, value); },
    }), error => error === fullDisk);
    assert.equal((await f.read()).state, "running");
    assert.equal(f.logs.at(-1)?.published, true);
    assert.equal(f.logs.at(-1)?.state, "failed");
    await f.unlocked();
  } finally { await f.cleanup(); }
});

test("ordinary collection failure is persisted and returns the original exception", async () => {
  const f = await fixture(); const original = new Error("Collector failed");
  try {
    await assert.rejects(withDailyStatus(f.root, f.report, async () => { throw original; }, { log: f.log }), error => error === original);
    assert.equal((await f.read()).state, "failed");
    assert.equal((await f.read()).error, String(original));
    await f.unlocked();
  } finally { await f.cleanup(); }
});
