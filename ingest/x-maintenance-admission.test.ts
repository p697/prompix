import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomic, json } from "./publication.ts";
import { prepareXMaintenanceAdmission, publishedXIdentities } from "./x-maintenance-admission.ts";
import { prepareXAvailability, filterXAvailability } from "./x-availability.ts";
import { convertXDiscovery } from "./x-intake.ts";
import { editorialDecisionKey, editorialModel } from "./editorial-runner.ts";
import { createTestDatabase } from "../services/feed/test-database.ts";
import { stagePublication, activatePublication, removeContent } from "../services/feed/publication.ts";
import type { Prompt } from "../packages/schema/catalog.ts";

const capturedAt = "2026-10-16T00:00:00.000Z", now = "2026-10-17T10:00:00.000Z";
const creator = { id: "x-id-9", externalID: "9", platform: "x" as const, username: "fixture", displayName: "Fixture", profileURL: "https://x.com/fixture" };
const post = (id: string, created_at = capturedAt) => ({ id, author_id: "9", created_at,
  text: `Text prompt:\nWrite an original three-scene story with theme ${id}. Ask me about my audience and subject before you begin, and finish with a surprising but coherent ending.` });
const capture = (ids: string[], at = capturedAt) => ({ capturedAt: at, posts: ids.map(id => post(id, at)), creators: [creator], media: [] });
const admission = (maxDrafts = 0, publishedIDs: string[] = [], attemptedIDs: string[] = []) => ({ maxDrafts, publishedIDs: new Set(publishedIDs), attemptedIDs: new Set(attemptedIDs) });
async function fixture(t: { after: (action: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "prompix-x-admission-")); t.after(() => rm(root, { recursive: true, force: true })); return root;
}
const neverLookup = async () => { throw new Error("Unexpected paid X request"); };

test("unreviewed backlog does not buy checks without editorial slots or gain false freshness", async t => {
  const root = await fixture(t), ids = Array.from({ length: 300 }, (_, index) => String(1000 + index));
  for (let n = 0; n < ids.length; n += 100) await atomic(join(root, "x-discovery", `2026-10-16-feed-${String(n / 100 + 1).padStart(3, "0")}.json`), capture(ids.slice(n, n + 100)));
  const result = await prepareXAvailability(root, { enabled: true, bearer: "fixture", now, admission: admission(), lookup: neverLookup,
    recheck: { maxRequests: 16, sleep: async () => {}, lookup: neverLookup } });
  assert.equal(result.report.deferredDrafts, 300); assert.equal(result.report.requests, 0);
  assert.equal(result.report.recheck?.requests, 0); assert.deepEqual(result.state, {});
  assert.equal(filterXAvailability(convertXDiscovery([{ name: "fixture", data: capture(ids.slice(0, 100)) }]).candidates, result.state, Date.parse(now)).prompts.length, 0);
});

test("draft admission checks only the bounded review queue and becomes available when capacity opens", async t => {
  const root = await fixture(t); await atomic(join(root, "x-discovery", "2026-10-16.json"), capture(["101", "102", "103", "104"]));
  const calls: string[][] = [];
  const lookup = async (_: string, ids: readonly string[]) => { calls.push([...ids]); return { ...capture([...ids], now), unavailable: [] }; };
  const first = await prepareXAvailability(root, { enabled: true, bearer: "fixture", now, admission: admission(1), lookup });
  assert.deepEqual(calls, [["101"]]); assert.equal(first.report.deferredDrafts, 3);
  assert.equal(first.state["x-post-101"].status, "ready"); assert.equal(first.state["x-post-102"], undefined);
  const next = await prepareXAvailability(root, { enabled: true, bearer: "fixture", now, admission: admission(3, [], ["x-post-101"]), lookup });
  assert.deepEqual(calls[1], ["102", "103", "104"]); assert.equal(next.report.deferredDrafts, 0);
});

test("fresh unreviewed discoveries occupy slots without duplicate payment or renewed source age", async t => {
  const root = await fixture(t); await atomic(join(root, "x-discovery", "2026-10-16.json"), capture(["101"]));
  const fresh = "2026-10-17T09:00:00.000Z";
  await atomic(join(root, "x-discovery", "2026-10-17.json"), capture(["102"], fresh));
  const result = await prepareXAvailability(root, { enabled: true, bearer: "fixture", now, admission: admission(1), lookup: neverLookup });
  assert.equal(result.report.reusedDiscovery, 1); assert.equal(result.report.deferredDrafts, 1);
  assert.equal(result.state["x-post-102"].checkedAt, fresh); assert.equal(result.state["x-post-101"], undefined);
});

test("published and previously approved identities bypass draft admission even after missing or rejected reviews", async t => {
  const root = await fixture(t), data = capture(["101", "102", "103"]);
  await atomic(join(root, "x-discovery", "2026-10-16.json"), data);
  const candidates = convertXDiscovery([{ name: "fixture", data }]).candidates;
  const a = candidates.find(c => c.id === "x-post-101")!, b = candidates.find(c => c.id === "x-post-102")!;
  await atomic(join(root, "editorial", "decisions.json"), { version: 1, decisions: Object.fromEntries([[a, "reject"], [b, "approve"]].map(([item, decision]) => {
    const c = item as typeof a; return [editorialDecisionKey(c), { id: c.id, fingerprint: c.fingerprint, sourceRevision: c.source.revision,
      decision, reason: "Fixture review", metadata: null, reviewedAt: capturedAt, model: "fixture" }];
  })) });
  const result = await prepareXAvailability(root, { enabled: true, bearer: "fixture", now, admission: admission(0, [a.id], [a.id, b.id]),
    lookup: async (_, ids) => { assert.deepEqual(ids, ["101", "102"]); return { posts: [], creators: [], media: [], unavailable: [...ids] }; } });
  assert.equal(result.state[a.id].removed, true); assert.equal(result.state[b.id].removed, true);
  assert.equal(result.report.deferredDrafts, 1); assert.equal(result.report.skippedInactive, 0);
});

test("editorial capacity respects window, attempts, failures and provider disablement without rewriting ledgers", async t => {
  const root = await fixture(t), date = new Date(now), env = { PROMPIX_DATABASE_ENABLED: "true", PROMPIX_EDITORIAL_PROVIDER: "codex", PROMPIX_EDITORIAL_MAX_REQUESTS: "8" };
  const published = async () => new Set(["x-post-101"]);
  assert.equal((await prepareXMaintenanceAdmission(root, env, date, published))!.maxDrafts, 12);
  const path = join(root, "editorial", "daily-attempts", "2026-10-17.json");
  const attempt = { day: "2026-10-17", requests: 1, model: editorialModel, reservedAt: now, candidateIDs: ["x-post-102"], inputCharacters: 100, state: "completed" };
  await atomic(path, attempt);
  const ready = await prepareXMaintenanceAdmission(root, env, date, published);
  assert.equal(ready!.maxDrafts, 9); assert.deepEqual([...ready!.attemptedIDs], ["x-post-102"]);
  assert.deepEqual(await json(path, null), attempt);
  for (const state of ["reserved", "failed"]) {
    await atomic(path, { ...attempt, state });
    assert.equal((await prepareXMaintenanceAdmission(root, env, date, published))!.maxDrafts, 0);
  }
  assert.equal((await prepareXMaintenanceAdmission(root, { ...env, PROMPIX_EDITORIAL_PROVIDER: undefined }, date, published))!.maxDrafts, 0);
  assert.equal(await prepareXMaintenanceAdmission(root, {}, date, neverLookup), undefined);
  await assert.rejects(prepareXMaintenanceAdmission(root, env, date, async () => { throw new Error("DB unavailable"); }), /DB unavailable/);
  await atomic(path, { ...attempt, day: "2026-10-16" });
  await assert.rejects(prepareXMaintenanceAdmission(root, env, date, published), /day mismatch/);
});

test("published-history query excludes staging and keeps retired/removed identities across rollback", async t => {
  const { pg, writer } = await createTestDatabase(); t.after(() => pg.close());
  await assert.rejects(publishedXIdentities(writer), /initialized/);
  const item = (id: string): Prompt => ({ id, kind: "text", title: id, summary: "Fixture", prompt: "Write an original short story.", example: "A garden.", tags: ["fixture"],
    model: "test", toolURL: null, artwork: "test", previewLabel: "Preview", source: { name: "Prompix", url: null, license: "Original", method: "Fixture" }, media: null });
  const a = await stagePublication(writer, { schemaVersion: 1, prompts: [item("x-post-101"), item("other")], version: "fixture" });
  await activatePublication(writer, a, "0");
  const b = await stagePublication(writer, { schemaVersion: 1, prompts: [item("x-post-102")], version: "fixture" });
  assert.deepEqual([...await publishedXIdentities(writer)], ["x-post-101"]);
  await activatePublication(writer, b, "1"); await removeContent(writer, ["x-post-102"], "Fixture withdrawal");
  assert.deepEqual([...await publishedXIdentities(writer)], ["x-post-101", "x-post-102"]);
});
