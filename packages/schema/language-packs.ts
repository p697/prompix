import { z } from "zod";
import { localizationLanguages, promptSchema, translatedContent } from "./catalog.ts";

export const languagePackManifestByteLimit = 32_000;
export const languagePackByteLimit = 10_000_000;
export const languagePackOrigin = "https://api.prompix.dev";
export const languagePackLocaleSchema = z.enum(localizationLanguages);
export type LanguagePackLocale = z.infer<typeof languagePackLocaleSchema>;
// JavaScript's $ alone also matches before a final newline.
const resource = z.string().regex(/^[a-z0-9-]+$(?![\s\S])/);
const sha256 = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime();
const descriptor = z.object({
  url: z.string().url(), sha256,
  byteCount: z.number().int().positive().max(languagePackByteLimit),
  count: z.number().int().positive().max(1000),
}).strict();

export const languagePackManifestSchema = z.object({
  schemaVersion: z.literal(2), version: resource, publishedAt: timestamp,
  count: z.number().int().positive().max(1000), base: descriptor,
  locales: z.partialRecord(languagePackLocaleSchema, descriptor),
}).strict().superRefine((manifest, context) => {
  const prefix = `${languagePackOrigin}/releases/${manifest.version}/v2`;
  if (manifest.base.url !== `${prefix}/base.json` || manifest.base.count !== manifest.count)
    context.addIssue({ code: "custom", message: "Invalid base location or count" });
  for (const [locale, pack] of Object.entries(manifest.locales)) {
    if (pack.url !== `${prefix}/locales/${locale}.json` || pack.count > manifest.count)
      context.addIssue({ code: "custom", message: "Invalid locale location or count" });
    if (manifest.base.byteCount + pack.byteCount > languagePackByteLimit)
      context.addIssue({ code: "custom", message: "Base plus requested locale exceeds the decoded byte limit" });
  }
});
export type LanguagePackManifest = z.infer<typeof languagePackManifestSchema>;

const originalPromptSchema = z.object({
  ...promptSchema.shape,
  id: resource,
  artwork: resource,
  localization: z.object({
    sourceLanguage: z.string().trim().min(1).max(40), sourceFingerprint: sha256,
    availableLanguages: z.array(languagePackLocaleSchema).max(localizationLanguages.length)
      .refine(locales => new Set(locales).size === locales.length, "Duplicate available language"),
  }).strict().optional(),
}).strict();
export const originalBaseSchema = z.object({
  schemaVersion: z.literal(2), version: resource, publishedAt: timestamp,
  removedIDs: z.array(resource).optional(),
  prompts: z.array(originalPromptSchema).min(1).max(1000),
}).strict();
export type OriginalBase = z.infer<typeof originalBaseSchema>;

export const localePackSchema = z.object({
  schemaVersion: z.literal(2), version: resource, publishedAt: timestamp,
  locale: languagePackLocaleSchema, baseSha256: sha256,
  entries: z.array(z.object({
    id: resource, sourceFingerprint: sha256, content: translatedContent,
  }).strict()).min(1).max(1000),
}).strict();
export type LocalePack = z.infer<typeof localePackSchema>;
