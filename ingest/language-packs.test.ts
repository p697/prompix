import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { localizationLanguages, type Catalog, type Prompt } from "../packages/schema/catalog.ts";
import { languagePackByteLimit, languagePackManifestByteLimit, type LocalePack, type OriginalBase } from "../packages/schema/language-packs.ts";
import { applyRequestedLocale, joinLanguagePacks, splitLanguagePacks, verifyLanguagePackManifest, verifyLocalePack, verifyOriginalBase } from "./language-packs.ts";
import { translationFingerprint } from "./translation.ts";

const text = { title: "Original title", summary: "An original synthetic fixture.", prompt: "Keep {{name}}, 中文 and two  spaces.\nNext line.", example: "Example text", previewLabel: "Preview" };
const prompt = (id: string): Prompt => ({ id, kind: "text", ...text, tags: ["test"], model: "Any", toolURL: null, artwork: "test",
  source: { name: "Prompix", url: null, license: "Original", method: "Written for tests" }, media: null });
function localized(id: string, locales: readonly typeof localizationLanguages[number][]): Prompt {
  const item = prompt(id);
  item.localization = { sourceLanguage: "und", sourceFingerprint: translationFingerprint(item),
    translations: Object.fromEntries(locales.map(locale => [locale, { ...text, title: `Title ${locale}`, prompt: `  Translation ${locale}: 中文 🌙\n  ` }])) };
  return item;
}
const catalog = (prompts: Prompt[]): Catalog => ({ schemaVersion: 1, version: "edition-1111111111111111", publishedAt: "2026-10-01T00:00:00.000Z", prompts });
const fixture = () => catalog([localized("all-languages", localizationLanguages), localized("japanese", ["ja"]), localized("empty-localization", []), prompt("original-only")]);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Bundle = ReturnType<typeof splitLanguagePacks>;
function rewriteBase(bundle: Bundle, edit: (base: OriginalBase) => void): Bundle {
  const result = structuredClone(bundle), base = JSON.parse(Buffer.from(result.baseBytes).toString()) as OriginalBase;
  edit(base); result.baseBytes = encode(base);
  result.manifest.base.sha256 = digest(result.baseBytes); result.manifest.base.byteCount = result.baseBytes.length;
  result.manifestBytes = encode(result.manifest);
  return result;
}
function rewriteJapanese(bundle: Bundle, edit: (pack: LocalePack) => void): Bundle {
  const result = structuredClone(bundle), pack = JSON.parse(Buffer.from(result.localeBytes.ja!).toString()) as LocalePack;
  edit(pack); const bytes = encode(pack); result.localeBytes.ja = bytes;
  result.manifest.locales.ja!.sha256 = digest(bytes); result.manifest.locales.ja!.byteCount = bytes.length;
  result.manifestBytes = encode(result.manifest);
  return result;
}
const join = (bundle: Bundle) => joinLanguagePacks(bundle.manifestBytes, bundle.baseBytes, bundle.localeBytes);

test("nine sparse packs round-trip intact source fields, metadata and translated bytes", () => {
  const input = fixture();
  input.removedIDs = ["already-removed"];
  input.prompts[0].creator = { id: "author", platform: "web", displayName: "Author", profileURL: "https://example.com/author" };
  input.prompts[0].contentType = "skill";
  input.prompts[0].skill = { name: "Fixture", description: "Description", format: "agent-skills", entrypoint: "SKILL.md", repository: "https://example.com/repo", directory: "skills/example", installURL: "https://example.com/install", files: ["SKILL.md"] };
  const bundle = splitLanguagePacks(input);
  assert.deepEqual(join(bundle), input);
  assert.deepEqual(Object.keys(bundle.localeBytes), localizationLanguages);
  const base = verifyOriginalBase(bundle.manifest, bundle.baseBytes);
  assert.deepEqual(base.prompts[0].localization?.availableLanguages, localizationLanguages);
  assert.equal(bundle.baseBytes.includes(Buffer.from("Translation")), false);
  assert.equal(bundle.baseBytes.includes(Buffer.from('"translations"')), false);
  assert.equal(bundle.manifest.locales.ja?.count, 2);
  assert.equal(bundle.manifest.locales.en?.count, 1);
  assert.deepEqual(base.prompts[2].localization?.availableLanguages, []);
  assert.equal(Object.hasOwn(base.prompts[3], "localization"), false);
  assert.equal(verifyLocalePack(bundle.manifest, bundle.baseBytes, "ja", bundle.localeBytes.ja!).entries.length, 2);
});

test("canonical serialization is independent of object insertion order and does not mutate input", () => {
  const input = fixture(), before = structuredClone(input);
  const reverseKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)])) : value;
  const first = splitLanguagePacks(input), second = splitLanguagePacks(reverseKeys(input) as Catalog);
  assert.deepEqual(first, second);
  assert.deepEqual(input, before);
  assert.equal(Object.hasOwn(join(first), "removedIDs"), false);
});

test("single-locale assembly never adds English and absent or unsupported requests return originals", () => {
  const bundle = splitLanguagePacks(fixture());
  const japanese = applyRequestedLocale(bundle.manifestBytes, bundle.baseBytes, "ja", bundle.localeBytes.ja);
  assert.deepEqual(Object.keys(japanese.prompts[0].localization!.translations), ["ja"]);
  assert.equal(japanese.prompts[3].prompt, text.prompt);
  for (const requested of [undefined, null, "", "xx", "en-US"]) {
    const original = applyRequestedLocale(bundle.manifestBytes, bundle.baseBytes, requested);
    assert.deepEqual(original.prompts[0].localization!.translations, {});
    assert.equal(original.prompts[0].prompt, text.prompt);
  }
  const sparse = splitLanguagePacks(catalog([localized("japanese", ["ja"])]));
  assert.deepEqual(Object.keys(sparse.localeBytes), ["ja"]);
  assert.deepEqual(applyRequestedLocale(sparse.manifestBytes, sparse.baseBytes, "en").prompts[0].localization?.translations, {});
  assert.throws(() => applyRequestedLocale(bundle.manifestBytes, bundle.baseBytes, "ja"), /Missing requested/);
  const empty = splitLanguagePacks(catalog([prompt("original")]));
  assert.deepEqual(empty.localeBytes, {});
  assert.deepEqual(join(empty), catalog([prompt("original")]));
});

test("full assembly rejects missing, extra, truncated and corrupt packs", () => {
  const bundle = splitLanguagePacks(fixture());
  const missing = { ...bundle.localeBytes }; delete missing.fr;
  assert.throws(() => joinLanguagePacks(bundle.manifestBytes, bundle.baseBytes, missing), /Missing locale pack/);
  assert.throws(() => joinLanguagePacks(bundle.manifestBytes, bundle.baseBytes, { ...bundle.localeBytes, xx: bundle.localeBytes.en } as typeof missing), /Unadvertised/);
  for (const bytes of [bundle.localeBytes.ja!.slice(0, -1), encode({ broken: true }), bundle.localeBytes.en!]) {
    assert.throws(() => verifyLocalePack(bundle.manifest, bundle.baseBytes, "ja", bytes), /byte count or checksum/);
  }
  assert.throws(() => verifyOriginalBase(bundle.manifest, bundle.baseBytes.subarray(1)), /byte count or checksum/);
});

test("manifest rejects incorrect counts, byte counts, locale keys and noncanonical locations", () => {
  const bundle = splitLanguagePacks(fixture());
  for (const edit of [
    (m: typeof bundle.manifest) => { m.count++; },
    (m: typeof bundle.manifest) => { m.version += "\n"; },
    (m: typeof bundle.manifest) => { m.base.sha256 += "\n"; },
    (m: typeof bundle.manifest) => { m.base.byteCount = 0; },
    (m: typeof bundle.manifest) => { m.base.url += "?redirect=1"; },
    (m: typeof bundle.manifest) => { m.base.url = m.base.url.replace("api.prompix.dev", "example.com"); },
    (m: typeof bundle.manifest) => { m.locales.ja!.url = m.locales.en!.url; },
    (m: typeof bundle.manifest) => { m.locales.ja!.count = m.count + 1; },
    (m: typeof bundle.manifest) => { (m.locales as Record<string, unknown>).xx = m.locales.en; },
  ]) {
    const manifest = structuredClone(bundle.manifest); edit(manifest);
    assert.throws(() => verifyLanguagePackManifest(encode(manifest)));
  }
  const manifest = structuredClone(bundle.manifest); manifest.base.byteCount++;
  assert.throws(() => verifyOriginalBase(manifest, bundle.baseBytes), /byte count/);
});

test("base validation checks full source fingerprint, exact availability and original catalog invariants", () => {
  const bundle = splitLanguagePacks(fixture());
  for (const edit of [
    (base: OriginalBase) => { base.version = "another-version"; },
    (base: OriginalBase) => { base.version += "\n"; },
    (base: OriginalBase) => { base.prompts[0].id += "\n"; },
    (base: OriginalBase) => { base.prompts[0].localization!.sourceFingerprint += "\n"; },
    (base: OriginalBase) => { base.publishedAt = "2026-10-02T00:00:00Z"; },
    (base: OriginalBase) => { base.prompts.pop(); },
    (base: OriginalBase) => { base.prompts[0].title += "changed editorial text"; },
    (base: OriginalBase) => { base.prompts[0].localization!.availableLanguages.pop(); },
    (base: OriginalBase) => { base.prompts[0].localization!.availableLanguages.push("ja"); },
    (base: OriginalBase) => { base.prompts[1].id = base.prompts[0].id; },
    (base: OriginalBase) => { base.removedIDs = [base.prompts[0].id]; },
    (base: OriginalBase) => { base.prompts[0].contentType = "skill"; },
    (base: OriginalBase) => { (base.prompts[0].localization as unknown as Record<string, unknown>).translations = {}; },
  ]) {
    const bad = rewriteBase(bundle, edit);
    assert.throws(() => verifyOriginalBase(bad.manifest, bad.baseBytes));
  }
  const input = fixture(); input.prompts[0].summary += " New description";
  assert.throws(() => splitLanguagePacks(input), /fingerprint/);
  const missingTime = fixture(); delete missingTime.publishedAt;
  assert.throws(() => splitLanguagePacks(missingTime));
});

test("pack validation rejects wrong identities and every form of missing or unadvertised entry", () => {
  const bundle = splitLanguagePacks(fixture());
  for (const edit of [
    (pack: LocalePack) => { pack.version = "different-version"; },
    (pack: LocalePack) => { pack.version += "\n"; },
    (pack: LocalePack) => { pack.entries[0].id += "\n"; },
    (pack: LocalePack) => { pack.entries[0].sourceFingerprint += "\n"; },
    (pack: LocalePack) => { pack.publishedAt = "2026-10-02T00:00:00Z"; },
    (pack: LocalePack) => { pack.locale = "en"; },
    (pack: LocalePack) => { pack.baseSha256 = "f".repeat(64); },
    (pack: LocalePack) => { pack.entries.pop(); },
    (pack: LocalePack) => { pack.entries[1] = pack.entries[0]; },
    (pack: LocalePack) => { pack.entries[0].id = "unknown"; },
    (pack: LocalePack) => { pack.entries[0].id = "original-only"; },
    (pack: LocalePack) => { pack.entries[0].sourceFingerprint = "f".repeat(64); },
    (pack: LocalePack) => { pack.entries[0].content.prompt = " "; },
  ]) assert.throws(() => join(rewriteJapanese(bundle, edit)));
  const sparse = splitLanguagePacks(catalog([localized("japanese", ["ja"])]));
  assert.throws(() => verifyLocalePack(sparse.manifest, sparse.baseBytes, "en", bundle.localeBytes.en!), /not advertised/);
});

test("unsupported nested fields cannot bypass validation through schema stripping", () => {
  const bundle = splitLanguagePacks(fixture());
  const base = rewriteBase(bundle, value => {
    (value.prompts[0].source as unknown as Record<string, unknown>).privateNote = "Unsupported";
  });
  assert.throws(() => verifyOriginalBase(base.manifest, base.baseBytes), /Unsupported artifact fields/);
  const pack = rewriteJapanese(bundle, value => {
    (value.entries[0].content as unknown as Record<string, unknown>).unvalidated = "Unsupported";
  });
  assert.throws(() => join(pack), /Unsupported artifact fields/);
  const input = fixture();
  (input.prompts[0].source as unknown as Record<string, unknown>).privateNote = "Unsupported";
  assert.throws(() => splitLanguagePacks(input), /Unsupported artifact fields/);
});

function utf8Padding(length: number): string { return "文".repeat(Math.floor(length / 3)) + "x".repeat(length % 3); }
test("decoded UTF-8 base plus requested locale accepts the exact limit and rejects one extra byte", () => {
  for (const withLocale of [false, true]) {
    const input = catalog([withLocale ? localized("sized", ["ja"]) : prompt("sized")]);
    // This independent original-only record grows the base without exceeding per-field translation limits.
    input.prompts.push(prompt("padding"));
    const initial = splitLanguagePacks(input);
    const used = initial.baseBytes.length + (initial.localeBytes.ja?.byteLength ?? 0);
    input.prompts[1].example += utf8Padding(languagePackByteLimit - used);
    const exact = splitLanguagePacks(input);
    assert.equal(exact.baseBytes.length + (exact.localeBytes.ja?.byteLength ?? 0), languagePackByteLimit);
    assert.ok(exact.baseBytes.toString().length < exact.baseBytes.length);
    assert.deepEqual(join(exact), input);
    input.prompts[1].example += "x";
    assert.throws(() => splitLanguagePacks(input));
  }
});

test("manifest measures decoded bytes including whitespace and rejects invalid UTF-8", () => {
  const { manifestBytes } = splitLanguagePacks(fixture());
  const exact = Buffer.concat([manifestBytes, Buffer.alloc(languagePackManifestByteLimit - manifestBytes.length, 32)]);
  verifyLanguagePackManifest(exact);
  assert.throws(() => verifyLanguagePackManifest(Buffer.concat([exact, Buffer.from(" ")])), /byte limit/);
  assert.throws(() => verifyLanguagePackManifest(Buffer.concat([manifestBytes, Buffer.from([0xff])])));
});

test("source fingerprint golden vector preserves field order, Unicode, JSON escaping and cover text", () => {
  const item: Prompt = { ...prompt("unicode-vector"), title: "原文 “月” 🌙", summary: 'Line\n"quoted"',
    prompt: "Keep \\path\tand {{name}}\n日本語 / 한글", example: "例子\u2028next", previewLabel: "预览",
    cover: { text: "Café", eyebrow: "第一行", tone: "sage" } };
  assert.equal(translationFingerprint(item), "2524622fba9eba4d501d10280727a975775023683feb42c6911e62d61a063dba");
  item.localization = { sourceLanguage: "und", sourceFingerprint: translationFingerprint(item), translations: {} };
  assert.deepEqual(join(splitLanguagePacks(catalog([item]))), catalog([item]));
});
