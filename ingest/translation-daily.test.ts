import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareDailyTranslations } from "./translation-daily.ts";

test("a translation lock left by a dead run is taken over; a live one still means busy", async t => {
  const root = await mkdtemp(join(tmpdir(), "prompix-translation-lock-")); t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, "translations", "run.lock"), env = { PROMPIX_TRANSLATION_PROVIDER: "codex" };
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
  assert.equal((await prepareDailyTranslations([], root, env)).report.status, "busy");
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 2 ** 22 + 12345 }));
  assert.equal((await prepareDailyTranslations([], root, env)).report.status, "updated");
  await assert.rejects(access(lock), "the lock is released after the run");
});
