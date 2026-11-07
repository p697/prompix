import { z } from "zod";
import { interestIDs } from "./interests.ts";
import collectionDefinitions from "./collections.json" with { type: "json" };
export { collectionDefinitions };
export const collectionIDs = Object.keys(collectionDefinitions) as [keyof typeof collectionDefinitions, ...(keyof typeof collectionDefinitions)[]];
import { creatorSchema, localizationLanguages, promptSchema } from "./catalog.ts";
import { englishCardSchema, facetGroups, facetIDs, facetsSchema, generationModes, generationSchema, inputsSchema, modelFamilies, paletteSchema, rightsSchema, type FacetGroup } from "./enrichment.ts";

const allFacetIDs = facetGroups.flatMap(group => facetIDs[group]) as [string, ...string[]];
/** Facet IDs are unique across groups, so a filter names only the ID. */
export const facetGroupOf = (id: string): FacetGroup => facetGroups.find(group => facetIDs[group].includes(id))!;

export const feedPageLimit = 50;
export const feedResponseByteLimit = 1_000_000;
export const detailResponseByteLimit = 2_000_000;
export const contentID = z.string().max(200).regex(/^[a-z0-9-]+$(?![\s\S])/);
export const revisionID = z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
export const feedLocale = z.enum(["original", ...localizationLanguages]);
export type FeedLocale = z.infer<typeof feedLocale>;
/** Keep width and Latin accent matching consistent with the native search contract. */
export const normalizeFeedSearch = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "")
  .normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
/** Lists show general imagery unless the viewer opted into suggestive content. Unknown
 * imagery stays out of every list until reviewed; explicit imagery is never published.
 * Detail by ID is not filtered, so saved items and shared links keep working. */
export const listPresentation = z.enum(["general", "suggestive"]);
export const allowedPresentations = (presentation?: z.infer<typeof listPresentation>) =>
  presentation === "suggestive" ? ["general", "suggestive"] : ["general"];
export const feedFiltersSchema = z.object({
  locale: feedLocale.default("original"),
  presentation: listPresentation.optional(),
  sort: z.enum(["curated", "latest", "discovery", "recommended"]).optional(),
  seed: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  kind: z.enum(["text", "image", "video", "web", "skill"]).optional(),
  collection: z.enum(collectionIDs).optional(),
  creator: z.string().min(1).max(200).optional(),
  tag: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(200).optional(),
  facet: z.enum(allFacetIDs).optional(),
  mode: z.enum(generationModes).optional(),
  modelFamily: z.enum(modelFamilies).optional(),
  q: z.string().trim().max(120).default(""),
}).strict();
export type FeedFilters = z.infer<typeof feedFiltersSchema>;

/** Public card projection. Never include bodies, source posts or Skill files here. */
export const feedCardSchema = z.object({
  id: contentID, revision: revisionID,
  kind: z.enum(["text", "image", "video", "web"]),
  contentType: z.enum(["prompt", "skill"]),
  title: z.string().min(1).max(250), summary: z.string().min(1).max(4000),
  tags: z.array(z.string().min(1).max(100)).max(50), model: z.string().min(1).max(200),
  presentation: z.enum(["general", "suggestive", "unknown"]).optional(),
  topics: z.array(z.string().refine(value => interestIDs.includes(value))).max(12).optional(),
  artwork: contentID, previewLabel: z.string().max(500),
  creator: creatorSchema.optional(), media: promptSchema.shape.media,
  cover: promptSchema.shape.cover,
  language: feedLocale,
  availableLanguages: z.array(z.enum(localizationLanguages)).max(9),
  facets: facetsSchema.optional(), generation: generationSchema.optional(),
  palette: paletteSchema.optional(), rights: rightsSchema.optional(),
}).strict();
export type FeedCard = z.infer<typeof feedCardSchema>;
/** Stored original cards also carry the English card text, served when English has no full translation.
 * Cards stored before 2026-11-07 may still hold `inputs`, which is never served. */
export const storedCardSchema = feedCardSchema.extend({ en: englishCardSchema.optional(), inputs: inputsSchema.optional() }).strict();
export type StoredCard = z.infer<typeof storedCardSchema>;
export function publicCard({ en, inputs: _, ...card }: StoredCard, locale: FeedLocale): FeedCard {
  return locale === "en" && card.language === "original" && en ? { ...card, ...en } : card;
}
export const feedPageSchema = z.object({
  schemaVersion: z.literal(3), release: contentID,
  items: z.array(feedCardSchema).max(feedPageLimit),
  nextCursor: z.string().max(2048).nullable(),
}).strict();
export type FeedPage = z.infer<typeof feedPageSchema>;
export const feedDetailSchema = z.object({
  schemaVersion: z.literal(3), revision: revisionID,
  item: promptSchema, availableLanguages: z.array(z.enum(localizationLanguages)).max(9),
}).strict();

export function parseFeedQuery(url: URL): { filters: FeedFilters; limit: number; cursor?: string } {
  const allowed = new Set(["locale", "presentation", "kind", "collection", "creator", "tag", "model", "facet", "mode", "inputs", "modelFamily", "q", "sort", "seed", "limit", "cursor"]);
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || Object.hasOwn(values, key)) throw new Error("Invalid query parameters");
    values[key] = value;
  }
  // Older apps may still send the retired upload filter; it is accepted and ignored.
  const { limit = "30", cursor, inputs: _, ...raw } = values;
  if (!/^[1-9][0-9]?$/.test(limit) || Number(limit) > feedPageLimit || (cursor !== undefined && (!cursor || cursor.length > 2048)))
    throw new Error("Invalid pagination parameters");
  if (Object.values(raw).some(value => /[\u0000-\u001f\u007f]/u.test(value))) throw new Error("Invalid filter text");
  const filters = feedFiltersSchema.parse(raw);
  filters.q = normalizeFeedSearch(filters.q);
  if ((filters.sort === "recommended") !== (filters.seed !== undefined)) throw new Error("Recommendation session seed is required only for recommendations");
  if (["discovery", "recommended"].includes(filters.sort ?? "") && filters.q) throw new Error("Discovery ordering does not rank searches");
  if (filters.q.length > 120 || filters.q.split(" ").length > 8)
    throw new Error("Invalid filter text");
  return { filters, limit: Number(limit), ...(cursor ? { cursor } : {}) };
}
