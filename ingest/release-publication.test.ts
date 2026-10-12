import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogSchema, promptSchema, localizationLanguages, type Catalog, type Prompt } from "../packages/schema/catalog.ts";
import { atomic, base, digest, editionVersion, manifestSchema, rollbackCatalog, serializeCatalog, type Manifest } from "./publication.ts";
import { splitLanguagePacks } from "./language-packs.ts";
import { translationFingerprint } from "./translation.ts";
import { loadPublicationState, PendingRemovalsError, preserveCatalogText, preservedRollbackCatalog, publicationIdentity, publishRelease, readLocalRelease, readPublishedState, resumePublication, stageRelease, type ReleaseTransport } from "./release-publication.ts";
import { clawHubCandidateIdentity, clawHubSources, parseClawHubSkill } from "./clawhub.ts";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
function prompt(id: string): Prompt {
  const item: Prompt = { id, kind: "text", title: id, summary: "An original publication fixture", prompt: "Write a short story about a teacup.",
    example: "A teacup grew wings.", previewLabel: "Preview", tags: ["test"], model: "Any", toolURL: null, artwork: "test",
    source: { name: "Prompix", url: null, license: "Original", method: "Written for tests" }, media: null };
  item.localization = { sourceLanguage: "en", sourceFingerprint: translationFingerprint(item), translations: Object.fromEntries(localizationLanguages.map(locale => [locale, {
    title: `${id} ${locale}`, summary: "Translated summary", prompt: `Translated teacup story ${locale}`, example: "Translated example", previewLabel: "Preview",
  }])) };
  return item;
}
function catalog(prompts: Prompt[], removedIDs: string[] = []): Catalog {
  return { schemaVersion: 1, version: editionVersion(prompts, removedIDs), publishedAt: "2026-10-01T00:00:00.000Z", prompts, removedIDs };
}
function legacyManifest(value: Catalog): Manifest {
  return manifestSchema.parse({ schemaVersion: 1, version: value.version, publishedAt: value.publishedAt, count: value.prompts.length,
    sha256: digest(serializeCatalog(value)), catalog: `${base}/releases/${value.version}/catalog.json` });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "prompix-v2-publication-"));
  const original = catalog([prompt("keep"), prompt("remove-later")]), manifest = legacyManifest(original);
  const files = new Map<string, Buffer>([[`${base}/v1/latest.json`, encode(manifest)], [manifest.catalog, serializeCatalog(original)]]);
  const calls: string[] = [];
  let beforeRead: ((url: string) => void) | undefined, beforeUpload: ((key: string) => void) | undefined, afterUpload: ((key: string) => void) | undefined;
  const transport: ReleaseTransport = {
    async read(url) {
      calls.push(`read:${url.slice(base.length + 1)}`); beforeRead?.(url);
      const bytes = files.get(url);
      return bytes ? { status: 200, bytes: Buffer.from(bytes) } : { status: 404 };
    },
    async upload(key, path) {
      calls.push(`upload:${key}`); beforeUpload?.(key);
      files.set(`${base}/${key}`, await readFile(path)); afterUpload?.(key);
    },
  };
  const previous = await readPublishedState(root, { allowBootstrap: true }, transport);
  const next = catalog([...original.prompts, prompt("new-prompt")]);
  return { root, original, next, previous, files, calls, transport,
    beforeRead(callback?: typeof beforeRead) { beforeRead = callback; },
    beforeUpload(callback?: typeof beforeUpload) { beforeUpload = callback; },
    afterUpload(callback?: typeof afterUpload) { afterUpload = callback; },
    cleanup: () => rm(root, { recursive: true, force: true }) };
}
const uploadCalls = (calls: string[]) => calls.filter(value => value.startsWith("upload:"));

function registryPrompt(): Prompt {
  const source = clawHubSources[0];
  const bytes = Buffer.from("---\nname: fixture-skill\ndescription: An original publication test skill.\n---\nAsk for a fictional town and describe its imaginary library.");
  const candidate = parseClawHubSkill(source, {
    skill: { slug: source.slug, displayName: "Fixture skill" }, latestVersion: { version: "1.0.0", license: null },
    owner: { handle: source.owner, userId: "fixture-author", displayName: "Fixture author" }, moderation: null,
  }, {
    skill: { slug: source.slug }, version: { version: "1.0.0", license: null,
      files: [{ path: "SKILL.md", size: bytes.length, sha256: digest(bytes) }],
      security: { status: "clean", hasWarnings: false, hasScanResult: true, scanners: {} } },
  }, bytes);
  const item = promptSchema.parse(candidate);
  item.localization = prompt(item.id).localization;
  item.localization!.sourceFingerprint = translationFingerprint(item);
  return item;
}
async function registryState(root: string, item: Prompt, status: "ready" | "withheld" = "ready", stale = false) {
  await atomic(join(root, "clawhub", "state.json"), { schemaVersion: 1, records: {
    [item.id]: { status, identity: clawHubCandidateIdentity(item), checkedAt: new Date(Date.now() - (stale ? 25 * 3_600_000 : 0)).toISOString() },
  } });
}

test("a ready registry skill preserves source identity and all locales through schema and dual publication", async () => {
  const f = await fixture();
  try {
    const item = registryPrompt(), next = catalog([...f.original.prompts, item]);
    const parsed = catalogSchema.parse(next).prompts.at(-1)!;
    assert.equal(clawHubCandidateIdentity(parsed), clawHubCandidateIdentity(item));
    await registryState(f.root, item);
    const staged = await stageRelease(f.root, next, f.previous);
    assert.equal(Object.keys(staged.targets.v2.locales).length, 9);
    assert.deepEqual((await readLocalRelease(f.root, next.version)).prompts.at(-1), item);
    const published = await publishRelease(f.root, staged, f.previous.observed, { operation: "daily" }, f.transport);
    assert.deepEqual(published.authoritative.prompts.at(-1), item);
    assert.deepEqual(published.v1.catalog.prompts.at(-1), item);
    assert.equal(clawHubCandidateIdentity(published.authoritative.prompts.at(-1)!), clawHubCandidateIdentity(item));
    assert.deepEqual(published.authoritative.removedIDs, []);
  } finally { await f.cleanup(); }
});

for (const unavailable of ["withheld", "stale"] as const) test(`a ${unavailable} registry skill cannot stage artifacts or activate pointers`, async () => {
  const f = await fixture();
  try {
    const item = registryPrompt(), next = catalog([...f.original.prompts, item]);
    await registryState(f.root, item, unavailable === "withheld" ? "withheld" : "ready", unavailable === "stale");
    const before = new Map(f.files);
    await assert.rejects(stageRelease(f.root, next, f.previous), /ClawHub source is unavailable/);
    assert.deepEqual(f.files, before);
    assert.deepEqual(uploadCalls(f.calls), []);
    assert.equal((await loadPublicationState(f.root)).pending, undefined);
    await assert.rejects(readFile(join(f.root, "releases", next.version, "catalog.json")), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

for (const operation of ["daily", "rollback"] as const) for (const unavailable of ["withheld", "stale"] as const)
  test(`pending ${operation} refuses a now-${unavailable} registry skill before any pointer activation`, async () => {
    const f = await fixture();
    try {
      const item = registryPrompt(), next = catalog([...f.original.prompts, item]);
      await registryState(f.root, item);
      const staged = await stageRelease(f.root, next, f.previous);
      f.beforeUpload(key => { if (key.endsWith("/v2/base.json")) throw new Error("Synthetic interrupted artifact upload"); });
      await assert.rejects(publishRelease(f.root, staged, f.previous.observed,
        { operation, beforeActivation: async () => {} }, f.transport), /interrupted artifact upload/);
      const pending = (await loadPublicationState(f.root)).pending;
      assert.equal(pending?.operation, operation);
      const pointers = [f.files.get(`${base}/v1/latest.json`), f.files.get(`${base}/v2/latest.json`)];
      await registryState(f.root, item, unavailable === "withheld" ? "withheld" : "ready", unavailable === "stale");
      f.beforeUpload(); f.calls.length = 0;
      let activationHookCalls = 0;
      await assert.rejects(resumePublication(f.root, { beforeActivation: async () => { activationHookCalls++; } }, f.transport), /ClawHub source is unavailable/);
      assert.equal(activationHookCalls, 0);
      assert.deepEqual(uploadCalls(f.calls), []);
      assert.deepEqual([f.files.get(`${base}/v1/latest.json`), f.files.get(`${base}/v2/latest.json`)], pointers);
      assert.deepEqual((await loadPublicationState(f.root)).pending, pending, "The immutable pending intent remains available for explicit recovery");
    } finally { await f.cleanup(); }
  });

test("registry availability is rechecked after activation hooks before either latest pointer changes", async () => {
  const f = await fixture();
  try {
    const item = registryPrompt(), next = catalog([...f.original.prompts, item]);
    await registryState(f.root, item);
    const staged = await stageRelease(f.root, next, f.previous);
    const previousPointer = Buffer.from(f.files.get(`${base}/v1/latest.json`)!);
    await assert.rejects(publishRelease(f.root, staged, f.previous.observed, { operation: "daily",
      beforeActivation: () => registryState(f.root, item, "withheld"),
    }, f.transport), /ClawHub source is unavailable/);
    assert.deepEqual(f.files.get(`${base}/v1/latest.json`), previousPointer);
    assert.equal(f.files.has(`${base}/v2/latest.json`), false);
    assert.equal(uploadCalls(f.calls).some(key => key.endsWith("latest.json")), false);
  } finally { await f.cleanup(); }
});

test("frozen v1 drops unavailable historical registry skills without creating removal tombstones", async () => {
  const f = await fixture();
  try {
    const item = registryPrompt(), original = catalog([...f.original.prompts, item], ["historical-removal"]);
    await registryState(f.root, item);
    const first = await stageRelease(f.root, original, f.previous);
    await publishRelease(f.root, first, f.previous.observed, { operation: "daily" }, f.transport);
    await atomic(join(f.root, "publication-state.json"), { schemaVersion: 1, v2Initialized: true, v1Frozen: true });
    const previous = await readPublishedState(f.root, {}, f.transport);
    assert.equal(previous.state.v1Frozen, true);
    await registryState(f.root, item, "withheld");
    const next = catalog([...f.original.prompts, prompt("v2-only-addition")], ["historical-removal"]);
    const staged = await stageRelease(f.root, next, previous);
    const published = await publishRelease(f.root, staged, previous.observed, { operation: "daily" }, f.transport);
    assert.equal(published.state.v1Frozen, true);
    assert.deepEqual(published.v1.catalog.prompts, f.original.prompts);
    assert.deepEqual(published.v1.catalog.removedIDs, ["historical-removal"]);
    assert.deepEqual(published.authoritative, next);
    assert.equal(published.authoritative.removedIDs!.includes(item.id), false);
  } finally { await f.cleanup(); }
});

test("bootstrap stages without activating, uploads complete artifacts first and initializes both channels", async () => {
  const f = await fixture();
  try {
    const staged = await stageRelease(f.root, f.next, f.previous);
    const mismatched = structuredClone(staged.targets.v2); mismatched.publishedAt = "2026-10-03T00:00:00.000Z";
    await assert.rejects(readLocalRelease(f.root, f.next.version, mismatched), /Pending local manifest mismatch/);
    assert.deepEqual(await loadPublicationState(f.root), { schemaVersion: 1, v2Initialized: false, v1Frozen: false });
    assert.deepEqual(uploadCalls(f.calls), []);
    const published = await publishRelease(f.root, staged, f.previous.observed, { operation: "daily" }, f.transport);
    assert.deepEqual(published.authoritative, f.next);
    assert.equal(published.state.v2Initialized, true);
    assert.equal(published.state.pending, undefined);
    const writes = uploadCalls(f.calls);
    assert.deepEqual(writes.slice(-2), ["upload:v2/latest.json", "upload:v1/latest.json"]);
    assert.equal(writes.filter(key => key.includes("/locales/")).length, 9);
    assert.deepEqual(await readLocalRelease(f.root, f.next.version), f.next);
    assert.equal(await resumePublication(f.root, {}, f.transport), null);
  } finally { await f.cleanup(); }
});

test("same-version bootstrap reuses v1 and immutable v2 bytes and timestamp across interrupted staging", async () => {
  const f = await fixture();
  try {
    const first = await stageRelease(f.root, f.original, f.previous);
    const path = join(f.root, "releases", f.original.version, "v2", "base.json");
    const firstBytes = await readFile(path);
    await rm(path);
    const again = await stageRelease(f.root, { ...f.original, publishedAt: "2026-10-05T00:00:00.000Z" }, f.previous);
    assert.deepEqual(again, first);
    assert.deepEqual(await readFile(path), firstBytes);
    await publishRelease(f.root, again, f.previous.observed, { operation: "daily" }, f.transport);
    assert.equal(uploadCalls(f.calls).includes("upload:v1/latest.json"), false);
    const changed = structuredClone(f.original); changed.prompts[0].model = "Changed model";
    await assert.rejects(stageRelease(f.root, changed, f.previous), /different content|different bytes/);
  } finally { await f.cleanup(); }
});

test("source and translated whitespace survive dual publication, readback, retry and rollback", async () => {
  const f = await fixture();
  try {
    const raw = prompt("raw-text");
    for (const field of ["title", "summary", "prompt", "example", "previewLabel"] as const) raw[field] = ` \n${raw[field]}\t `;
    raw.cover = { text: "  Café 🌙  ", eyebrow: "\n原文\t", tone: "sage" };
    raw.localization!.sourceFingerprint = translationFingerprint(raw);
    for (const content of Object.values(raw.localization!.translations)) {
      for (const field of ["title", "summary", "prompt", "example", "previewLabel"] as const) content![field] = ` \n${content![field]}\t `;
      content!.cover = { text: "  月  ", eyebrow: "\nTranslated\t" };
    }
    const next = preserveCatalogText(catalog([...f.original.prompts, raw]));
    next.version = editionVersion(next.prompts, next.removedIDs!);
    const staged = await stageRelease(f.root, next, f.previous);
    const local = await readLocalRelease(f.root, next.version);
    assert.deepEqual(local, next);
    assert.deepEqual(local.prompts.at(-1), raw);
    const published = await publishRelease(f.root, staged, f.previous.observed, { operation: "daily" }, f.transport);
    assert.deepEqual(published.authoritative, next);
    assert.deepEqual(published.v1.catalog, next);
    assert.deepEqual(JSON.parse(f.files.get(staged.targets.v1.catalog)!.toString()), next);
    assert.equal(translationFingerprint(published.v1.catalog.prompts.at(-1)!), raw.localization!.sourceFingerprint);
    assert.equal(editionVersion(published.authoritative.prompts, next.removedIDs!), next.version);
    assert.doesNotThrow(() => splitLanguagePacks(published.authoritative));
    assert.deepEqual(await stageRelease(f.root, { ...next, publishedAt: "2026-10-09T00:00:00.000Z" }, f.previous), staged);
    const rollback = preservedRollbackCatalog(published.authoritative, ["remove-later"]);
    assert.equal(rollback.version, rollbackCatalog(published.authoritative, ["remove-later"]).version);
    assert.deepEqual(rollback.prompts.at(-1), raw);
    assert.doesNotThrow(() => splitLanguagePacks(rollback));
  } finally { await f.cleanup(); }
});

test("preserved validation retains legacy schema key order without accepting stripped fields", () => {
  const input = catalog([prompt("stable-version")]);
  const parsed = catalogSchema.parse(input), preserved = preserveCatalogText(input);
  assert.equal(JSON.stringify(preserved), JSON.stringify(parsed));
  assert.equal(editionVersion(preserved.prompts, []), editionVersion(parsed.prompts, []));
  const unsupported = structuredClone(input);
  Object.assign(unsupported.prompts[0].localization!.translations.ja!, { hidden: "unvalidated prose" });
  assert.throws(() => preserveCatalogText(unsupported), /Unsupported artifact fields/);
  const badFingerprint = structuredClone(input); badFingerprint.prompts[0].title += " ";
  assert.throws(() => preserveCatalogText(badFingerprint), /fingerprint mismatch/);
});

for (const suffix of ["/v2/base.json", "/v2/locales/ja.json", "/catalog.json"]) test(`artifact failure at ${suffix} preserves pointers and resumes the same intent`, async () => {
  const f = await fixture();
  try {
    const staged = await stageRelease(f.root, f.next, f.previous);
    f.beforeUpload(key => { if (key.endsWith(suffix)) throw new Error("Synthetic upload failure"); });
    await assert.rejects(publishRelease(f.root, staged, f.previous.observed, { operation: "daily" }, f.transport), /Synthetic upload failure/);
    assert.ok((await loadPublicationState(f.root)).pending);
    assert.equal(f.files.has(`${base}/v2/latest.json`), false);
    assert.equal(uploadCalls(f.calls).some(key => key.endsWith("latest.json")), false);
    f.beforeUpload();
    const resumed = await resumePublication(f.root, {}, f.transport);
    assert.deepEqual(resumed?.authoritative, f.next);
    assert.equal((await loadPublicationState(f.root)).pending, undefined);
  } finally { await f.cleanup(); }
});

test("existing remote immutable bytes and readback failures cannot be replaced or activated", async () => {
  const f = await fixture();
  try {
    const staged = await stageRelease(f.root, f.next, f.previous);
    f.files.set(staged.targets.v2.base.url, Buffer.from("conflicting object"));
    await assert.rejects(publishRelease(f.root, staged, f.previous.observed, { operation: "daily" }, f.transport), /immutable artifact conflicts/);
    assert.deepEqual(uploadCalls(f.calls), []);
    f.files.delete(staged.targets.v2.base.url);
    f.afterUpload(key => {
      if (key.endsWith("/v2/base.json")) f.beforeRead(url => { if (url === staged.targets.v2.base.url) throw new Error("Readback unavailable"); });
    });
    await assert.rejects(resumePublication(f.root, {}, f.transport), /Readback unavailable/);
    assert.equal(uploadCalls(f.calls).some(key => key.endsWith("latest.json")), false);
    f.beforeRead(); f.afterUpload();
    await resumePublication(f.root, {}, f.transport);
    assert.equal(uploadCalls(f.calls).filter(key => key.endsWith("/v2/base.json")).length, 1);
  } finally { await f.cleanup(); }
});

test("v2 activation followed by v1 failure resumes only unfinished work without staging again", async () => {
  const f = await fixture();
  try {
    const staged = await stageRelease(f.root, f.next, f.previous);
    f.beforeUpload(key => { if (key === "v1/latest.json") throw new Error("Legacy activation failed"); });
    await assert.rejects(publishRelease(f.root, staged, f.previous.observed, { operation: "daily" }, f.transport), /Legacy activation failed/);
    const pending = (await loadPublicationState(f.root)).pending!;
    assert.equal(pending.targets.v2.version, f.next.version);
    const partial = await readPublishedState(f.root, {}, f.transport);
    assert.equal(partial.authoritative.version, f.next.version);
    assert.equal(partial.v1.catalog.version, f.original.version);
    assert.equal(partial.state.v1Frozen, false, "A retained ordinary intent supplies the known unfrozen policy");
    f.beforeUpload();
    await resumePublication(f.root, {}, f.transport);
    assert.equal(uploadCalls(f.calls).filter(key => key === "upload:v2/latest.json").length, 1);
    assert.equal(uploadCalls(f.calls).filter(key => key.includes("/locales/")).length, 9);
  } finally { await f.cleanup(); }
});

test("an ambiguous successful activation is reconciled, including an unavailable first readback", async () => {
  const f = await fixture();
  try {
    const staged = await stageRelease(f.root, f.next, f.previous);
    f.afterUpload(key => {
      if (key === "v2/latest.json") {
        f.beforeRead(url => { if (url.endsWith("/v2/latest.json")) throw new Error("Activation readback unavailable"); });
        throw new Error("Ambiguous activation result");
      }
    });
    await assert.rejects(publishRelease(f.root, staged, f.previous.observed, { operation: "daily" }, f.transport), /readback unavailable/);
    assert.ok((await loadPublicationState(f.root)).pending);
    f.beforeRead(); f.afterUpload(key => { if (key === "v1/latest.json") throw new Error("Ambiguous legacy result"); });
    const recovered = await resumePublication(f.root, {}, f.transport);
    assert.equal(recovered?.state.pending, undefined);
    assert.equal(uploadCalls(f.calls).filter(key => key === "upload:v2/latest.json").length, 1);
    assert.equal(uploadCalls(f.calls).filter(key => key === "upload:v1/latest.json").length, 1);
  } finally { await f.cleanup(); }
});

test("observed pointer changes before staging completion or activation fail without overwriting", async () => {
  const f = await fixture();
  try {
    const staged = await stageRelease(f.root, f.next, f.previous);
    const foreign = legacyManifest(catalog([prompt("foreign")]));
    f.files.set(`${base}/v1/latest.json`, encode(foreign));
    await assert.rejects(publishRelease(f.root, staged, f.previous.observed, { operation: "daily" }, f.transport), /changed during preparation/);
    assert.equal((await loadPublicationState(f.root)).pending, undefined);
    f.files.set(`${base}/v1/latest.json`, encode(f.previous.v1.manifest));
    await assert.rejects(publishRelease(f.root, staged, f.previous.observed, {
      operation: "daily", beforeActivation: async () => { f.files.set(`${base}/v1/latest.json`, encode(foreign)); },
    }, f.transport), /Publication conflict/);
    assert.equal(uploadCalls(f.calls).some(key => key.endsWith("latest.json")), false);
    await assert.rejects(resumePublication(f.root, {}, f.transport), /Publication conflict/);
  } finally { await f.cleanup(); }
});

test("bootstrap only accepts explicit 404 and full v2 reads fail closed on missing languages", async () => {
  const f = await fixture();
  try {
    await assert.rejects(readPublishedState(f.root, {}, f.transport), /refusing legacy fallback/);
    f.beforeRead(url => { if (url.endsWith("/v2/latest.json")) throw new Error("HTTP 503"); });
    await assert.rejects(readPublishedState(f.root, { allowBootstrap: true }, f.transport), /503/);
    f.beforeRead();
    const staged = await stageRelease(f.root, f.next, f.previous);
    await publishRelease(f.root, staged, f.previous.observed, { operation: "daily" }, f.transport);
    f.files.delete(staged.targets.v2.locales.ja!.url);
    await assert.rejects(readPublishedState(f.root, { allowBootstrap: true }, f.transport), /Missing remote/);
    f.files.delete(`${base}/v2/latest.json`);
    await assert.rejects(readPublishedState(f.root, { allowBootstrap: true }, f.transport), /refusing legacy fallback/);
  } finally { await f.cleanup(); }
});

test("new removals retain the pending intent and support explicit removal-corrected supersession", async () => {
  const f = await fixture();
  try {
    const staged = await stageRelease(f.root, f.next, f.previous);
    f.beforeUpload(() => { throw new Error("Offline"); });
    await assert.rejects(publishRelease(f.root, staged, f.previous.observed, { operation: "daily" }, f.transport));
    f.beforeUpload(); const before = uploadCalls(f.calls).length;
    await assert.rejects(resumePublication(f.root, { requiredRemovedIDs: ["remove-later"] }, f.transport), PendingRemovalsError);
    assert.equal(uploadCalls(f.calls).length, before);
    const state = await loadPublicationState(f.root), pendingTarget = await readLocalRelease(f.root, state.pending!.targets.v2.version);
    const corrected = rollbackCatalog(pendingTarget, ["remove-later"]), live = await readPublishedState(f.root, { allowBootstrap: true }, f.transport);
    const replacement = await stageRelease(f.root, corrected, live);
    let durableHold = false;
    const result = await publishRelease(f.root, replacement, live.observed, { operation: "rollback", supersedePending: true,
      requiredRemovedIDs: ["remove-later"], beforeActivation: async () => { durableHold = true; },
    }, f.transport);
    assert.equal(durableHold, true);
    assert.equal(result.authoritative.prompts.some(item => item.id === "remove-later"), false);
    assert.ok(result.authoritative.removedIDs?.includes("remove-later"));
  } finally { await f.cleanup(); }
});

test("rollback and held resumption require explicit idempotent hold callbacks", async () => {
  const f = await fixture();
  try {
    const staged = await stageRelease(f.root, f.next, f.previous);
    const holdToClear = publicationIdentity({ reason: "rollback", version: f.original.version });
    await assert.rejects(publishRelease(f.root, staged, f.previous.observed, { operation: "rollback", holdToClear }, f.transport), /durable hold callback/);
    let held = false, cleared = false;
    f.beforeUpload(key => { if (key.endsWith("latest.json")) assert.equal(held, true); });
    await assert.rejects(resumePublication(f.root, { beforeActivation: async () => { held = true; } }, f.transport), /hold cleanup callback/);
    await resumePublication(f.root, { beforeActivation: async () => { held = true; }, afterActivation: async intent => {
      assert.equal(intent.holdToClear, holdToClear); cleared = true;
    } }, f.transport);
    assert.equal(cleared, true);
  } finally { await f.cleanup(); }
});

test("capacity freezes v1 snapshots, keeps v2 authoritative and permits only later removals", async () => {
  const f = await fixture();
  try {
    const items = [...structuredClone(f.original.prompts), ...Array.from({ length: 28 }, (_, index) => prompt(`large-${index}`))];
    for (const item of items) for (const content of Object.values(item.localization!.translations)) content!.prompt = "A".repeat(40_000);
    const large = catalog(items), staged = await stageRelease(f.root, large, f.previous);
    assert.equal(staged.freezeV1, true);
    assert.deepEqual(staged.targets.v1, f.previous.v1.manifest);
    const published = await publishRelease(f.root, staged, f.previous.observed, { operation: "daily" }, f.transport);
    assert.equal(published.authoritative.prompts.length, 30);
    assert.equal(published.state.v1Frozen, true);
    assert.deepEqual(published.v1.catalog, f.original);
    await rm(join(f.root, "releases", large.version, "v2"), { recursive: true });
    const restored = await stageRelease(f.root, { ...large, publishedAt: "2026-10-05T00:00:00.000Z" }, published);
    assert.deepEqual(restored.targets.v2, staged.targets.v2, "Remote active v2 supplies the immutable timestamp when local staging is lost");
    await rm(join(f.root, "publication-state.json"));
    const recovered = await readPublishedState(f.root, {}, f.transport);
    assert.equal(recovered.state.v1Frozen, true, "Losing the journal cannot unfreeze a verified v2 publication");
    assert.deepEqual(await loadPublicationState(f.root), { schemaVersion: 1, v2Initialized: false, v1Frozen: false }, "A read-only recovery probe does not write state");
    const small = catalog([prompt("keep"), prompt("new-small")], ["remove-later"]);
    const removal = await stageRelease(f.root, small, recovered);
    const result = await publishRelease(f.root, removal, recovered.observed, { operation: "daily" }, f.transport);
    assert.equal(result.state.v1Frozen, true);
    assert.deepEqual(result.v1.catalog.prompts, [f.original.prompts[0]]);
    assert.deepEqual(result.v1.catalog.removedIDs, ["remove-later"]);
    assert.deepEqual(result.authoritative, small);
    const removeLast = catalog([prompt("new-small")], ["remove-later", "keep"]);
    await assert.rejects(stageRelease(f.root, removeLast, result));
  } finally { await f.cleanup(); }
});

test("lost publication history conservatively freezes matching channels without modifying state during reads", async () => {
  const f = await fixture();
  try {
    const staged = await stageRelease(f.root, f.next, f.previous);
    await publishRelease(f.root, staged, f.previous.observed, { operation: "daily" }, f.transport);
    const stateFile = join(f.root, "publication-state.json");
    await rm(stateFile);
    const recovered = await readPublishedState(f.root, {}, f.transport);
    assert.equal(recovered.v1.manifest.version, recovered.v2!.manifest.version);
    assert.equal(recovered.state.v1Frozen, true);
    await assert.rejects(readFile(stateFile), { code: "ENOENT" });
    const unknownState = encode({ schemaVersion: 1, v2Initialized: false, v1Frozen: false });
    await writeFile(stateFile, unknownState);
    assert.equal((await readPublishedState(f.root, {}, f.transport)).state.v1Frozen, true);
    assert.deepEqual(await readFile(stateFile), unknownState);
    const added = catalog([...f.next.prompts, prompt("after-lost-history")]);
    const next = await stageRelease(f.root, added, recovered);
    assert.equal(next.freezeV1, true);
    assert.deepEqual(next.targets.v1, recovered.v1.manifest);
    const result = await publishRelease(f.root, next, recovered.observed, { operation: "daily" }, f.transport);
    assert.equal((await loadPublicationState(f.root)).v1Frozen, true);
    assert.equal(result.v1.catalog.prompts.length, f.next.prompts.length);
    assert.equal(result.authoritative.prompts.length, added.prompts.length);
  } finally { await f.cleanup(); }
});

test("malformed persisted state and unsafe local release identifiers fail before network reads", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "publication-state.json"), encode({ schemaVersion: 1, v2Initialized: true, v1Frozen: false, arbitraryPath: "/private" }));
    const before = f.calls.length;
    await assert.rejects(readPublishedState(f.root, { allowBootstrap: true }, f.transport));
    assert.equal(f.calls.length, before);
    await assert.rejects(readLocalRelease(f.root, "../escape"));
    await assert.rejects(readLocalRelease(f.root, "valid-id\n"));
  } finally { await f.cleanup(); }
});

test("an incomplete or corrupt local v2 release never falls back to its valid legacy snapshot", async () => {
  const f = await fixture();
  try {
    const staged = await stageRelease(f.root, f.next, f.previous);
    const locale = join(f.root, "releases", f.next.version, "v2", "locales", "ja.json");
    await rm(locale);
    await assert.rejects(readLocalRelease(f.root, f.next.version), /Missing local/);
    await assert.rejects(publishRelease(f.root, staged, f.previous.observed, { operation: "daily" }, f.transport), /Missing local/);
    assert.deepEqual(uploadCalls(f.calls), []);
    assert.ok((await loadPublicationState(f.root)).pending);
    await writeFile(locale, Buffer.from("corrupt"));
    await assert.rejects(resumePublication(f.root, {}, f.transport), /byte count or checksum/);
    assert.deepEqual(uploadCalls(f.calls), []);
  } finally { await f.cleanup(); }
});

test("failed hold cleanup preserves an already-active intent and retries without pointer uploads", async () => {
  const f = await fixture();
  try {
    const staged = await stageRelease(f.root, f.next, f.previous), holdToClear = publicationIdentity({ hold: "original" });
    await assert.rejects(publishRelease(f.root, staged, f.previous.observed, { operation: "resume", holdToClear,
      afterActivation: async () => { throw new Error("Hold cleanup unavailable"); },
    }, f.transport), /Hold cleanup unavailable/);
    assert.equal((await loadPublicationState(f.root)).pending?.holdToClear, holdToClear);
    const writes = uploadCalls(f.calls);
    await resumePublication(f.root, { afterActivation: async intent => { assert.equal(intent.holdToClear, holdToClear); } }, f.transport);
    assert.deepEqual(uploadCalls(f.calls), writes);
    assert.equal((await loadPublicationState(f.root)).pending, undefined);
  } finally { await f.cleanup(); }
});
