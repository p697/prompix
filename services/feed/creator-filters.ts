import { z } from "zod";
import { normalizeFeedSearch } from "../../packages/schema/feed.ts";
import { FeedError } from "./database.ts";
export const creatorFiltersSchema = z.object({
  q: z.string().max(120).default(""),
  kind: z.enum(["image", "video", "web", "text", "skill"]).optional(),
  sort: z.enum(["recommended", "latest", "count", "name"]),
}).strict();
export type CreatorFilters = z.infer<typeof creatorFiltersSchema>;
export function parseCreatorDiscovery(url: URL) {
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (!["q", "kind", "sort", "limit", "cursor"].includes(key) || Object.hasOwn(values, key) || /[\u0000-\u001f\u007f]/u.test(value))
      throw new FeedError("invalid_request", 400);
    values[key] = value;
  }
  const { limit = "30", cursor, ...raw } = values;
  if (!/^[1-9][0-9]?$/.test(limit) || Number(limit) > 50 || (cursor !== undefined && (!cursor || cursor.length > 2048)))
    throw new FeedError("invalid_request", 400);
  const filters = creatorFiltersSchema.parse(raw);
  filters.q = normalizeFeedSearch(filters.q);
  if (filters.q.length > 120 || filters.q.split(" ").length > 8) throw new FeedError("invalid_request", 400);
  return { filters, limit: Number(limit), cursor };
}

