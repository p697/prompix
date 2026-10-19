import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localizationLanguages, type Catalog, type Prompt } from "../packages/schema/catalog.ts";
import { beginDailyPublication, clearMatchingPublicationHold, languagePackPublishingEnabled, prepareDailyStaging, publishDailyCatalog, readPublicationHold } from "./daily-publication.ts";
import { atomic, base, digest, editionVersion, manifestSchema, rollbackCatalog, serializeCatalog } from "./publication.ts";
import { languagePackEditionVersion, loadPublicationState, publicationIdentity, publishRelease, readPublishedState, stageRelease, type ReleaseTransport } from "./release-publication.ts";
import { recoveryPublicationHooks } from "./recovery-publication.ts";
import { translationFingerprint } from "./translation.ts";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
function prompt(id: string): Prompt {
  const item: Prompt = { id, kind: "text", title: id, summary: "An original fixture", prompt: "Write a teacup story.",
    example: "The teacup grew wings.", previewLabel: "Preview", tags: ["test"], model: "Any", toolURL: null, artwork: "test",
    source: { name: "Prompix", url: null, license: "Original", method: "Written for tests" }, media: null };
  item.localization = { sourceLanguage: "en", sourceFingerprint: translationFingerprint(item), translations: Object.fromEntries(localizationLanguages.map(locale => [locale, {
    title: `${id} ${locale}`, summary: "Translated summary", prompt: `Teacup story ${locale}`, example: "Example", previewLabel: "Preview",
  }])) };
  return item;
}
function catalog(prompts: Prompt[], removedIDs: string[] = []): Catalog {
  return { schemaVersion: 1, version: editionVersion(prompts, removedIDs), publishedAt: "2026-10-01T00:00:00.000Z", prompts, removedIDs };
}
async function fixture(original = catalog([prompt("keep"), prompt("remove-later")])) {
  const root = await mkdtemp(join(tmpdir(), "prompix-daily-v2-"));
  const manifest = manifestSchema.parse({ schemaVersion: 1, version: original.version, publishedAt: original.publishedAt,
    count: original.prompts.length, sha256: digest(serializeCatalog(original)), catalog: `${base}/releases/${original.version}/catalog.json` });
  const files = new Map([[`${base}/v1/latest.json`, encode(manifest)], [manifest.catalog, serializeCatalog(original)]]);
  const calls: string[] = [];
  let beforeUpload: ((key: string) => Promise<void> | void) | undefined;
  const transport: ReleaseTransport = {
    async read(url) { calls.push(`read:${url}`); const bytes = files.get(url); return bytes ? { status: 200, bytes } : { status: 404 }; },
    async upload(key, path) { calls.push(`upload:${key}`); await beforeUpload?.(key); files.set(`${base}/${key}`, await readFile(path)); },
  };
  const next = catalog([...original.prompts, prompt("new-prompt")]);
  return { root, original, next, files, calls, transport, failUpload(callback?: typeof beforeUpload) { beforeUpload = callback; },
    start: () => beginDailyPublication(root, { resumePublishing: false, env: { PROMPIX_LANGUAGE_PACKS_ENABLED: "true" } }, transport),
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("post-bootstrap daily replay gives untrimmed cache text a distinct stable edition without rewriting legacy artifacts", async () => {
  const raw = catalog([prompt("keep"), prompt("remove-later")]);
  raw.prompts[0].localization!.translations.fr!.example = "  An original French example.\n";
  // Legacy daily hashed the cache text first, then its serializer trimmed the stored text.
  raw.version = editionVersion(raw.prompts, []);
  const f = await fixture(raw);
  try {
    const preparation = await f.start(), prior = preparation.previous!;
    const legacyPath = join(f.root, "releases", raw.version);
    await mkdir(legacyPath, { recursive: true });
    await writeFile(join(legacyPath, "catalog.json"), f.files.get(prior.v1.manifest.catalog)!);
    await atomic(join(legacyPath, "manifest.json"), prior.v1.manifest);
    await publishDailyCatalog(f.root, prior.authoritative, preparation, f.transport);
    const legacyFiles = new Map(f.files);
    const replay = await f.start();
    await assert.rejects(publishDailyCatalog(f.root, raw, replay, f.transport), /different content/);
    const next = { ...raw, version: languagePackEditionVersion(raw.prompts, []) };
    assert.notEqual(next.version, raw.version);
    const published = await publishDailyCatalog(f.root, next, replay, f.transport);
    assert.deepEqual(published.authoritative, next);
    assert.deepEqual(published.v1.catalog, next);
    for (const [url, bytes] of legacyFiles) if (!url.endsWith("latest.json")) assert.deepEqual(f.files.get(url), bytes);
    const filesAfter = new Map(f.files), writes = f.calls.filter(call => call.startsWith("upload:"));
    const repeated = { ...published.authoritative, publishedAt: "2026-10-09T00:00:00.000Z" };
    repeated.version = languagePackEditionVersion(repeated.prompts, repeated.removedIDs ?? []);
    assert.equal(repeated.version, next.version);
    await publishDailyCatalog(f.root, repeated, await f.start(), f.transport);
    assert.deepEqual(f.files, filesAfter);
    assert.deepEqual(f.calls.filter(call => call.startsWith("upload:")), writes);
    assert.equal((await loadPublicationState(f.root)).pending, undefined);
  } finally { await f.cleanup(); }
});

test("v2 edition identity ignores object-key order but preserves text, item order, media and creator changes", () => {
  const item = prompt("identity"), other = prompt("other");
  item.creator = { id: "creator", platform: "web", displayName: "Creator", profileURL: "https://example.com/creator" };
  item.media = { image: null, video: null, demoURL: null, imageURL: `${base}/media/${"a".repeat(64)}.jpg` };
  const original = [item, other], version = languagePackEditionVersion(original, ["removed-b", "removed-a"]);
  function reordered(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reordered);
    return value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reordered(child)])) : value;
  }
  assert.equal(languagePackEditionVersion(reordered(original) as Prompt[], ["removed-a", "removed-b", "removed-a"]), version);
  assert.notEqual(languagePackEditionVersion([...original].reverse(), ["removed-a", "removed-b"]), version);
  for (const change of [
    (value: Prompt) => { value.prompt += " "; },
    (value: Prompt) => { value.localization!.translations.fr!.example += "\n"; },
    (value: Prompt) => { value.creator!.displayName += " updated"; },
    (value: Prompt) => { value.media!.imageURL = `${base}/media/${"b".repeat(64)}.jpg`; },
  ]) {
    const changed = structuredClone(original); change(changed[0]);
    assert.notEqual(languagePackEditionVersion(changed, ["removed-a", "removed-b"]), version);
  }
  assert.notEqual(languagePackEditionVersion(original, ["removed-a"]), version);
});

test("bootstrap flag is optional only before remote or local v2 initialization", async () => {
  const f = await fixture();
  try {
    assert.equal(await languagePackPublishingEnabled(f.root, {}, f.transport), false);
    const start = await f.start();
    await publishDailyCatalog(f.root, f.next, start, f.transport);
    assert.equal(await languagePackPublishingEnabled(f.root, {}, f.transport), true);
    await rm(join(f.root, "publication-state.json"));
    assert.equal(await languagePackPublishingEnabled(f.root, {}, f.transport), true);
    const recovered = await beginDailyPublication(f.root, { resumePublishing: false, env: {} }, f.transport);
    assert.deepEqual(recovered.previous?.authoritative, f.next);
    f.files.set(`${base}/v2/latest.json`, Buffer.from("corrupt"));
    await assert.rejects(languagePackPublishingEnabled(f.root, {}, f.transport));
    await atomic(join(f.root, "publication-state.json"), { schemaVersion: 1, v2Initialized: true, v1Frozen: false });
    f.files.delete(`${base}/v2/latest.json`);
    await assert.rejects(beginDailyPublication(f.root, { resumePublishing: false, env: {} }, f.transport), /refusing legacy fallback/);
  } finally { await f.cleanup(); }
});

test("selection fails closed on network failures and malformed persisted state", async () => {
  const f = await fixture();
  try {
    await assert.rejects(languagePackPublishingEnabled(f.root, {}, { ...f.transport, read: async () => { throw new Error("HTTP 503"); } }), /503/);
    await writeFile(join(f.root, "publication-state.json"), "{}");
    const before = f.calls.length;
    await assert.rejects(languagePackPublishingEnabled(f.root, {}, f.transport));
    assert.equal(f.calls.length, before);
  } finally { await f.cleanup(); }
});

test("staging reads all languages but neither resumes pending work nor changes a hold", async () => {
  const f = await fixture();
  try {
    const hold = { reason: "review" };
    await atomic(join(f.root, "publication-hold.json"), hold);
    const staged = await prepareDailyStaging(f.root, { PROMPIX_LANGUAGE_PACKS_ENABLED: "true" }, f.transport);
    assert.deepEqual(staged.previous?.authoritative, f.original);
    assert.equal(f.calls.some(value => value.startsWith("upload:")), false);
    const start = await beginDailyPublication(f.root, { resumePublishing: true, env: { PROMPIX_LANGUAGE_PACKS_ENABLED: "true" } }, f.transport);
    f.failUpload(() => { throw new Error("Offline"); });
    await assert.rejects(publishDailyCatalog(f.root, f.next, start, f.transport));
    const state = await loadPublicationState(f.root);
    const uploads = f.calls.filter(value => value.startsWith("upload:"));
    f.failUpload();
    await assert.rejects(prepareDailyStaging(f.root, {}, f.transport), /pending publication/);
    assert.deepEqual(await loadPublicationState(f.root), state);
    assert.deepEqual(await readPublicationHold(f.root), hold);
    assert.deepEqual(f.calls.filter(value => value.startsWith("upload:")), uploads);
  } finally { await f.cleanup(); }
});

test("a hold stops preparation and only a matching explicitly resumed hold is cleared", async () => {
  const f = await fixture();
  try {
    const hold = { reason: "review", version: f.original.version };
    await atomic(join(f.root, "publication-hold.json"), hold);
    assert.deepEqual((await f.start()).held, hold);
    assert.equal(f.calls.length, 0);
    const start = await beginDailyPublication(f.root, { resumePublishing: true, env: { PROMPIX_LANGUAGE_PACKS_ENABLED: "true" } }, f.transport);
    assert.equal(start.holdToClear, publicationIdentity(hold));
    await publishDailyCatalog(f.root, f.next, start, f.transport);
    assert.equal(await readPublicationHold(f.root), null);
    await clearMatchingPublicationHold(f.root, { holdToClear: start.holdToClear });
    await atomic(join(f.root, "publication-hold.json"), { reason: "new-review" });
    await assert.rejects(clearMatchingPublicationHold(f.root, { holdToClear: start.holdToClear }), /different hold/);
    assert.deepEqual(await readPublicationHold(f.root), { reason: "new-review" });
  } finally { await f.cleanup(); }
});

for (const failedKey of ["v1/latest.json", "v2/latest.json", "base.json"]) test(`daily preflight resumes ${failedKey} interruption without fresh preparation`, async () => {
  const f = await fixture();
  try {
    const start = await f.start();
    f.failUpload(key => { if (key.endsWith(failedKey)) throw new Error("Offline"); });
    await assert.rejects(publishDailyCatalog(f.root, f.next, start, f.transport), /Offline/);
    const target = (await loadPublicationState(f.root)).pending!.targets;
    f.failUpload();
    const resumed = await beginDailyPublication(f.root, { resumePublishing: false, env: {} }, f.transport);
    assert.equal(resumed.recovered?.authoritative.version, target.v2.version);
    assert.deepEqual(resumed.recovered?.authoritative, f.next);
    assert.equal(resumed.recovered?.state.pending, undefined);
    assert.equal(resumed.held, undefined);
    assert.equal(f.calls.filter(value => value === "upload:v2/latest.json").length, failedKey === "v2/latest.json" ? 2 : 1);
  } finally { await f.cleanup(); }
});

test("pending preparation applies new tombstones while retaining every prepared language", async () => {
  const f = await fixture();
  try {
    const spaced = f.next.prompts[0];
    spaced.prompt = "  " + spaced.prompt + "\r\n  ";
    spaced.localization!.sourceFingerprint = translationFingerprint(spaced);
    for (const content of Object.values(spaced.localization!.translations)) content!.prompt = "  " + content!.prompt + "\r\n  ";
    f.next.version = editionVersion(f.next.prompts, []);
    const start = await f.start();
    f.failUpload(() => { throw new Error("Offline"); });
    await assert.rejects(publishDailyCatalog(f.root, f.next, start, f.transport));
    await atomic(join(f.root, "moderation.json"), { removedIDs: ["remove-later"] });
    f.failUpload();
    const resumed = await beginDailyPublication(f.root, { resumePublishing: false, env: {} }, f.transport);
    const actual = resumed.recovered!.authoritative;
    assert.notEqual(actual.version, f.next.version);
    assert.deepEqual(actual.removedIDs, ["remove-later"]);
    assert.deepEqual(actual.prompts, f.next.prompts.filter(item => item.id !== "remove-later"));
    assert.equal(Object.keys(actual.prompts[0].localization!.translations).length, 9);
    assert.equal(resumed.recovered!.v1.catalog.prompts.some(item => item.id === "remove-later"), false);
  } finally { await f.cleanup(); }
});

test("pending rollback is resumed and its hold still stops the next daily preparation", async () => {
  const f = await fixture();
  try {
    const previous = await readPublishedState(f.root, { allowBootstrap: true }, f.transport);
    const rollback = rollbackCatalog(f.original, ["remove-later"]);
    const staged = await stageRelease(f.root, rollback, previous);
    f.failUpload(key => { if (key === "v1/latest.json") throw new Error("Offline"); });
    await assert.rejects(publishRelease(f.root, staged, previous.observed, { operation: "rollback", ...recoveryPublicationHooks(f.root) }, f.transport));
    const originalHold = await readFile(join(f.root, "publication-hold.json"));
    f.failUpload();
    const result = await beginDailyPublication(f.root, { resumePublishing: false, env: {} }, f.transport);
    assert.equal(result.recovered!.authoritative.version, rollback.version);
    assert.ok(result.held);
    assert.deepEqual(await readFile(join(f.root, "publication-hold.json")), originalHold);
    const next = await beginDailyPublication(f.root, { resumePublishing: false, env: {} }, f.transport);
    assert.ok(next.held); assert.equal(next.previous, undefined); assert.equal(next.recovered, undefined);
  } finally { await f.cleanup(); }
});

test("a new unrelated hold preserves an ordinary pending intent without completing it", async () => {
  const f = await fixture();
  try {
    f.failUpload(() => { throw new Error("Offline"); });
    await assert.rejects(publishDailyCatalog(f.root, f.next, await f.start(), f.transport));
    const pending = (await loadPublicationState(f.root)).pending;
    const hold = { reason: "new-review" };
    await atomic(join(f.root, "publication-hold.json"), hold);
    f.failUpload();
    const writes = f.calls.filter(value => value.startsWith("upload:"));
    const result = await beginDailyPublication(f.root, { resumePublishing: true, env: {} }, f.transport);
    assert.deepEqual(result.held, hold); assert.equal(result.recovered, undefined);
    assert.deepEqual((await loadPublicationState(f.root)).pending, pending);
    assert.deepEqual(f.calls.filter(value => value.startsWith("upload:")), writes);
  } finally { await f.cleanup(); }
});

test("new holds or removals introduced during uploads prevent pointer activation", async () => {
  for (const change of ["hold", "removal"]) {
    const f = await fixture();
    try {
      const start = await f.start();
      f.failUpload(async key => {
        if (key.endsWith("/catalog.json")) {
          await atomic(join(f.root, change === "hold" ? "publication-hold.json" : "moderation.json"),
            change === "hold" ? { reason: "new-review" } : { removedIDs: ["remove-later"] });
        }
      });
      await assert.rejects(publishDailyCatalog(f.root, f.next, start, f.transport), /hold changed|New removals/);
      assert.equal(f.calls.some(value => /^upload:v[12]\/latest.json$/.test(value)), false);
      assert.ok((await loadPublicationState(f.root)).pending);
    } finally { await f.cleanup(); }
  }
});

test("campaign holds arriving during upload block both initial activation and ordinary daily recovery", async () => {
  const { registerQualityHoldScope, qualityHoldIdentity } = await import("./quality-holds.ts");
  const f = await fixture(), campaign = await mkdtemp(join(tmpdir(), "prompix-live-campaign-hold-"));
  try {
    await atomic(join(campaign, "quality-holds.json"), { schemaVersion: 1, holds: {} });
    await registerQualityHoldScope(f.root, campaign);
    const preparation = await f.start(), held = f.next.prompts.at(-1)!;
    f.failUpload(async key => {
      if (key.endsWith("/catalog.json")) await atomic(join(campaign, "quality-holds.json"), { schemaVersion: 1, holds: {
        [held.id]: { sourceIdentitySHA256: qualityHoldIdentity(held), evidenceSHA256: "a".repeat(64), reason: "Late owner finding", reviewerID: "test", reviewedAt: new Date().toISOString() },
      } });
    });
    await assert.rejects(publishDailyCatalog(f.root, f.next, preparation, f.transport), /quality hold/);
    assert.equal(f.calls.some(value => /^upload:v[12]\/latest.json$/.test(value)), false);
    f.failUpload();
    await assert.rejects(f.start(), /quality hold/);
    assert.ok((await loadPublicationState(f.root)).pending);
  } finally { await f.cleanup(); await rm(campaign, { recursive: true, force: true }); }
});
