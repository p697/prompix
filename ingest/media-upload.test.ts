import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retryMediaUpload } from "./media-upload.ts";

async function fixture(run: (key: string, path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "prompix-media-retry-"));
  const bytes = Buffer.from("fixture image bytes"), path = join(root, "preview.jpg");
  const key = `media/${createHash("sha256").update(bytes).digest("hex")}.jpg`;
  try { await writeFile(path, bytes); await run(key, path); } finally { await rm(root, { recursive: true, force: true }); }
}
test("identical media retries transient Cloudflare failures with bounded backoff", () => fixture(async (key, path) => {
  let calls = 0; const waits: number[] = [];
  await retryMediaUpload(key, path, async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("CLI failed"), { stderr: "Failed to fetch /accounts/fixture - 500: Internal Server Error" });
    if (calls === 2) throw new Error("fetch failed");
  }, async ms => { waits.push(ms); });
  assert.equal(calls, 3); assert.deepEqual(waits, [1000, 3000]);
}));
test("media retry stops at three requests and does not expose raw CLI diagnostics", () => fixture(async (key, path) => {
  let calls = 0;
  await assert.rejects(retryMediaUpload(key, path, async () => { calls++; throw new Error("503: fixture-secret-token"); }, async () => {}),
    error => error instanceof Error && /3 attempt/.test(error.message) && !error.message.includes("fixture-secret-token"));
  assert.equal(calls, 3);
}));
test("authentication failures and long Retry-After do not retry", () => fixture(async (key, path) => {
  for (const message of ["403: Authentication failed", "fetch failed: CERT_HAS_EXPIRED", "429: Too many requests\nRetry-After: 120"]) {
    let calls = 0;
    await assert.rejects(retryMediaUpload(key, path, async () => { calls++; throw new Error(message); }, async () => assert.fail("Must not wait")));
    assert.equal(calls, 1);
  }
}));
test("mutable publication pointers and changed media bytes cannot be replayed", () => fixture(async (key, path) => {
  let calls = 0;
  await assert.rejects(retryMediaUpload("v2/latest.json", path, async () => { calls++; throw new Error("500: uncertain pointer write"); }), /uncertain pointer/);
  assert.equal(calls, 1); calls = 0;
  await assert.rejects(retryMediaUpload(key, path, async () => { calls++; await writeFile(path, "different bytes"); throw new Error("500: failure"); }, async () => {}), /bytes changed/);
  assert.equal(calls, 1);
  await assert.rejects(retryMediaUpload(key, path, async () => { calls++; }), /bytes changed/);
  assert.equal(calls, 1);
}));
