import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Catalog, Prompt } from "../packages/schema/catalog.ts";
import { createTestDatabase } from "../services/feed/test-database.ts";
import { activatePublication, stagePublication, exportPublication } from "../services/feed/publication.ts";
import { databasePublisher, assertDatabaseReconciled } from "./database-publication.ts";
import { beginDailyPublication, prepareDailyStaging, publishDailyCatalog } from "./daily-publication.ts";
import { compatibilityCatalog, loadPublicationState, stageRelease, readPublishedState, type ReleaseTransport } from "./release-publication.ts";
import { atomic, base, digest, editionVersion, manifestSchema, serializeCatalog } from "./publication.ts";
import { recoverRelease, type RecoveryTransport } from "./recovery.ts";
import { interleaveLibrary, retainPublishedLibrary } from "./library.ts";

function prompt(index: number): Prompt {
  return { id: `fixture-${index}`, kind: "text", title: `Fixture ${index}`, summary: "First-party test fixture",
    prompt: `  Write an original tea story ${index}.\n`, example: "An example", tags: ["test"], model: "Any", toolURL: null,
    artwork: "test", previewLabel: "Preview", source: { name: "Prompix", url: null, license: "Original", method: "Written for tests" }, media: null };
}
function catalog(count: number): Catalog {
  const prompts = Array.from({ length: count }, (_, i) => prompt(i));
  return { schemaVersion: 1, version: editionVersion(prompts, []), publishedAt: "2026-10-14T00:00:00.000Z", prompts, removedIDs: [] };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "prompix-database-publication-"));
  const { pg, writer } = await createTestDatabase(), original = catalog(2);
  const initial = await stagePublication(writer, original);
  await activatePublication(writer, initial, "0");
  const publisher = databasePublisher(operation => operation(writer));
  const manifest = manifestSchema.parse({ schemaVersion: 1, version: original.version, publishedAt: original.publishedAt,
    count: 2, sha256: digest(serializeCatalog(original)), catalog: `${base}/releases/${original.version}/catalog.json` });
  const files = new Map([[`${base}/v1/latest.json`, Buffer.from(JSON.stringify(manifest))], [manifest.catalog, serializeCatalog(original)]]);
  let fail: ((key: string) => void) | undefined;
  const transport: ReleaseTransport = {
    database: publisher,
    async read(url) { const bytes = files.get(url); return bytes ? { status: 200, bytes } : { status: 404 }; },
    async upload(key, path) { fail?.(key); files.set(`${base}/${key}`, await readFile(path)); },
  };
  return { root, pg, writer, initial, publisher, transport, files,
    failUpload: (callback?: typeof fail) => { fail = callback; },
    start: () => beginDailyPublication(root, { resumePublishing: false }, transport),
    cleanup: async () => { await pg.close(); await rm(root, { force: true, recursive: true }); } };
}

test("database input retains 1,201 items while legacy exports remain bounded and preserve raw text", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const next = catalog(1201), preparation = await f.start();
  const result = await publishDailyCatalog(f.root, next, preparation, f.transport);
  assert.equal(result.authoritative.prompts.length, 1201);
  assert.deepEqual(result.authoritative.prompts, next.prompts);
  assert.equal(result.v2!.catalog.prompts.length, 1000);
  assert.deepEqual(result.v2!.catalog.prompts, next.prompts.slice(0, 1000));
  assert.equal((await f.start()).previous!.authoritative.prompts.length, 1201);
  assert.equal((await loadPublicationState(f.root)).databaseInitialized, true);
  const retained = retainPublishedLibrary(next.prompts.slice(0, 5), result.authoritative.prompts, new Set(), undefined, 100000);
  assert.equal(retained.prompts.length, 1201);
  assert.equal(interleaveLibrary(next.prompts, [], new Set(), 100000).length, 1201);
  assert.throws(() => interleaveLibrary(next.prompts, [], new Set()), /1000-entry/);
  // Idempotent replay does not manufacture another activation or erase rows outside the window.
  const before = await f.publisher.pointer();
  await publishDailyCatalog(f.root, next, await f.start(), f.transport);
  assert.deepEqual(await f.publisher.pointer(), before);
});

test("compatibility export respects the decoded byte limit without hiding malformed records", () => {
  const next = catalog(600);
  for (const item of next.prompts) item.prompt = "word ".repeat(5900);
  const projected = compatibilityCatalog(next);
  assert.ok(projected.prompts.length < 600 && projected.prompts.length > 100);
  assert.equal(next.prompts.length, 600);
  const invalid = catalog(4); invalid.prompts[2].artwork = "Invalid Artwork";
  assert.throws(() => compatibilityCatalog(invalid));
});

test("partial activation resumes the persisted target without another input or paid batch", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const next = catalog(1003);
  f.failUpload(key => { if (key === "v2/latest.json") throw new Error("Storage offline"); });
  await assert.rejects(publishDailyCatalog(f.root, next, await f.start(), f.transport), /Storage offline/);
  const pending = (await loadPublicationState(f.root)).pending!;
  assert.equal((await f.publisher.pointer()).release, pending.database!.release);
  assert.equal(f.files.has(`${base}/v2/latest.json`), false);
  await assert.rejects(prepareDailyStaging(f.root, {}, f.transport), /Resume or roll back/);
  f.failUpload();
  const resumed = await f.start();
  assert.deepEqual(resumed.recovered!.authoritative.prompts, next.prompts);
  assert.equal((await loadPublicationState(f.root)).pending, undefined);
  assert.equal((await f.publisher.pointer()).generation, "2");
});

test("a new removal corrects the full retained target and both compatibility channels on retry", async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.failUpload(key => { if (key === "v1/latest.json") throw new Error("Legacy pointer offline"); });
  const next = catalog(1004);
  await assert.rejects(publishDailyCatalog(f.root, next, await f.start(), f.transport), /Legacy pointer offline/);
  await atomic(join(f.root, "moderation.json"), { removedIDs: ["fixture-0", "fixture-1003"] });
  f.failUpload();
  const recovered = (await f.start()).recovered!;
  assert.equal(recovered.authoritative.prompts.length, 1002);
  for (const target of [recovered.authoritative, recovered.v1.catalog, recovered.v2!.catalog]) {
    assert.deepEqual(target.removedIDs, ["fixture-0", "fixture-1003"]);
    assert.ok(target.prompts.every(item => !target.removedIDs!.includes(item.id)));
  }
  assert.equal((await loadPublicationState(f.root)).pending, undefined);
});

test("database failure and concurrent publication cannot silently revert to the legacy window", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const preparation = await f.start();
  const competing = catalog(3), competingID = await stagePublication(f.writer, competing);
  await activatePublication(f.writer, competingID, preparation.previous!.database!.generation);
  await assert.rejects(publishDailyCatalog(f.root, catalog(4), preparation, f.transport), /Database publication changed/);
  assert.equal((await f.publisher.pointer()).release, competingID);
  assert.equal((await loadPublicationState(f.root)).pending, undefined);
  const failed = { ...f.transport, database: { ...f.publisher, pointer: async () => { throw new Error("Database offline"); } } };
  await assert.rejects(beginDailyPublication(f.root, { resumePublishing: false }, failed), /Database offline/);
  const target = { release: competingID, observed: { release: f.initial, generation: "1" } };
  assertDatabaseReconciled(target, { release: competingID, generation: "2" });
  assert.throws(() => assertDatabaseReconciled(target, { release: competingID, generation: "4" }), /changed/);
});

test("database rollback requires a full DB release, preserves tombstones and creates a durable hold", async t => {
  const f = await fixture(); t.after(f.cleanup);
  await publishDailyCatalog(f.root, catalog(1101), await f.start(), f.transport);
  const target = (await f.publisher.pointer()).release;
  const next = catalog(1201); next.prompts.shift(); next.removedIDs = ["fixture-0"];
  await publishDailyCatalog(f.root, next, await f.start(), f.transport);
  const recovery: RecoveryTransport = {
    currentManifest: async () => { throw new Error("Unexpected legacy path"); },
    remoteCatalog: async () => { throw new Error("Unexpected legacy path"); },
    upload: async () => { throw new Error("Unexpected legacy path"); }, verifyMedia: async () => {},
  };
  const legacyVersion = (await readPublishedState(f.root, {}, f.transport)).v2!.manifest.version;
  await assert.rejects(recoverRelease(f.root, legacyVersion, false, recovery, f.transport), /full feed release ID/);
  await recoverRelease(f.root, target, true, recovery, f.transport);
  const restored = await exportPublication(f.writer);
  assert.equal(restored.prompts.length, 1100);
  assert.deepEqual(restored.removedIDs, ["fixture-0"]);
  assert.ok((await f.start()).held);
});
