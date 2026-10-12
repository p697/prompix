import { createHash } from "node:crypto";
import type { z } from "zod";
import { catalogSchema, localizationLanguages, type Catalog, type Prompt } from "../packages/schema/catalog.ts";
import {
  languagePackByteLimit, languagePackManifestByteLimit, languagePackManifestSchema, languagePackOrigin,
  localePackSchema, originalBaseSchema,
  type LanguagePackLocale, type LanguagePackManifest, type LocalePack, type OriginalBase,
} from "../packages/schema/language-packs.ts";
import { translationFingerprint } from "./translation.ts";

export type LocaleBytes = Partial<Record<LanguagePackLocale, Uint8Array>>;
type Descriptor = LanguagePackManifest["base"];
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Canonical object keys, intact string bytes and array order, no filesystem writes. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}
function encode(value: unknown): Buffer { return Buffer.from(JSON.stringify(canonical(value)) + "\n"); }
function assertUnchangedShape(raw: unknown, parsed: unknown): void {
  if (typeof raw === "string" && typeof parsed === "string" && (raw === parsed || raw.trim() === parsed)) return;
  if (raw && parsed && typeof raw === "object" && typeof parsed === "object") {
    const original = raw as Record<string, unknown>, validated = parsed as Record<string, unknown>;
    const keys = Object.keys(original);
    if (Array.isArray(raw) !== Array.isArray(parsed) || keys.length !== Object.keys(validated).length
        || keys.some(key => !Object.hasOwn(validated, key))) throw new Error("Unsupported artifact fields");
    for (const key of keys) assertUnchangedShape(original[key], validated[key]);
  } else if (raw !== parsed) throw new Error("Unexpected artifact normalization");
}
// Existing schemas trim strings. Preserve source/translated bytes but reject every
// structural normalization, including nested unknown fields those schemas strip.
function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  assertUnchangedShape(value, schema.parse(value));
  return value as T;
}
function decode<T>(bytes: Uint8Array, maximum: number, schema: z.ZodType<T>): T {
  if (bytes.byteLength > maximum) throw new Error("Decoded artifact exceeds byte limit");
  return validate(schema, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}
function artifact<T>(bytes: Uint8Array, descriptor: Descriptor, schema: z.ZodType<T>): T {
  if (bytes.byteLength !== descriptor.byteCount || digest(bytes) !== descriptor.sha256)
    throw new Error("Artifact byte count or checksum mismatch");
  return decode(bytes, languagePackByteLimit, schema);
}
function originalCatalog(base: OriginalBase): Catalog {
  const prompts: Prompt[] = base.prompts.map(item => {
    const { localization, ...original } = item;
    return { ...original, ...(localization ? { localization: {
      sourceLanguage: localization.sourceLanguage, sourceFingerprint: localization.sourceFingerprint, translations: {},
    } } : {}) };
  });
  return { ...base, schemaVersion: 1, prompts };
}
function assertSourceIdentity(catalog: Catalog): void {
  validate(catalogSchema, catalog);
  for (const item of catalog.prompts) {
    if (item.localization && item.localization.sourceFingerprint !== translationFingerprint(item))
      throw new Error(`Original source fingerprint mismatch: ${item.id}`);
  }
}

export function verifyLanguagePackManifest(bytes: Uint8Array): LanguagePackManifest {
  return decode(bytes, languagePackManifestByteLimit, languagePackManifestSchema);
}
export function verifyOriginalBase(manifest: LanguagePackManifest, bytes: Uint8Array): OriginalBase {
  validate(languagePackManifestSchema, manifest);
  const base = artifact(bytes, manifest.base, originalBaseSchema);
  if (base.version !== manifest.version || base.publishedAt !== manifest.publishedAt || base.prompts.length !== manifest.count)
    throw new Error("Base release metadata mismatch");
  assertSourceIdentity(originalCatalog(base));
  for (const locale of localizationLanguages) {
    const count = base.prompts.filter(item => item.localization?.availableLanguages.includes(locale)).length;
    if (count !== (manifest.locales[locale]?.count ?? 0)) throw new Error(`Locale availability mismatch: ${locale}`);
  }
  return base;
}

export function verifyLocalePack(manifest: LanguagePackManifest, baseBytes: Uint8Array, locale: LanguagePackLocale, bytes: Uint8Array): LocalePack {
  return verifyPack(manifest, verifyOriginalBase(manifest, baseBytes), locale, bytes);
}
function verifyPack(manifest: LanguagePackManifest, base: OriginalBase, locale: LanguagePackLocale, bytes: Uint8Array): LocalePack {
  const descriptor = manifest.locales[locale];
  if (!descriptor) throw new Error("Locale is not advertised");
  const pack = artifact(bytes, descriptor, localePackSchema);
  if (pack.version !== manifest.version || pack.publishedAt !== manifest.publishedAt || pack.locale !== locale
      || pack.baseSha256 !== manifest.base.sha256 || pack.entries.length !== descriptor.count
      || base.version !== manifest.version || base.publishedAt !== manifest.publishedAt)
    throw new Error("Locale release metadata mismatch");
  const expected = new Map(base.prompts.filter(item => item.localization?.availableLanguages.includes(locale)).map(item => [item.id, item]));
  for (const entry of pack.entries) {
    const source = expected.get(entry.id);
    if (!source || entry.sourceFingerprint !== source.localization?.sourceFingerprint) throw new Error("Locale entry identity mismatch");
    expected.delete(entry.id);
  }
  if (expected.size) throw new Error("Locale pack is missing advertised entries");
  return pack;
}
function applyPacks(base: OriginalBase, packs: readonly LocalePack[]): Catalog {
  const catalog = originalCatalog(base);
  const byID = new Map(catalog.prompts.map(item => [item.id, item]));
  for (const pack of packs) for (const entry of pack.entries) byID.get(entry.id)!.localization!.translations[pack.locale] = entry.content;
  return catalog;
}

/** Reconstruct the complete publisher model; never quietly lose an unavailable pack. */
export function joinLanguagePacks(manifestBytes: Uint8Array, baseBytes: Uint8Array, localeBytes: LocaleBytes): Catalog {
  const manifest = verifyLanguagePackManifest(manifestBytes);
  const base = verifyOriginalBase(manifest, baseBytes);
  if (Object.keys(localeBytes).some(locale => !Object.hasOwn(manifest.locales, locale))) throw new Error("Unadvertised locale pack");
  const packs = localizationLanguages.filter(locale => manifest.locales[locale]).map(locale => {
    const bytes = localeBytes[locale];
    if (!bytes) throw new Error(`Missing locale pack: ${locale}`);
    return verifyPack(manifest, base, locale, bytes);
  });
  return applyPacks(base, packs);
}

/** Exact supported locale codes only. Missing/unsupported requests use intact originals. */
export function applyRequestedLocale(manifestBytes: Uint8Array, baseBytes: Uint8Array, requestedLocale?: string | null, localeBytes?: Uint8Array): Catalog {
  const manifest = verifyLanguagePackManifest(manifestBytes);
  const base = verifyOriginalBase(manifest, baseBytes);
  const locale = localizationLanguages.find(value => value === requestedLocale);
  if (!locale || !manifest.locales[locale]) return originalCatalog(base);
  if (!localeBytes) throw new Error(`Missing requested locale pack: ${locale}`);
  return applyPacks(base, [verifyPack(manifest, base, locale, localeBytes)]);
}

export function splitLanguagePacks(input: Catalog): {
  manifest: LanguagePackManifest; manifestBytes: Buffer; baseBytes: Buffer; localeBytes: LocaleBytes;
} {
  assertSourceIdentity(input);
  const base = validate(originalBaseSchema, {
    ...input, schemaVersion: 2,
    prompts: input.prompts.map(item => {
      const { localization, ...original } = item;
      return { ...original, ...(localization ? { localization: {
        sourceLanguage: localization.sourceLanguage, sourceFingerprint: localization.sourceFingerprint,
        availableLanguages: localizationLanguages.filter(locale => localization.translations[locale]),
      } } : {}) };
    }),
  });
  const baseBytes = encode(base);
  const prefix = `${languagePackOrigin}/releases/${base.version}/v2`;
  const describe = (bytes: Uint8Array, url: string, count: number): Descriptor => ({ url, sha256: digest(bytes), byteCount: bytes.byteLength, count });
  const locales: LanguagePackManifest["locales"] = {}, localeBytes: LocaleBytes = {};
  for (const locale of localizationLanguages) {
    const entries = input.prompts.flatMap(item => {
      const content = item.localization?.translations[locale];
      return content ? [{ id: item.id, sourceFingerprint: item.localization!.sourceFingerprint, content }] : [];
    });
    if (!entries.length) continue;
    const bytes = encode({ schemaVersion: 2, version: base.version, publishedAt: base.publishedAt, locale, baseSha256: digest(baseBytes), entries });
    localeBytes[locale] = bytes;
    locales[locale] = describe(bytes, `${prefix}/locales/${locale}.json`, entries.length);
  }
  const manifest = validate(languagePackManifestSchema, {
    schemaVersion: 2, version: base.version, publishedAt: base.publishedAt, count: base.prompts.length,
    base: describe(baseBytes, `${prefix}/base.json`, base.prompts.length), locales,
  });
  const manifestBytes = encode(manifest);
  // Exercise the same complete verification as consumers before returning artifacts.
  joinLanguagePacks(manifestBytes, baseBytes, localeBytes);
  return { manifest, manifestBytes, baseBytes, localeBytes };
}
