import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshCreatorProfiles } from "./creator-refresh.ts";
import { creatorFromURL } from "./creators.ts";
import type { Prompt } from "../packages/schema/catalog.ts";

function item(username: string): Prompt {
  return {
    id: username, kind: "text", title: username, summary: "Test", prompt: "Test", example: "Test", tags: ["Test"], model: "Test",
    artwork: "test", toolURL: null, previewLabel: "Test", media: null,
    source: { name: "Test", url: `https://x.com/${username}/status/123`, license: "Original", method: "Test" },
    creator: creatorFromURL(`https://x.com/${username}`),
  };
}

test("creator refresh is opt-in, never charges in dry-run, and records at most twenty authors before its one request", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-creators-"));
  let calls = 0;
  const lookup = async (_: string, names: readonly string[]) => {
    calls++;
    const attempt = JSON.parse(await readFile(join(root, "x-creator-attempts/2026-10-12.json"), "utf8"));
    assert.equal(attempt.status, "attempted");
    assert.equal(names.length, 20);
    return { creators: names.map((name, index) => ({ ...creatorFromURL(`https://x.com/${name}`)!, externalID: String(1000 + index) })), errors: [] };
  };
  const items = Array.from({ length: 25 }, (_, index) => item(`studio${index}`));
  const options = { enabled: true, publishing: true, bearer: "synthetic-test-token", now: new Date("2026-10-12T08:00:00Z"), lookup };
  try {
    assert.equal((await refreshCreatorProfiles(items, {}, root, { ...options, enabled: false })).report.status, "disabled");
    assert.equal((await refreshCreatorProfiles(items, {}, root, { ...options, publishing: false })).report.status, "dry-run");
    assert.equal(calls, 0);
    const first = await refreshCreatorProfiles(items, {}, root, options);
    assert.equal(first.report.requests, 1);
    assert.equal(first.report.returnedAuthors, 20);
    assert.equal(first.cache["x-studio0"].id, "x-id-1000");
    assert.equal((await refreshCreatorProfiles(items, first.cache, root, options)).report.status, "daily-limit");
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ambiguous paid failure cannot retry that day and unresolved accounts are suppressed for thirty days", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-creators-"));
  let calls = 0;
  const options = { enabled: true, publishing: true, bearer: "synthetic-test-token", now: new Date("2026-10-12T08:00:00Z") };
  try {
    const fail = async () => { calls++; throw new Error("Ambiguous network response"); };
    const first = await refreshCreatorProfiles([item("missing")], {}, root, { ...options, lookup: fail });
    assert.equal(first.report.status, "failed");
    assert.equal(first.report.requests, 1);
    assert.equal((await refreshCreatorProfiles([item("missing")], {}, root, { ...options, lookup: fail })).report.requests, 0);
    assert.equal(calls, 1);
    const empty = async () => { calls++; return { creators: [], errors: [{ value: "missing", type: "https://api.x.com/2/problems/resource-not-found" }] }; };
    const next = await refreshCreatorProfiles([item("missing")], {}, root, { ...options, now: new Date("2026-10-13T08:00:00Z"), lookup: empty });
    assert.equal(next.report.missingAuthors, 1);
    assert.equal((await refreshCreatorProfiles([item("missing")], {}, root, { ...options, now: new Date("2026-10-14T08:00:00Z"), lookup: empty })).report.status, "current");
    assert.equal(calls, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
