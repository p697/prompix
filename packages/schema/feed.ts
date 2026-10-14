import { z } from "zod";
import { creatorSchema, localizationLanguages, promptSchema } from "./catalog.ts";

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
export const feedFiltersSchema = z.object({
  locale: feedLocale.default("original"),
  kind: z.enum(["text", "image", "video", "web", "skill"]).optional(),
  creator: z.string().min(1).max(200).optional(),
  tag: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(200).optional(),
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
  artwork: contentID, previewLabel: z.string().max(500),
  creator: creatorSchema.optional(), media: promptSchema.shape.media,
  cover: promptSchema.shape.cover,
  language: feedLocale,
  availableLanguages: z.array(z.enum(localizationLanguages)).max(9),
}).strict();
export type FeedCard = z.infer<typeof feedCardSchema>;
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
  const allowed = new Set(["locale", "kind", "creator", "tag", "model", "q", "limit", "cursor"]);
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || Object.hasOwn(values, key)) throw new Error("Invalid query parameters");
    values[key] = value;
  }
  const { limit = "30", cursor, ...raw } = values;
  if (!/^[1-9][0-9]?$/.test(limit) || Number(limit) > feedPageLimit || (cursor !== undefined && (!cursor || cursor.length > 2048)))
    throw new Error("Invalid pagination parameters");
  if (Object.values(raw).some(value => /[\u0000-\u001f\u007f]/u.test(value))) throw new Error("Invalid filter text");
  const filters = feedFiltersSchema.parse(raw);
  filters.q = normalizeFeedSearch(filters.q);
  if (filters.q.length > 120 || filters.q.split(" ").length > 8)
    throw new Error("Invalid filter text");
  return { filters, limit: Number(limit), ...(cursor ? { cursor } : {}) };
}
