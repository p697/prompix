import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localizationLanguages, type Catalog, type Prompt } from "../packages/schema/catalog.ts";
import { atomic, base, digest, editionVersion, json, manifestSchema, serializeCatalog } from "./publication.ts";
import { splitLanguagePacks } from "./language-packs.ts";
import { translationFingerprint } from "./translation.ts";
import { recoverRelease, type RecoveryTransport } from "./recovery.ts";
import { recoveryPublicationHooks } from "./recovery-publication.ts";
import { beginDailyPublication } from "./daily-publication.ts";
import { loadPublicationState, publicationIdentity, publishRelease, readLocalRelease, readPublishedState, stageRelease, type ReleaseTransport } from "./release-publication.ts";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
function prompt(id: string): Prompt {
  const text = { title: id, summary: "Original recovery fixture.", prompt: "Keep {{name}} and 中文 intact.", example: "Example", previewLabel: "Preview" };
  const item: Prompt = { id, kind: "text", ...text, tags: ["test"], model: "Any", toolURL: null, artwork: "test",
    source: { name: "Prompix", url: null, license: "Original", method: "Written for tests" }, media: null };
  item.localization = { sourceLanguage: "en", sourceFingerprint: translationFingerprint(item),
    translations: Object.fromEntries(localizationLanguages.map(locale => [locale, { ...text, title: `${id} ${locale}` }])) };
  return item;
}
function catalog(ids: string[], removedIDs: string[] = []): Catalog {
  const prompts = ids.map(prompt);
  return { schemaVersion: 1, version: editionVersion(prompts, removedIDs), publishedAt: "2026-10-01T00:00:00.000Z", prompts, removedIDs };
}
function legacyManifest(value: Catalog) {
  return manifestSchema.parse({ schemaVersion: 1, version: value.version, publishedAt: value.publishedAt, count: value.prompts.length,
    sha256: digest(serializeCatalog(value)), catalog: `${base}/releases/${value.version}/catalog.json` });
}
async function fixture(options: { initialized?: boolean; remoteV2?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "prompix-v2-recovery-"));
  const target = catalog(["keep", "also-keep", "removed-v1", "removed-v2", "removed-local", "removed-pending"], ["removed-target"]);
  const v1 = catalog(["keep", "also-keep", "removed-local"], ["removed-v1"]);
  const v2 = catalog(["keep", "also-keep", "removed-local"], ["removed-v1", "removed-v2"]);
  const files = new Map<string, Buffer>(), calls: string[] = [], verified: Catalog[] = [], pointerWrites: { key: string; version: string }[] = [];
  async function store(value: Catalog, local = false) {
    const manifest = legacyManifest(value), bundle = splitLanguagePacks(value);
    const entries: [string, Buffer][] = [[manifest.catalog, serializeCatalog(value)], [bundle.manifest.base.url, bundle.baseBytes],
      ...localizationLanguages.flatMap(locale => bundle.localeBytes[locale] ? [[bundle.manifest.locales[locale]!.url, Buffer.from(bundle.localeBytes[locale]!)] as [string, Buffer]] : [])];
    for (const [url, bytes] of entries) {
      files.set(url, bytes);
      if (local) await atomic(join(root, new URL(url).pathname.slice(1)), JSON.parse(bytes.toString()));
    }
    if (local) {
      // Keep artifacts exactly as described; atomic's pretty JSON is deliberately not reused.
      for (const [url, bytes] of entries) await writeFile(join(root, new URL(url).pathname.slice(1)), bytes);
      await atomic(join(root, "releases", value.version, "manifest.json"), manifest);
      await atomic(join(root, "releases", value.version, "v2", "manifest.json"), bundle.manifest);
    }
    return { manifest, bundle };
  }
  await store(target, true);
  const legacy = await store(v1), current = await store(v2);
  files.set(`${base}/v1/latest.json`, encode(legacy.manifest));
  if (options.remoteV2 !== false) files.set(`${base}/v2/latest.json`, current.bundle.manifestBytes);
  if (options.initialized !== false) await atomic(join(root, "publication-state.json"), { schemaVersion: 1, v2Initialized: true, v1Frozen: false });
  await atomic(join(root, "moderation.json"), { removedIDs: ["removed-local"], history: [{ reason: "Original moderation record" }] });
  let beforeRead: ((url: string) => void) | undefined;
  let beforeUpload: ((key: string) => Promise<void> | void) | undefined;
  let afterUpload: ((key: string) => Promise<void> | void) | undefined;
  let media: (() => Promise<void> | void) | undefined;
  const releaseTransport: ReleaseTransport = {
    async read(url) {
      calls.push(`read:${url.slice(base.length + 1)}`); beforeRead?.(url);
      const bytes = files.get(url); return bytes ? { status: 200, bytes: Buffer.from(bytes) } : { status: 404 };
    },
    async upload(key, path) {
      calls.push(`upload:${key}`); await beforeUpload?.(key);
      const bytes = await readFile(path); files.set(`${base}/${key}`, bytes);
      if (key.endsWith("latest.json")) pointerWrites.push({ key, version: JSON.parse(bytes.toString()).version });
      await afterUpload?.(key);
    },
  };
  const legacyTransport: RecoveryTransport = {
    async currentManifest() { throw new Error("Unexpected legacy-only manifest read"); },
    async remoteCatalog() { throw new Error("Unexpected legacy-only catalog read"); },
    async upload() { throw new Error("Unexpected legacy-only upload"); },
    async verifyMedia(value) { calls.push("media"); verified.push(value); await media?.(); },
  };
  return { root, target, v1, v2, files, calls, verified, pointerWrites, store, releaseTransport, legacyTransport,
    recover: (publishing = true, env: NodeJS.ProcessEnv = {}) => recoverRelease(root, target.version, publishing, legacyTransport, releaseTransport, env),
    beforeRead(callback?: typeof beforeRead) { beforeRead = callback; },
    beforeUpload(callback?: typeof beforeUpload) { beforeUpload = callback; },
    afterUpload(callback?: typeof afterUpload) { afterUpload = callback; },
    media(callback?: typeof media) { media = callback; },
    cleanup: () => rm(root, { recursive: true, force: true }) };
}
const uploads = (calls: string[]) => calls.filter(call => call.startsWith("upload:"));

test("initialized recovery prefers verified local v2, keeps nine languages and unions all live tombstones without a flag", async () => {
  const f = await fixture();
  try {
    // A valid older v1 snapshot with fewer translations must not replace the complete local v2 target.
    const legacyTarget = structuredClone(f.target);
    legacyTarget.prompts.forEach(item => { item.localization!.translations = { en: item.localization!.translations.en! }; });
    await atomic(join(f.root, "releases", f.target.version, "manifest.json"), legacyManifest(legacyTarget));
    await writeFile(join(f.root, "releases", f.target.version, "catalog.json"), serializeCatalog(legacyTarget));
    f.beforeUpload(async key => {
      if (!key.endsWith("latest.json")) return;
      const hold = await json<{ version: string } | null>(join(f.root, "publication-hold.json"), null);
      assert.ok(hold?.version.startsWith("rollback-"));
      const moderation = await json<{ removedIDs: string[] }>(join(f.root, "moderation.json"), { removedIDs: [] });
      assert.deepEqual(moderation.removedIDs, ["removed-local", "removed-target", "removed-v1", "removed-v2"]);
    });
    await f.recover();
    const active = await readPublishedState(f.root, {}, f.releaseTransport);
    assert.deepEqual(active.authoritative.prompts.map(item => item.id), ["keep", "also-keep", "removed-pending"]);
    assert.deepEqual(Object.keys(active.authoritative.prompts[0].localization!.translations).sort(), [...localizationLanguages].sort());
    assert.equal(f.verified.length, 2);
    assert.ok(f.calls.indexOf("media") < f.calls.findIndex(call => call.endsWith("latest.json") && call.startsWith("upload:")));
    assert.equal(active.state.pending, undefined);
    assert.deepEqual(f.pointerWrites.map(write => write.key), ["v2/latest.json", "v1/latest.json"]);
    assert.equal((await json<{ published: boolean }>(join(f.root, "rollback-status.json"), { published: false })).published, true);
  } finally { await f.cleanup(); }
});

test("dry-run stages a complete rollback without uploads, media probes, hold, state or moderation changes", async () => {
  const f = await fixture();
  try {
    const state = await readFile(join(f.root, "publication-state.json")), moderation = await readFile(join(f.root, "moderation.json"));
    const pointers = [f.files.get(`${base}/v1/latest.json`), f.files.get(`${base}/v2/latest.json`)];
    await f.recover(false);
    assert.deepEqual(uploads(f.calls), []); assert.deepEqual(f.verified, []);
    assert.deepEqual(await readFile(join(f.root, "publication-state.json")), state);
    assert.deepEqual(await readFile(join(f.root, "moderation.json")), moderation);
    assert.deepEqual([f.files.get(`${base}/v1/latest.json`), f.files.get(`${base}/v2/latest.json`)], pointers);
    assert.equal(await json(join(f.root, "publication-hold.json"), null), null);
    const report = await json<{ version: string }>(join(f.root, "rollback-status.json"), { version: "" });
    assert.equal((await readLocalRelease(f.root, report.version)).prompts.length, 3);
  } finally { await f.cleanup(); }
});

test("flagged bootstrap and discovered remote v2 both use complete recovery without local initialization", async () => {
  for (const remoteV2 of [false, true]) {
    const f = await fixture({ initialized: false, remoteV2 });
    try {
      await f.recover(true, remoteV2 ? {} : { PROMPIX_LANGUAGE_PACKS_ENABLED: "true" });
      assert.equal((await loadPublicationState(f.root)).v2Initialized, true);
      assert.equal(f.verified.length, 2);
    } finally { await f.cleanup(); }
  }
});

test("corrupt state, missing initialized pointer and corrupt local v2 never fall back to legacy", async () => {
  for (const failure of ["state", "remote", "local"]) {
    const f = await fixture();
    try {
      if (failure === "state") await writeFile(join(f.root, "publication-state.json"), "broken");
      if (failure === "remote") f.files.delete(`${base}/v2/latest.json`);
      if (failure === "local") await writeFile(join(f.root, "releases", f.target.version, "v2", "manifest.json"), "broken");
      await assert.rejects(f.recover());
      assert.deepEqual(uploads(f.calls), []); assert.deepEqual(f.verified, []);
      assert.equal(await json(join(f.root, "publication-hold.json"), null), null);
      if (failure === "state") assert.deepEqual(f.calls, []);
    } finally { await f.cleanup(); }
  }
});

async function interruptedOrdinary(f: Awaited<ReturnType<typeof fixture>>) {
  const previous = await readPublishedState(f.root, {}, f.releaseTransport);
  const unwanted = catalog(["keep", "also-keep", "unwanted-new-item"], ["removed-v1", "removed-v2", "removed-pending"]);
  const staged = await stageRelease(f.root, unwanted, previous);
  f.beforeUpload(key => { if (key === "v1/latest.json") throw new Error("Synthetic legacy activation failure"); });
  await assert.rejects(publishRelease(f.root, staged, previous.observed, { operation: "daily" }, f.releaseTransport), /legacy activation failure/);
  f.beforeUpload(); f.calls.length = 0; f.pointerWrites.length = 0;
  return unwanted;
}

test("explicit rollback supersedes mixed pending ordinary publication without completing its unwanted target", async () => {
  const f = await fixture();
  try {
    const unwanted = await interruptedOrdinary(f);
    await f.recover();
    const active = await readPublishedState(f.root, {}, f.releaseTransport);
    assert.deepEqual(active.authoritative.prompts.map(item => item.id), ["keep", "also-keep"]);
    assert.deepEqual(active.authoritative.removedIDs, ["removed-local", "removed-pending", "removed-target", "removed-v1", "removed-v2"]);
    assert.ok(f.pointerWrites.every(write => write.version !== unwanted.version));
    assert.equal(active.state.pending, undefined);
  } finally { await f.cleanup(); }
});

test("pending pointer conflict or altered pending manifest blocks rollback before new staging or uploads", async () => {
  for (const failure of ["pointer", "manifest"]) {
    const f = await fixture();
    try {
      const unwanted = await interruptedOrdinary(f);
      const pendingBytes = await readFile(join(f.root, "publication-state.json"));
      if (failure === "pointer") {
        const unrelated = catalog(["unrelated"]), stored = await f.store(unrelated);
        f.files.set(`${base}/v1/latest.json`, encode(stored.manifest));
      } else {
        const path = join(f.root, "releases", unwanted.version, "v2", "manifest.json");
        const manifest = JSON.parse(await readFile(path, "utf8")); manifest.publishedAt = "2026-10-02T00:00:00.000Z";
        await atomic(path, manifest);
      }
      await assert.rejects(f.recover(), /Publication conflict|Pending local manifest mismatch/);
      assert.deepEqual(uploads(f.calls), []); assert.deepEqual(f.verified, []);
      assert.deepEqual(await readFile(join(f.root, "publication-state.json")), pendingBytes);
      assert.equal(await json(join(f.root, "publication-hold.json"), null), null);
    } finally { await f.cleanup(); }
  }
});

test("media and artifact failures never activate pointers or erase an existing hold", async () => {
  for (const failure of ["media", "artifact"]) {
    const f = await fixture();
    try {
      const hold = { reason: "older rollback", version: "old-version", createdAt: "2026-10-01T00:00:00Z" };
      await atomic(join(f.root, "publication-hold.json"), hold);
      if (failure === "media") f.media(() => { throw new Error("Synthetic missing media"); });
      else f.beforeUpload(key => { if (key.includes("/v2/base.json")) throw new Error("Synthetic artifact failure"); });
      await assert.rejects(f.recover(), /Synthetic/);
      assert.deepEqual(f.pointerWrites, []);
      assert.deepEqual(await json(join(f.root, "publication-hold.json"), null), hold);
      assert.deepEqual((await json<{ removedIDs: string[] }>(join(f.root, "moderation.json"), { removedIDs: [] })).removedIDs, ["removed-local"]);
    } finally { await f.cleanup(); }
  }
});

test("ambiguous activation retains hold and removals, then retries the exact intent and immutable bytes", async () => {
  const f = await fixture();
  try {
    let ambiguous = false;
    f.beforeRead(url => { if (ambiguous && url.endsWith("latest.json")) throw new Error("Synthetic readback unavailable"); });
    f.afterUpload(key => { if (key === "v2/latest.json") { ambiguous = true; throw new Error("Synthetic ambiguous response"); } });
    await assert.rejects(f.recover(), /readback unavailable/);
    const pending = (await loadPublicationState(f.root)).pending!;
    assert.equal(pending.operation, "rollback");
    const hold = await readFile(join(f.root, "publication-hold.json"));
    const path = join(f.root, "releases", pending.targets.v2.version, "v2", "base.json"), bytes = await readFile(path);
    assert.deepEqual((await json<{ removedIDs: string[] }>(join(f.root, "moderation.json"), { removedIDs: [] })).removedIDs,
      ["removed-local", "removed-target", "removed-v1", "removed-v2"]);
    ambiguous = false; f.afterUpload(); f.pointerWrites.length = 0; f.calls.length = 0;
    f.beforeUpload(async key => {
      if (key.endsWith("latest.json")) assert.equal(publicationIdentity((await loadPublicationState(f.root)).pending), publicationIdentity(pending));
    });
    await f.recover();
    assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual(await readFile(join(f.root, "publication-hold.json")), hold);
    assert.deepEqual(f.pointerWrites, [{ key: "v1/latest.json", version: pending.targets.v1.version }]);
    assert.equal((await loadPublicationState(f.root)).pending, undefined);
    assert.equal(uploads(f.calls).some(call => call.includes("releases/")), false);
  } finally { await f.cleanup(); }
});

test("new removals during rollback block stale activation and a repeated command stages a corrected intent", async () => {
  const f = await fixture();
  try {
    f.media(async () => { await atomic(join(f.root, "moderation.json"), { removedIDs: ["removed-local", "also-keep"] }); });
    await assert.rejects(f.recover(), /New removals/);
    const first = (await loadPublicationState(f.root)).pending!;
    assert.deepEqual(f.pointerWrites, []);
    assert.equal(await json(join(f.root, "publication-hold.json"), null), null);
    f.media();
    await f.recover();
    const active = await readPublishedState(f.root, {}, f.releaseTransport);
    assert.notEqual(active.v2!.manifest.version, first.targets.v2.version);
    assert.deepEqual(active.authoritative.prompts.map(item => item.id), ["keep", "removed-pending"]);
    assert.ok(active.authoritative.removedIDs?.includes("also-keep"));
    assert.ok(await json(join(f.root, "publication-hold.json"), null));
  } finally { await f.cleanup(); }
});

test("retry preserves a newer unrelated hold byte-for-byte instead of replacing its authorization identity", async () => {
  const f = await fixture();
  try {
    f.beforeUpload(key => { if (key === "v1/latest.json") throw new Error("Synthetic legacy activation failure"); });
    await assert.rejects(f.recover(), /legacy activation failure/);
    const holdPath = join(f.root, "publication-hold.json");
    const operatorHold = Buffer.from('{ "reason": "new operator review", "version": "another-version", "createdAt": "2026-10-12T00:00:00Z" }\n');
    await writeFile(holdPath, operatorHold);
    f.beforeUpload();
    await f.recover();
    assert.deepEqual(await readFile(holdPath), operatorHold);
    assert.equal((await loadPublicationState(f.root)).pending, undefined);
  } finally { await f.cleanup(); }
});

test("shared rollback hook rechecks media on delayed resumption before any hold or activation", async () => {
  const f = await fixture();
  try {
    f.beforeUpload(key => { if (key.includes("/v2/base.json")) throw new Error("Synthetic artifact failure"); });
    await assert.rejects(f.recover(), /artifact failure/);
    const intent = (await loadPublicationState(f.root)).pending!;
    let verified = false;
    const hooks = recoveryPublicationHooks(f.root, async value => {
      verified = true;
      assert.equal(value.version, intent.targets.v2.version);
      throw new Error("Media disappeared before recovery");
    });
    await assert.rejects(hooks.beforeActivation!(intent), /Media disappeared/);
    assert.equal(verified, true);
    assert.equal(await json(join(f.root, "publication-hold.json"), null), null);
    assert.deepEqual(f.pointerWrites, []);
  } finally { await f.cleanup(); }
});

test("automatic pending rollback recovery refuses media that disappeared since its original check", async t => {
  const f = await fixture();
  try {
    const imageURL = `${base}/media/${"a".repeat(64)}.jpg`;
    f.target.prompts[0].media = { image: null, video: null, demoURL: null, imageURL };
    f.target.version = editionVersion(f.target.prompts, f.target.removedIDs ?? []);
    await f.store(f.target, true);
    f.beforeUpload(key => { if (key.includes("/v2/base.json")) throw new Error("Synthetic artifact failure"); });
    await assert.rejects(f.recover(), /artifact failure/);
    f.beforeUpload();
    const mediaReads: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
      mediaReads.push(url); assert.equal(url, imageURL); assert.equal(options.method, "HEAD");
      return new Response(null, { status: 404 });
    });
    await assert.rejects(beginDailyPublication(f.root, { resumePublishing: false, env: {} }, f.releaseTransport), /Rollback media is unavailable/);
    assert.deepEqual(mediaReads, [imageURL]);
    assert.deepEqual(f.pointerWrites, []);
    assert.ok((await loadPublicationState(f.root)).pending);
    assert.equal(await json(join(f.root, "publication-hold.json"), null), null);
  } finally { await f.cleanup(); }
});

test("v2 rollback retains exact original and translated text through staging, publication and retry", async () => {
  const f = await fixture();
  try {
    const item = f.target.prompts[0];
    item.title = "  Keep this title  "; item.prompt = "\n  Keep {{name}} and 中文 with two  spaces.\r\n "; item.example = "  Original example.\t";
    item.localization!.sourceFingerprint = translationFingerprint(item);
    for (const locale of localizationLanguages) {
      const content = item.localization!.translations[locale]!;
      content.title = `  ${locale} title  `; content.prompt = `\r\n  ${locale} translation 中文  \n`;
      content.example = "  Example with spaces.  "; content.cover = { text: "  中文  ", eyebrow: "  Cover  " };
    }
    f.target.version = editionVersion(f.target.prompts, f.target.removedIDs ?? []);
    await f.store(f.target, true);
    const expected = structuredClone(item);
    await f.recover();
    const first = await readPublishedState(f.root, {}, f.releaseTransport);
    assert.deepEqual(first.authoritative.prompts.find(prompt => prompt.id === item.id), expected);
    const path = join(f.root, "releases", first.authoritative.version, "v2", "base.json"), bytes = await readFile(path);
    await f.recover();
    const retried = await readPublishedState(f.root, {}, f.releaseTransport);
    assert.equal(retried.authoritative.version, first.authoritative.version);
    assert.deepEqual(retried.authoritative.prompts.find(prompt => prompt.id === item.id), expected);
    assert.deepEqual(await readFile(path), bytes);
  } finally { await f.cleanup(); }
});
