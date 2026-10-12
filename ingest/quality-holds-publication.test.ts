import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localizationLanguages, type Catalog, type Prompt } from "../packages/schema/catalog.ts";
import { beginDailyPublication, publishDailyCatalog } from "./daily-publication.ts";
import { retainPublishedLibrary } from "./library.ts";
import { atomic, base, digest, editionVersion, manifestSchema, serializeCatalog, verifyCatalog } from "./publication.ts";
import { applyQualityHolds, qualityHoldIdentity, qualityHoldsSchema, readQualityHolds } from "./quality-holds.ts";
import { recoverRelease, type RecoveryTransport } from "./recovery.ts";
import { loadPublicationState, publishRelease, readLocalRelease, readPublishedState, resumePublication, stageRelease,
  type ReleaseTransport } from "./release-publication.ts";
import { translationFingerprint } from "./translation.ts";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
function prompt(id: string): Prompt {
  const text = { title: id, summary: "Original quality-hold fixture.", prompt: `Write an original story about the ${id} teacup.`,
    example: "The teacup grew wings.", previewLabel: "Preview" };
  const item: Prompt = { id, kind: "text", ...text, tags: ["test"], model: "Any", toolURL: null, artwork: "test",
    source: { name: "Prompix", url: null, license: "Original", method: "Written for tests" }, media: null };
  item.localization = { sourceLanguage: "en", sourceFingerprint: translationFingerprint(item),
    translations: Object.fromEntries(localizationLanguages.map(locale => [locale, { ...text, title: `${id} ${locale}` }])) };
  return item;
}
function catalog(prompts: Prompt[], removedIDs: string[] = []): Catalog {
  return { schemaVersion: 1, version: editionVersion(prompts, removedIDs), publishedAt: "2026-10-01T00:00:00.000Z", prompts, removedIDs };
}
function manifest(value: Catalog) {
  return manifestSchema.parse({ schemaVersion: 1, version: value.version, publishedAt: value.publishedAt, count: value.prompts.length,
    sha256: digest(serializeCatalog(value)), catalog: `${base}/releases/${value.version}/catalog.json` });
}
function holdsFor(item: Prompt) {
  return qualityHoldsSchema.parse({ schemaVersion: 1, holds: { [item.id]: {
    sourceIdentitySHA256: qualityHoldIdentity(item), reason: "Synthetic incomplete source requiring review",
    evidenceSHA256: digest(Buffer.from("Original synthetic review evidence")), reviewerID: "test-reviewer",
    reviewedAt: "2026-10-12T00:00:00.000Z",
  } } });
}
async function releaseBytes(root: string) {
  const files: Record<string, Buffer> = {};
  async function walk(path: string, prefix = "") {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(path, entry.name), name + "/");
      else files[name] = await readFile(join(path, entry.name));
    }
  }
  await walk(join(root, "releases"));
  return files;
}
async function fixture(frozen = false) {
  const root = await mkdtemp(join(tmpdir(), "prompix-quality-holds-"));
  const original = catalog([prompt("keep"), prompt("held")]), first = manifest(original);
  const files = new Map<string, Buffer>([[`${base}/v1/latest.json`, encode(first)], [first.catalog, serializeCatalog(original)]]);
  await atomic(join(root, "releases", original.version, "manifest.json"), first);
  await writeFile(join(root, "releases", original.version, "catalog.json"), serializeCatalog(original));
  const calls: string[] = [];
  let beforeUpload: ((key: string) => Promise<void> | void) | undefined;
  const transport: ReleaseTransport = {
    async read(url) { calls.push(`read:${url}`); const bytes = files.get(url); return bytes ? { status: 200, bytes: Buffer.from(bytes) } : { status: 404 }; },
    async upload(key, path) { calls.push(`upload:${key}`); await beforeUpload?.(key); files.set(`${base}/${key}`, await readFile(path)); },
  };
  if (frozen) {
    const previous = await readPublishedState(root, { allowBootstrap: true }, transport);
    await publishRelease(root, await stageRelease(root, original, previous), previous.observed, { operation: "daily" }, transport);
    await atomic(join(root, "publication-state.json"), { schemaVersion: 1, v2Initialized: true, v1Frozen: true });
  }
  const previous = await readPublishedState(root, { allowBootstrap: true }, transport);
  calls.length = 0;
  return { root, original, previous, files, calls, transport,
    held: original.prompts[1],
    pointers: () => [files.get(`${base}/v1/latest.json`), files.get(`${base}/v2/latest.json`)],
    beforeUpload(callback?: typeof beforeUpload) { beforeUpload = callback; },
    hold: () => atomic(join(root, "quality-holds.json"), holdsFor(original.prompts[1])),
    cleanup: () => rm(root, { recursive: true, force: true }) };
}
const uploads = (calls: string[]) => calls.filter(call => call.startsWith("upload:"));

test("daily retention cannot resurrect quality-held content or convert it into a tombstone", async () => {
  const f = await fixture();
  try {
    await f.hold();
    const preparation = await beginDailyPublication(f.root, { resumePublishing: true, env: { PROMPIX_LANGUAGE_PACKS_ENABLED: "true" } }, f.transport);
    const retained = retainPublishedLibrary([prompt("new")], preparation.previous!.authoritative.prompts, new Set());
    assert.ok(retained.prompts.some(item => item.id === "held"), "Retention alone restores the older snapshot");
    const originalBytes = encode(retained.prompts), holds = await readQualityHolds(f.root);
    const filtered = applyQualityHolds(retained.prompts, holds);
    assert.deepEqual(filtered.withheldIDs, ["held"]);
    assert.deepEqual(encode(retained.prompts), originalBytes, "Filtering must not edit the retained source or translations");
    const published = await publishDailyCatalog(f.root, catalog(filtered.prompts), preparation, f.transport);
    for (const value of [published.authoritative, published.v1.catalog]) {
      assert.deepEqual(value.prompts.map(item => item.id), ["new", "keep"]);
      assert.deepEqual(value.removedIDs, []);
      assert.deepEqual(value.prompts.find(item => item.id === "keep"), f.original.prompts[0]);
    }
    const revised = structuredClone(f.held); revised.prompt += " A proposed repair still awaiting review.";
    assert.notEqual(qualityHoldIdentity(revised), qualityHoldIdentity(f.held));
    const nextRetained = retainPublishedLibrary([revised], published.authoritative.prompts, new Set());
    assert.equal(applyQualityHolds(nextRetained.prompts, holds).prompts.some(item => item.id === "held"), false,
      "Changed source bytes cannot clear a hold without explicit review");
  } finally { await f.cleanup(); }
});

test("staging rejects directly supplied held items before changing artifacts or publication state", async () => {
  const f = await fixture();
  try {
    await f.hold();
    const before = await releaseBytes(f.root), state = await loadPublicationState(f.root), pointers = f.pointers();
    await assert.rejects(stageRelease(f.root, catalog([...f.original.prompts, prompt("new")]), f.previous), /quality hold/i);
    assert.deepEqual(await releaseBytes(f.root), before);
    assert.deepEqual(await loadPublicationState(f.root), state);
    assert.deepEqual(f.pointers(), pointers);
    assert.deepEqual(uploads(f.calls), []);
  } finally { await f.cleanup(); }
});

test("frozen v1 discovery evicts held carryover without adding tombstones or new v2 items", async () => {
  const f = await fixture(true);
  try {
    await f.hold();
    const holdBytes = await readFile(join(f.root, "quality-holds.json"));
    const oldBytes = Buffer.from(f.files.get(f.previous.v1.manifest.catalog)!);
    const next = catalog([f.original.prompts[0], prompt("v2-only")]);
    const staged = await stageRelease(f.root, next, f.previous);
    assert.equal(staged.freezeV1, true);
    assert.notEqual(staged.targets.v1.version, f.previous.v1.manifest.version);
    const result = await publishRelease(f.root, staged, f.previous.observed, { operation: "daily" }, f.transport);
    assert.deepEqual(result.v1.catalog.prompts, [f.original.prompts[0]]);
    assert.deepEqual(result.v1.catalog.removedIDs, []);
    assert.deepEqual(result.authoritative, next);
    assert.deepEqual(f.files.get(f.previous.v1.manifest.catalog), oldBytes, "Historical artifacts remain immutable");
    assert.deepEqual(await readFile(join(f.root, "quality-holds.json")), holdBytes);
  } finally { await f.cleanup(); }
});

for (const channel of ["v2", "frozen-v1-only"] as const) test(`new quality hold blocks pending ${channel} activation and preserves its immutable intent`, async () => {
  const f = await fixture(channel === "frozen-v1-only");
  try {
    const next = catalog([...(channel === "v2" ? f.original.prompts : [f.original.prompts[0]]), prompt("new")]);
    const staged = await stageRelease(f.root, next, f.previous);
    f.beforeUpload(() => { throw new Error("Synthetic interrupted upload"); });
    await assert.rejects(publishRelease(f.root, staged, f.previous.observed, { operation: "daily" }, f.transport), /Synthetic interrupted upload/);
    assert.ok((await loadPublicationState(f.root)).pending);
    if (channel === "frozen-v1-only") {
      assert.equal((await readLocalRelease(f.root, staged.targets.v2.version)).prompts.some(item => item.id === "held"), false);
      assert.equal(staged.targets.v1.version, f.original.version);
    }
    f.beforeUpload(); await f.hold();
    const state = await readFile(join(f.root, "publication-state.json")), artifacts = await releaseBytes(f.root), pointers = f.pointers();
    const written = uploads(f.calls);
    await assert.rejects(resumePublication(f.root, {}, f.transport), /quality hold/i);
    await assert.rejects(beginDailyPublication(f.root, { resumePublishing: true, env: {} }, f.transport), /quality hold/i);
    assert.deepEqual(await readFile(join(f.root, "publication-state.json")), state);
    assert.deepEqual(await releaseBytes(f.root), artifacts);
    assert.deepEqual(f.pointers(), pointers);
    if (channel === "v2") assert.deepEqual(uploads(f.calls), written);
    assert.deepEqual(uploads(f.calls).filter(key => key.endsWith("latest.json")), written.filter(key => key.endsWith("latest.json")));
  } finally { await f.cleanup(); }
});

test("a quality hold introduced during artifact upload prevents both pointer activations", async () => {
  const f = await fixture();
  try {
    const staged = await stageRelease(f.root, catalog([...f.original.prompts, prompt("new")]), f.previous);
    const artifacts = await releaseBytes(f.root), pointers = f.pointers();
    let intendedState: Buffer | undefined;
    f.beforeUpload(async key => {
      if (key.endsWith("/v2/base.json")) {
        intendedState = await readFile(join(f.root, "publication-state.json"));
        await f.hold();
      }
    });
    await assert.rejects(publishRelease(f.root, staged, f.previous.observed, { operation: "daily" }, f.transport), /quality hold/i);
    assert.ok(intendedState);
    assert.deepEqual(await readFile(join(f.root, "publication-state.json")), intendedState);
    assert.deepEqual(await releaseBytes(f.root), artifacts);
    assert.deepEqual(f.pointers(), pointers);
    assert.equal(uploads(f.calls).some(key => key.endsWith("latest.json")), false);
  } finally { await f.cleanup(); }
});

for (const mode of ["legacy", "v2"] as const) test(`explicit ${mode} rollback cannot bypass a quality hold`, async t => {
  const f = await fixture();
  try {
    t.mock.method(console, "log", () => {});
    const clean = catalog([f.original.prompts[0]]);
    if (mode === "v2") {
      await publishRelease(f.root, await stageRelease(f.root, clean, f.previous), f.previous.observed, { operation: "daily" }, f.transport);
    } else {
      const active = manifest(clean);
      f.files.set(`${base}/v1/latest.json`, encode(active)); f.files.set(active.catalog, serializeCatalog(clean));
    }
    const recovery: RecoveryTransport = {
      async currentManifest() { return manifestSchema.parse(JSON.parse(f.files.get(`${base}/v1/latest.json`)!.toString())); },
      async remoteCatalog(value) { return verifyCatalog(value, f.files.get(value.catalog)!); },
      async verifyMedia() { f.calls.push("media"); },
      upload: f.transport.upload,
    };
    await f.hold(); f.calls.length = 0;
    const pointers = f.pointers(), holdBytes = await readFile(join(f.root, "quality-holds.json"));
    const targetBytes = await readFile(join(f.root, "releases", f.original.version, "catalog.json"));
    await assert.rejects(recoverRelease(f.root, f.original.version, true, recovery, mode === "v2" ? f.transport : undefined, {}), /quality hold/i);
    assert.deepEqual(f.pointers(), pointers);
    assert.deepEqual(uploads(f.calls), []);
    assert.equal(f.calls.includes("media"), false);
    assert.deepEqual(await readFile(join(f.root, "quality-holds.json")), holdBytes);
    assert.deepEqual(await readFile(join(f.root, "releases", f.original.version, "catalog.json")), targetBytes);
    await assert.rejects(readFile(join(f.root, "publication-hold.json")), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

test("malformed quality-hold records fail closed before publication", async () => {
  const f = await fixture();
  try {
    const before = await releaseBytes(f.root), pointers = f.pointers();
    const valid = holdsFor(f.held);
    const invalid = [
      { ...valid, unrecognized: true },
      { ...valid, holds: { held: { ...valid.holds.held, sourceIdentitySHA256: "not-a-digest" } } },
      { ...valid, holds: { held: { ...valid.holds.held, reviewedAt: "not-a-date" } } },
    ];
    for (const record of invalid) {
      await atomic(join(f.root, "quality-holds.json"), record);
      await assert.rejects(readQualityHolds(f.root));
      await assert.rejects(stageRelease(f.root, catalog([f.original.prompts[0]]), f.previous));
    }
    await writeFile(join(f.root, "quality-holds.json"), "{broken");
    await assert.rejects(stageRelease(f.root, catalog([f.original.prompts[0]]), f.previous));
    assert.deepEqual(await releaseBytes(f.root), before);
    assert.deepEqual(f.pointers(), pointers);
    assert.deepEqual(uploads(f.calls), []);
    assert.equal((await loadPublicationState(f.root)).pending, undefined);
  } finally { await f.cleanup(); }
});
