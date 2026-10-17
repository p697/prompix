import { createHash } from "node:crypto";
import { readResponseBytes } from "./network.ts";
import { z } from "zod";
import type { Creator } from "./creators.ts";
import { configuredXSpendBudget, type XSpendPurpose } from "./x-spend.ts";

const userSchema = z.object({
  id: z.string().regex(/^\d+$/), name: z.string().trim().min(1).max(200),
  username: z.string().regex(/^[a-z0-9_]{1,15}$/i),
  profile_image_url: z.string().optional(), description: z.string().optional(),
});
export function parseXUsers(users: unknown): Creator[] {
  if (!Array.isArray(users)) return [];
  return users.flatMap(value => {
    const parsed = userSchema.safeParse(value);
    if (!parsed.success) return [];
    const user = parsed.data;
    let avatarURL: string | undefined;
    if (user.profile_image_url) {
      try {
        const url = new URL(user.profile_image_url);
        if (url.protocol === "https:" && url.hostname === "pbs.twimg.com" && !url.username && !url.password) avatarURL = url.toString();
      } catch { /* Missing or invalid photos fall back to initials. */ }
    }
    return [{
      id: `x-${user.username.toLowerCase()}`, platform: "x" as const, externalID: user.id,
      username: user.username, displayName: user.name, profileURL: `https://x.com/${user.username}`,
      ...(avatarURL ? { avatarURL } : {}), ...(user.description?.trim() ? { bio: user.description.trim().slice(0, 1000) } : {}),
    }];
  });
}

export function xUserLookupURL(usernames: readonly string[]): URL {
  if (!usernames.length || usernames.length > 100 || usernames.some(name => !/^[a-z0-9_]{1,15}$/i.test(name))) throw new Error("X lookup requires 1–100 valid usernames");
  const url = new URL("https://api.x.com/2/users/by");
  url.searchParams.set("usernames", [...new Set(usernames.map(name => name.toLowerCase()))].join(","));
  url.searchParams.set("user.fields", "id,name,username,profile_image_url,description,url");
  return url;
}

/** Caller records the paid attempt before this one request; no automatic retry. */
export async function lookupXUsers(bearer: string, usernames: readonly string[]) {
  const body = await requestX(xUserLookupURL(usernames).toString(), bearer, "users") as { data?: unknown[]; errors?: unknown[] };
  if (!body || (!Array.isArray(body.data) && !Array.isArray(body.errors))) throw new Error("X user lookup returned an invalid response; account availability unchanged");
  const creators = parseXUsers(body.data);
  if (Array.isArray(body.data) && creators.length !== body.data.length) throw new Error("X user lookup returned invalid profile data; account availability unchanged");
  return { creators, errors: body.errors ?? [] };
}

// These public handles already occur in the published catalog. This is an
// editorial starting pool, not a claim about their current posting frequency.
export const xSearchAuthors = Object.freeze(["ChangningL29508", "SheBuildsAI_", "xiaoxiaodong", "Elvorya", "ArtistaNozomu"]);
const searchConfiguration = Object.freeze({
  endpoint: "https://api.x.com/2/tweets/search/recent",
  query: `(${xSearchAuthors.map(name => `from:${name}`).join(" OR ")}) (prompt OR 提示词 OR プロンプト) -is:retweet -is:reply -is:quote`,
  maxResults: 10,
  sortOrder: "recency",
  fields: Object.freeze({
    "tweet.fields": "created_at,author_id,public_metrics,lang,entities,note_tweet,attachments",
    expansions: "author_id,attachments.media_keys",
    "user.fields": "id,name,username,profile_image_url,description,url",
    "media.fields": "media_key,type,url,preview_image_url,variants",
  }),
});

// Official documentation checked 2026-10-12 is inconsistent:
// https://docs.x.com/x-api/fundamentals/data-dictionary uses tweet.fields/note_tweet;
// https://docs.x.com/x-api/posts/search-recent-posts uses post.fields/note_post.
// Preserve the existing request convention and accept both documented response
// names. This has not been live-verified with the curated query; never spend a
// second paid request automatically trying another field convention.
// Operators: https://docs.x.com/x-api/posts/search/integrate/operators
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const xSearchFingerprint = digest(JSON.stringify(searchConfiguration));
/** Stable across cursors and credentials; changes whenever query or requested fields change. */
export function xSearchIdentity() { return { ...searchConfiguration, fingerprint: xSearchFingerprint }; }

export function xSearchURL(since?: string): URL {
  if (since !== undefined && !/^\d{1,19}$/.test(since)) throw new Error("Invalid X search cursor");
  const url = new URL(searchConfiguration.endpoint);
  url.searchParams.set("query", searchConfiguration.query);
  url.searchParams.set("max_results", String(searchConfiguration.maxResults));
  url.searchParams.set("sort_order", searchConfiguration.sortOrder);
  for (const [field, value] of Object.entries(searchConfiguration.fields)) url.searchParams.set(field, value);
  if (since !== undefined) url.searchParams.set("since_id", since);
  return url;
}

/** Exact request identity, safe to persist before reserving one paid request. */
export function xSearchRequest(since?: string) {
  const url = xSearchURL(since).toString();
  return { ...xSearchIdentity(), ...(since !== undefined ? { since } : {}), url, requestFingerprint: digest(url) };
}

const lookupFields = Object.freeze({ ...searchConfiguration.fields,
  "tweet.fields": `${searchConfiguration.fields["tweet.fields"]},conversation_id,in_reply_to_user_id,referenced_tweets`,
});
function lookupIDs(ids: readonly string[]): string[] {
  if (!ids.length || ids.length > 10 || ids.some(id => !/^\d{1,19}$/.test(id)) || new Set(ids).size !== ids.length)
    throw new Error("X post lookup requires 1–10 unique numeric post IDs");
  return [...ids];
}
/** Reacquire known posts, without following links or expanding additional posts. */
export function xLookupURL(ids: readonly string[]): URL {
  const url = new URL("https://api.x.com/2/tweets");
  url.searchParams.set("ids", lookupIDs(ids).join(","));
  for (const [field, value] of Object.entries(lookupFields)) url.searchParams.set(field, value);
  return url;
}
export function xLookupRequest(ids: readonly string[]) {
  const url = xLookupURL(ids).toString();
  const identity = { endpoint: "https://api.x.com/2/tweets", ids: lookupIDs(ids), fields: lookupFields };
  return { ...identity, fingerprint: digest(JSON.stringify(identity)), url, requestFingerprint: digest(url) };
}

const searchIDSchema = z.string().regex(/^\d{1,19}$/);
const searchEntitiesSchema = z.object({
  urls: z.array(z.object({
    url: z.string(), expanded_url: z.string().optional(), unwound_url: z.string().optional(),
    start: z.number().int().nonnegative().optional(), end: z.number().int().nonnegative().optional(),
  }).passthrough()).max(100).optional(),
}).passthrough();
const searchNoteSchema = z.object({ text: z.string().min(1).max(50_000), entities: searchEntitiesSchema.optional() }).passthrough();
const searchPostSchema = z.object({
  id: searchIDSchema, text: z.string().max(50_000), author_id: searchIDSchema.optional(),
  entities: searchEntitiesSchema.optional(), note_tweet: searchNoteSchema.optional(), note_post: searchNoteSchema.optional(),
  attachments: z.object({ media_keys: z.array(z.string().min(1)).max(20).optional() }).passthrough().optional(),
}).passthrough();
const searchMediaSchema = z.object({
  media_key: z.string().min(1), type: z.enum(["photo", "video", "animated_gif"]),
  url: z.string().optional(), preview_image_url: z.string().optional(),
  variants: z.array(z.object({ content_type: z.string(), url: z.string(), bit_rate: z.number().optional() }).passthrough()).max(30).optional(),
}).passthrough();
const searchResponseSchema = z.object({
  data: z.array(searchPostSchema).max(100).optional(),
  errors: z.array(z.unknown()).optional(),
  includes: z.object({
    users: z.array(userSchema).max(100).optional(), media: z.array(searchMediaSchema).max(400).optional(),
  }).passthrough().optional(),
  meta: z.object({
    result_count: z.number().int().min(0).max(100),
    newest_id: searchIDSchema.optional(), oldest_id: searchIDSchema.optional(), next_token: z.string().min(1).optional(),
  }).passthrough(),
}).passthrough();

/** Counts observed fields only; absence of a note does not prove text is complete. */
function searchCoverage(body: z.infer<typeof searchResponseSchema>) {
  const posts = body.data ?? [], users = body.includes?.users ?? [], media = body.includes?.media ?? [];
  const authorIDs = new Set(posts.flatMap(post => post.author_id ? [post.author_id] : []));
  const profileIDs = new Set(users.map(user => user.id));
  const mediaKeys = new Set(posts.flatMap(post => post.attachments?.media_keys ?? []));
  const expandedKeys = new Set(media.map(item => item.media_key));
  return {
    posts: posts.length,
    longTextPosts: posts.filter(post => post.note_post || post.note_tweet).length,
    noteTweetPosts: posts.filter(post => post.note_tweet).length,
    notePostPosts: posts.filter(post => post.note_post).length,
    entityPosts: posts.filter(post => post.entities).length,
    longTextEntityPosts: posts.filter(post => post.note_post?.entities || post.note_tweet?.entities).length,
    selectedTextEntityPosts: posts.filter(post => (post.note_post ?? post.note_tweet ?? post).entities).length,
    urlEntityPosts: posts.filter(post => [post.entities, post.note_tweet?.entities, post.note_post?.entities].some(entities => entities?.urls?.length)).length,
    attachmentPosts: posts.filter(post => post.attachments).length,
    mediaKeyPosts: posts.filter(post => post.attachments?.media_keys?.length).length,
    referencedMediaKeys: mediaKeys.size,
    expandedMediaKeys: [...mediaKeys].filter(key => expandedKeys.has(key)).length,
    mediaObjects: media.length,
    authorIDPosts: posts.filter(post => post.author_id).length,
    uniqueAuthorIDs: authorIDs.size,
    authorProfiles: users.length,
    matchedAuthorPosts: posts.filter(post => post.author_id && profileIDs.has(post.author_id)).length,
    missingAuthorProfiles: [...authorIDs].filter(id => !profileIDs.has(id)).length,
    // Never follow this token: the caller's budget remains one request / ten posts.
    hasNextPage: !!body.meta.next_token,
  };
}

/** Pure parser so response validation and coverage can be tested without paid calls. */
export function parseXSearchResponse(value: unknown, since?: string, limit = 10) {
  if (!Number.isInteger(limit) || limit < 10 || limit > 100) throw new Error("Invalid X page size");
  if (since !== undefined && !searchIDSchema.safeParse(since).success) throw new Error("Invalid X search cursor");
  const parsed = searchResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data.meta.result_count > limit) throw new Error("X search returned an invalid response; cursor unchanged");
  const body = parsed.data, posts = body.data ?? [];
  if (body.errors?.length) throw new Error("X returned partial errors; cursor unchanged");
  if (posts.length !== body.meta.result_count || new Set(posts.map(post => post.id)).size !== posts.length)
    throw new Error("X search returned inconsistent post counts; cursor unchanged");
  const users = body.includes?.users ?? [], media = body.includes?.media ?? [];
  if (new Set(users.map(user => user.id)).size !== users.length || new Set(media.map(item => item.media_key)).size !== media.length)
    throw new Error("X search returned duplicate expansions; cursor unchanged");
  if (posts.length) {
    const ids = posts.map(post => BigInt(post.id));
    const newest = ids.reduce((largest, id) => id > largest ? id : largest);
    if (!body.meta.newest_id || BigInt(body.meta.newest_id) !== newest ||
      (body.meta.oldest_id !== undefined && BigInt(body.meta.oldest_id) !== ids.reduce((smallest, id) => id < smallest ? id : smallest)) ||
      (since !== undefined && ids.some(id => id <= BigInt(since))))
      throw new Error("X search returned an inconsistent cursor; cursor unchanged");
  } else if (body.meta.newest_id !== undefined || body.meta.oldest_id !== undefined || body.meta.next_token !== undefined) {
    throw new Error("X search returned an inconsistent empty page; cursor unchanged");
  }
  return { posts, creators: parseXUsers(users), media, newest: body.meta.newest_id, ...(body.meta.next_token ? { nextToken: body.meta.next_token } : {}), coverage: searchCoverage(body) };
}

const lookupResponseSchema = z.object({
  data: z.array(searchPostSchema.extend({ author_id: searchIDSchema })).max(10),
  errors: z.array(z.unknown()).optional(), includes: searchResponseSchema.shape.includes,
}).passthrough();

/** A missing/deleted/withheld post is an incomplete lookup, not a replacement snapshot. */
export function parseXLookupResponse(value: unknown, ids: readonly string[]) {
  const requested = lookupIDs(ids);
  const parsed = lookupResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("X lookup returned an invalid response; cached posts unchanged");
  const body = parsed.data, posts = body.data;
  if (body.errors?.length) throw new Error("X lookup returned partial errors; cached posts unchanged");
  if (posts.length !== requested.length || new Set(posts.map(post => post.id)).size !== posts.length ||
    posts.some(post => !requested.includes(post.id)))
    throw new Error("X lookup returned inconsistent post IDs; cached posts unchanged");
  const users = body.includes?.users ?? [], media = body.includes?.media ?? [];
  if (new Set(users.map(user => user.id)).size !== users.length || new Set(media.map(item => item.media_key)).size !== media.length)
    throw new Error("X lookup returned duplicate expansions; cached posts unchanged");
  return { posts, creators: parseXUsers(users), media,
    coverage: searchCoverage({ ...body, meta: { result_count: posts.length } }) };
}

/** A retryable read still consumes its reserved request and post budget. */
export class TransientXReadError extends Error {
  constructor(message: string, public readonly retryAfterMS = 1000) { super(message); }
}
/** One bounded request. Retry policy belongs to the persistent, budgeted caller. */
async function requestX(url: string, bearer: string, operation: "search" | "lookup" | "users", maxBytes = 500_000, purpose: XSpendPurpose = "growth") {
  const budget = configuredXSpendBudget();
  if (!budget) return requestXResponse(url, bearer, operation, maxBytes);
  const query = new URL(url).searchParams;
  const units = operation === "search" ? Number(query.get("max_results"))
    : (query.get(operation === "users" ? "usernames" : "ids") ?? "").split(",").filter(Boolean).length;
  if (!Number.isInteger(units) || units < 1 || units > 100) throw new Error("Invalid official X result bound");
  const reservation = await budget.reserve("official", operation, url, units, purpose);
  try {
    const raw = await requestXResponse(url, bearer, operation, maxBytes);
    const body = z.object({ data: z.array(z.unknown()).max(units).optional(), errors: z.array(z.unknown()).optional(),
      meta: z.object({ result_count: z.number().int().nonnegative().optional() }).passthrough().optional() }).passthrough().parse(raw);
    // Missing counts retain their upper bound. Return the response so the existing
    // availability parser can still recognize explicit deletion/protection errors.
    await reservation.finish(body.data?.length ?? (body.meta?.result_count === 0 ? 0 : undefined));
    return raw;
  } catch (error) {
    try { await reservation.finish(); } catch { /* Retain the persisted reservation on uncertain outcomes. */ }
    throw error;
  }
}
async function requestXResponse(url: string, bearer: string, operation: "search" | "lookup" | "users", maxBytes: number) {
  const unchanged = operation === "search" ? "cursor unchanged" : "cached posts unchanged";
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${bearer}` }, redirect: "manual", signal: AbortSignal.timeout(60_000),
    });
  } catch { throw new TransientXReadError(`X ${operation} request failed; ${unchanged}`); }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* Discard error bodies and transport diagnostics. */ }
    const message = `X ${operation} returned HTTP ${response.status}; ${unchanged}`;
    if (response.status === 429 || response.status >= 500) {
      const retry = response.headers.get("retry-after");
      const delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 1000;
      throw new TransientXReadError(message, Number.isFinite(delay) ? Math.max(1000, Math.min(delay, 24 * 3600000)) : 1000);
    }
    throw new Error(message);
  }
  let bytes: Buffer;
  try { bytes = await readResponseBytes(response, maxBytes); }
  catch { throw new Error(`X ${operation} response exceeded its limit or was interrupted; ${unchanged}`); }
  let body: unknown;
  try { body = JSON.parse(bytes.toString()); }
  catch { throw new Error(`X ${operation} returned invalid JSON; ${unchanged}`); }
  return body;
}

/** Discovery only. One bounded request, no retries, redirects or implicit pagination. */
export async function searchX(bearer: string, since?: string) {
  const request = xSearchRequest(since);
  const body = await requestX(request.url, bearer, "search");
  return { ...parseXSearchResponse(body, since), request };
}

/** Rich lookup uses the same documented field convention as discovery. */
export async function lookupX(bearer: string, ids: readonly string[]) {
  const request = xLookupRequest(ids);
  const body = await requestX(request.url, bearer, "lookup");
  return { ...parseXLookupResponse(body, ids), request };
}


/** Direct multi-topic discovery uses the same validated API contract. */
export function xFeedRequest(query: string, options: { since?: string; nextToken?: string; limit: number; conversation?: boolean }) {
  if (!query.trim() || query.length > 512 || !Number.isInteger(options.limit) || options.limit < 10 || options.limit > 100)
    throw new Error("Invalid X feed request");
  if (options.since && !searchIDSchema.safeParse(options.since).success) throw new Error("Invalid X feed cursor");
  if (options.nextToken !== undefined && (!options.nextToken.length || options.nextToken.length > 2000)) throw new Error("Invalid X page token");
  const url = xSearchURL(options.since);
  url.searchParams.set("query", query);
  url.searchParams.set("max_results", String(options.limit));
  if (options.nextToken) url.searchParams.set("next_token", options.nextToken);
  const fields = options.conversation ? { ...lookupFields, "tweet.fields": `${lookupFields["tweet.fields"]},withheld` } : searchConfiguration.fields;
  for (const [field, value] of Object.entries(fields)) url.searchParams.set(field, value);
  // Pagination and page size do not change the identity of the searched stream.
  const fingerprint = digest(JSON.stringify([searchConfiguration.endpoint, query, fields]));
  return { fingerprint, query, ...options, url: url.toString(), requestFingerprint: digest(url.toString()) };
}
export async function searchXFeed(bearer: string, request: ReturnType<typeof xFeedRequest>) {
  const body = await requestX(request.url, bearer, "search", 8_000_000);
  return { ...parseXSearchResponse(body, request.since, request.limit), request };
}

const availabilityResponseSchema = lookupResponseSchema.extend({
  data: z.array(searchPostSchema.extend({ author_id: searchIDSchema, created_at: z.iso.datetime() })).max(100).optional(),
  errors: z.array(z.object({ resource_id: searchIDSchema, type: z.string() }).passthrough()).max(100).optional(),
});
function availabilityIDs(ids: readonly string[]) {
  if (!ids.length || ids.length > 100 || ids.some(id => !searchIDSchema.safeParse(id).success) || new Set(ids).size !== ids.length)
    throw new Error("X availability requires 1–100 unique post IDs");
  return [...ids];
}
/** Partial responses are useful only when every requested identity is accounted for. */
export function parseXAvailability(value: unknown, ids: readonly string[]) {
  const requested = availabilityIDs(ids), body = availabilityResponseSchema.parse(value);
  const posts = body.data ?? [], errors = body.errors ?? [];
  const observed = [...posts.map(post => post.id), ...errors.map(error => error.resource_id)];
  if (observed.length !== requested.length || new Set(observed).size !== observed.length || observed.some(id => !requested.includes(id)))
    throw new Error("X availability returned inconsistent identities");
  // Rate limits, authentication failures and unknown errors never prove deletion.
  if (errors.some(error => !["https://api.twitter.com/2/problems/resource-not-found", "https://api.x.com/2/problems/resource-not-found",
    "https://api.twitter.com/2/problems/not-authorized-for-resource", "https://api.x.com/2/problems/not-authorized-for-resource"].includes(error.type)))
    throw new Error("X availability returned an unresolved error");
  const users = body.includes?.users ?? [], media = body.includes?.media ?? [];
  if (new Set(users.map(user => user.id)).size !== users.length || new Set(media.map(item => item.media_key)).size !== media.length)
    throw new Error("X availability returned duplicate expansions");
  return { posts: posts.filter(post => post.withheld === undefined),
    unavailable: [...errors.map(error => error.resource_id), ...posts.filter(post => post.withheld !== undefined).map(post => post.id)],
    creators: parseXUsers(users), media };
}
export async function checkXAvailability(bearer: string, ids: readonly string[], purpose: XSpendPurpose = "growth") {
  const url = new URL("https://api.x.com/2/tweets");
  url.searchParams.set("ids", availabilityIDs(ids).join(","));
  for (const [field, value] of Object.entries(lookupFields)) url.searchParams.set(field, value);
  url.searchParams.set("tweet.fields", `${lookupFields["tweet.fields"]},withheld`);
  return parseXAvailability(await requestX(url.toString(), bearer, "lookup", 8_000_000, purpose), ids);
}
