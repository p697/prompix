import { z } from "zod";
import { json } from "./publication.ts";
import { emptyTranslationCache, translationVersion, type TranslationCache } from "./translation.ts";

const cacheSchema = z.object({ version: z.literal(translationVersion), segments: z.record(z.string(), z.record(z.string().regex(/^[a-f0-9]{64}$/), z.string().max(180000))) , provenance: z.record(z.string(), z.record(z.string(), z.object({ provider: z.string(), model: z.string(), generatedAt: z.string() }))).optional() }).strict();
export async function readTranslationCache(path: string): Promise<TranslationCache> {
  try {
    const parsed = cacheSchema.safeParse(await json<unknown>(path, emptyTranslationCache()));
    if (!parsed.success) throw new Error("Invalid translation cache schema");
    return parsed.data;
  } catch { throw new Error("Translation cache cannot be read safely; publication stopped"); }
}
