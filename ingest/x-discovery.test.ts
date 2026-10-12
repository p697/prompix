import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverX } from "./x-discovery.ts";
import { searchX, xSearchFingerprint, xSearchRequest } from "./x.ts";

const now = new Date("2026-10-13T00:00:00Z");
const stateFile = (root: string) => join(root, "x-state.json");
const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "prompix-x-discovery-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function result(since?: string, newest?: string) {
  // Coverage is opaque to the scheduler; the search adapter validates its fields.
  return { posts: [], creators: [], media: [], newest, request: xSearchRequest(since),
    coverage: {} as Awaited<ReturnType<typeof searchX>>["coverage"] };
}

test("legacy global daily reservation survives a changed query without a second paid request", () => fixture(async root => {
  const legacy = { day: "2026-10-13", newest: "900" };
  await writeFile(stateFile(root), JSON.stringify(legacy));
  let calls = 0;
  const run = await discoverX(root, { publishing: true, bearer: "fixture-secret", now,
    search: async () => { calls++; return result(); } });
  assert.equal(run.report.status, "daily-limit"); assert.equal(calls, 0);
  assert.equal(run.report.cursorUsed, undefined);
  assert.deepEqual(await read(stateFile(root)), legacy);
}));

test("new query ignores unscoped and other-query cursors, persisting its snapshot before progress", () => fixture(async root => {
  const other = "a".repeat(64);
  await writeFile(stateFile(root), JSON.stringify({ day: "2026-10-12", newest: "999", cursors: { [other]: "888" } }));
  const run = await discoverX(root, { publishing: true, bearer: "fixture-secret", now, search: async (_bearer, since) => {
    assert.equal(since, undefined);
    assert.equal((await read(stateFile(root))).day, "2026-10-13", "Reserve before paid call");
    const attempt = await read(join(root, "x-search-attempts/2026-10-13.json"));
    assert.equal(attempt.state, "reserved"); assert.equal(attempt.request.fingerprint, xSearchFingerprint);
    return result(since, "200");
  } });
  assert.equal(run.report.status, "ok");
  const state = await read(stateFile(root));
  assert.equal(state.cursors[xSearchFingerprint], "200"); assert.equal(state.cursors[other], "888");
  assert.equal((await read(join(root, "x-discovery/2026-10-13.json"))).newest, "200");
  assert.equal((await read(join(root, "x-search-attempts/2026-10-13.json"))).state, "completed");
}));

test("same query resumes its own cursor and keeps it on a verified empty result", () => fixture(async root => {
  await writeFile(stateFile(root), JSON.stringify({ cursors: { [xSearchFingerprint]: "200" } }));
  let calls = 0;
  const options = { publishing: true, bearer: "fixture-secret", now, search: async (_bearer: string, since?: string) => {
    calls++; assert.equal(since, "200"); return result(since);
  } };
  const first = await discoverX(root, options);
  assert.equal(first.report.status, "ok"); assert.equal(first.report.cursorUsed, "200");
  assert.equal((await read(stateFile(root))).cursors[xSearchFingerprint], "200");
  assert.equal((await discoverX(root, options)).report.status, "daily-limit"); assert.equal(calls, 1);
}));

test("timeout consumes today's budget without advancing cursor or leaking credentials", () => fixture(async root => {
  await writeFile(stateFile(root), JSON.stringify({ cursors: { [xSearchFingerprint]: "200" } }));
  let calls = 0;
  const options = { publishing: true, bearer: "fixture-secret", now, search: async () => {
    calls++; throw new Error("timeout fixture-secret");
  } };
  const run = await discoverX(root, options);
  assert.equal(run.report.status, "failed"); assert.equal(run.report.requests, 1);
  assert.equal(run.report.message?.includes("fixture-secret"), false);
  assert.equal((await read(stateFile(root))).cursors[xSearchFingerprint], "200");
  assert.equal((await discoverX(root, options)).report.status, "daily-limit"); assert.equal(calls, 1);
  assert.equal((await readFile(join(root, "x-search-attempts/2026-10-13.json"), "utf8")).includes("fixture-secret"), false);
}));

test("snapshot write failure preserves cursor and prevents an ambiguous response retry", () => fixture(async root => {
  await writeFile(stateFile(root), JSON.stringify({ cursors: { [xSearchFingerprint]: "200" } }));
  await mkdir(join(root, "x-discovery/2026-10-13.json"), { recursive: true });
  const options = { publishing: true, bearer: "fixture-secret", now, search: async (_bearer: string, since?: string) => result(since, "201") };
  const run = await discoverX(root, options);
  assert.equal(run.report.status, "failed");
  assert.equal((await read(stateFile(root))).cursors[xSearchFingerprint], "200");
  assert.equal((await discoverX(root, options)).report.status, "daily-limit");
}));

test("mismatched request identity and malformed cursor cannot be installed", () => fixture(async root => {
  const first = await discoverX(root, { publishing: true, bearer: "fixture-secret", now, search: async () => ({
    ...result(), request: { ...xSearchRequest(), requestFingerprint: "a".repeat(64) },
  }) });
  assert.equal(first.report.status, "failed"); assert.deepEqual((await read(stateFile(root))).cursors, {});
  const next = await discoverX(root, { publishing: true, bearer: "fixture-secret", now: new Date("2026-10-14T00:00:00Z"),
    search: async () => result(undefined, "invalid") });
  assert.equal(next.report.status, "failed"); assert.deepEqual((await read(stateFile(root))).cursors, {});
}));

test("dry-run and missing configuration neither call a provider nor reserve a budget", () => fixture(async root => {
  let calls = 0;
  const search = async () => { calls++; return result(); };
  assert.equal((await discoverX(root, { publishing: false, bearer: "fixture-secret", now, search })).report.status, "dry-run");
  assert.equal((await discoverX(root, { publishing: true, now, search })).report.status, "not-configured");
  assert.equal(calls, 0);
  await assert.rejects(readFile(stateFile(root)), { code: "ENOENT" });
}));

test("invalid budget state fails closed before a paid request", () => fixture(async root => {
  await writeFile(stateFile(root), JSON.stringify({ day: 12, cursors: {} }));
  let calls = 0;
  await assert.rejects(discoverX(root, { publishing: true, bearer: "fixture-secret", now,
    search: async () => { calls++; return result(); } }));
  assert.equal(calls, 0);
}));
