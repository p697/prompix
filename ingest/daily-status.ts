import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { atomic, lockContent } from "./publication.ts";

type Report = { startedAt: string; published: boolean; error?: string };
type Dependencies = {
  write: typeof atomic;
  invalidate: (path: string) => Promise<void>;
  lock: typeof lockContent;
  log: (record: unknown) => void;
};

/** Persist intent before any collection; a failed final write must not hide its cause. */
export async function withDailyStatus<T extends Report>(root: string, report: T, work: () => Promise<void>, overrides: Partial<Dependencies> = {}) {
  const io: Dependencies = {
    write: atomic, invalidate: path => rm(path, { force: true }), lock: lockContent,
    log: record => console.log(JSON.stringify(record)), ...overrides,
  };
  // A competing invocation must not overwrite the active owner's status.
  const unlock = await io.lock(root);
  const path = join(root, "status.json"), runID = randomUUID();
  let failure: { reason: unknown } | undefined;
  const diagnostics: { statusWriteError?: string; statusInvalidationError?: string; unlockError?: string } = {};
  const fail = (reason: unknown) => { failure ??= { reason }; };
  let started = false;
  let finishedAt: string;
  const snapshot = () => ({ ...report, runID, state: failure ? "failed" : "succeeded", finishedAt, ...diagnostics });
  try {
    const initial = { ...report, runID, state: "running" };
    io.log(initial);
    try {
      await io.write(path, initial);
      started = true;
    } catch (error) {
      // Best effort: even a full disk can often unlink a stale success record.
      // If unlink also fails, the log explicitly records the stale-file risk.
      diagnostics.statusWriteError = String(error);
      try { await io.invalidate(path); }
      catch (reason) { diagnostics.statusInvalidationError = String(reason); }
      throw error;
    }
    await work();
  } catch (error) {
    fail(error);
    report.error = String(error);
  } finally {
    finishedAt = new Date().toISOString();
    try {
      await io.write(path, snapshot());
    } catch (error) {
      diagnostics.statusWriteError = String(error);
      fail(error);
      // A persisted start remains "running", never a fabricated completion.
      // Failed initial writes were invalidated above; do not touch another run.
    } finally {
      try { await unlock(); }
      catch (error) { diagnostics.unlockError = String(error); fail(error); }
      io.log({ ...snapshot(), started });
    }
  }
  // Keep the original collection/start failure when persistence or cleanup also fails.
  if (failure) throw failure.reason;
}
