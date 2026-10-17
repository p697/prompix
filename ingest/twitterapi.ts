import { z } from "zod";
import { readResponseBytes } from "./network.ts";
import { parseXUsers, TransientXReadError } from "./x.ts";
import { xMediaSchema, xPostSchema, type XMedia, type XPost } from "./x-intake.ts";
import { XSpendBudget } from "./x-spend.ts";

const id = z.string().regex(/^\d{1,19}$/);
const optionalReplyID = z.union([id, z.literal("")]).nullish();
const entities = z.object({ urls: z.array(z.object({ url: z.string(), expanded_url: z.string().optional(),
  unwound_url: z.string().optional(), media_key: z.string().optional(), indices: z.array(z.number().int()).optional() }).passthrough()).max(100).optional() }).passthrough();
const rawMedia = z.object({ id_str: id.optional(), media_key: z.string().optional(), type: z.enum(["photo", "video", "animated_gif"]),
  url: z.string().optional(), expanded_url: z.string().optional(),
  media_url_https: z.string(), video_info: z.object({ variants: z.array(z.object({ content_type: z.string(), url: z.string(),
    bitrate: z.number().optional() })).max(30) }).optional() }).passthrough();
const rawTweet = z.object({
  id, text: z.string().min(1).max(50_000), createdAt: z.string(), lang: z.string().optional(),
  isReply: z.boolean(), isQuote: z.boolean().optional(), isRetweet: z.boolean().optional(), inReplyToId: optionalReplyID, inReplyToUserId: optionalReplyID, conversationId: id.optional(),
  author: z.object({ id, userName: z.string(), name: z.string(), profilePicture: z.string().optional(),
    description: z.string().optional(), unavailable: z.boolean().optional(), isProtected: z.boolean().optional(),
    withheldInCountries: z.array(z.string()).optional() }).passthrough(),
  entities: entities.optional(), extendedEntities: z.object({ media: z.array(rawMedia).max(20).optional() }).passthrough().optional(),
  quoted_tweet: z.unknown().optional(), retweeted_tweet: z.unknown().optional(),
  note_tweet: z.object({ text: z.string().min(1).max(50_000), entities: entities.optional() }).passthrough().nullish(),
  truncated: z.boolean().optional(), possiblySensitive: z.boolean().optional(),
  withheldInCountries: z.array(z.string()).optional(),
}).passthrough();
export type TwitterAPIResult = { posts: XPost[]; creators: ReturnType<typeof parseXUsers>; media: XMedia[];
  nextToken?: string; unknownIDs: string[]; provider: "twitterapi" };
type CaptureResponse = (raw: unknown) => Promise<void>;

/** X's alternate video CDN and non-content tag parameter do not change the MP4 identity. */
export function canonicalTwitterVideoURL(input: string) {
  const url = new URL(input);
  if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
      ["video.twimg.com", "video-s.twimg.com"].includes(url.hostname) && url.pathname.endsWith(".mp4")) {
    url.hostname = "video.twimg.com";
    url.searchParams.delete("tag");
  }
  return url.toString();
}

/** Normalize source fields only. Missing identities never become deletion evidence. */
export function parseTwitterAPI(value: unknown, options: { ids?: readonly string[]; search?: boolean } = {}): TwitterAPIResult {
  const body = z.object({ tweets: z.array(z.unknown()).max(options.search ? 20 : 50), status: z.string().optional(),
    code: z.number().optional(), has_next_page: z.boolean().optional(), next_cursor: z.string().max(2000).nullish(),
    error: z.unknown().optional() }).passthrough().parse(value);
  if (body.error !== undefined || (body.status !== undefined && body.status !== "success") || (body.code !== undefined && body.code !== 0))
    throw new Error("TwitterAPI returned an application error");
  if (options.search && (body.has_next_page === undefined || (body.has_next_page && !body.next_cursor)))
    throw new Error("TwitterAPI returned ambiguous pagination");
  const posts: XPost[] = [], media: XMedia[] = [], creators = new Map<string, ReturnType<typeof parseXUsers>[number]>();
  const seen = new Set<string>();
  for (const raw of body.tweets) {
    // Documented unavailable placeholder. No ID means it cannot prove which requested post disappeared.
    if (!options.search && raw && typeof raw === "object" && "id" in raw && raw.id === "") continue;
    const tweet = rawTweet.parse(raw);
    if (seen.has(tweet.id) || (options.ids && !options.ids.includes(tweet.id))) throw new Error("TwitterAPI returned inconsistent identities");
    seen.add(tweet.id);
    if (tweet.author.unavailable || tweet.author.isProtected || tweet.author.withheldInCountries?.length || tweet.withheldInCountries?.length) continue;
    const created = new Date(tweet.createdAt);
    if (!Number.isFinite(created.getTime())) throw new Error("TwitterAPI returned an invalid source date");
    const profiles = parseXUsers([{ id: tweet.author.id, username: tweet.author.userName, name: tweet.author.name,
      profile_image_url: tweet.author.profilePicture, description: tweet.author.description }]);
    if (profiles.length !== 1) throw new Error("TwitterAPI returned invalid attribution");
    creators.set(tweet.author.id, profiles[0]);
    const references: NonNullable<XPost["referenced_tweets"]> = [];
    if (tweet.isReply) {
      if (!tweet.inReplyToId || !tweet.inReplyToUserId || !tweet.conversationId) throw new Error("TwitterAPI returned an incomplete reply relationship");
      references.push({ type: "replied_to", id: tweet.inReplyToId });
    }
    for (const [field, type] of [["quoted_tweet", "quoted"], ["retweeted_tweet", "retweeted"]] as const) {
      if ((type === "quoted" ? tweet.isQuote : tweet.isRetweet) && tweet[field] == null)
        throw new Error("TwitterAPI returned an incomplete reference");
      if (tweet[field] != null) references.push({ type, id: z.object({ id }).parse(tweet[field]).id });
    }
    const attachments: string[] = [];
    for (const source of tweet.extendedEntities?.media ?? []) {
      const key = source.media_key ?? source.id_str;
      if (!key) throw new Error("TwitterAPI returned media without an identity");
      if (attachments.includes(key)) throw new Error("TwitterAPI returned duplicate attachments");
      attachments.push(key);
      const item = xMediaSchema.parse({ media_key: key, type: source.type,
        ...(source.type === "photo" ? { url: source.media_url_https } : { preview_image_url: source.media_url_https,
          variants: source.video_info?.variants.map(v => ({ content_type: v.content_type, url: canonicalTwitterVideoURL(v.url), bit_rate: v.bitrate })) }) });
      const existing = media.find(m => m.media_key === key);
      if (existing && JSON.stringify(existing) !== JSON.stringify(item)) throw new Error("TwitterAPI returned conflicting media");
      if (!existing) media.push(item);
    }
    const normalizedEntities = (original?: z.infer<typeof entities>) => {
      const urls = [...(original?.urls ?? [])];
      for (const source of tweet.extendedEntities?.media ?? []) {
        if (!source.url || !source.expanded_url) continue;
        const linked = { url: source.url, expanded_url: source.expanded_url, media_key: source.media_key ?? source.id_str! };
        const index = urls.findIndex(value => value.url === linked.url && value.expanded_url === linked.expanded_url);
        if (index >= 0) urls[index] = { ...urls[index], media_key: linked.media_key };
        else urls.push(linked);
      }
      return original || urls.length ? { ...original, urls } : undefined;
    };
    posts.push(xPostSchema.parse({ id: tweet.id, author_id: tweet.author.id, text: tweet.text,
      created_at: created.toISOString(), truncated: tweet.truncated, entities: normalizedEntities(tweet.entities),
      ...(tweet.note_tweet ? { note_tweet: { ...tweet.note_tweet, entities: normalizedEntities(tweet.note_tweet.entities) } } : {}),
      ...(tweet.conversationId ? { conversation_id: tweet.conversationId } : {}),
      ...(tweet.isReply ? { in_reply_to_user_id: tweet.inReplyToUserId } : {}),
      ...(references.length ? { referenced_tweets: references } : {}),
      ...(attachments.length ? { attachments: { media_keys: attachments } } : {}) }));
  }
  return { posts, creators: [...creators.values()], media, provider: "twitterapi",
    unknownIDs: options.ids?.filter(id => !posts.some(post => post.id === id)) ?? [],
    ...(body.has_next_page ? { nextToken: body.next_cursor! } : {}) };
}

/** Translate the operators used by our existing discovery streams, preserving query breadth. */
export function twitterAPIQuery(query: string) {
  return query.replaceAll("has:images", "filter:images").replaceAll("has:videos", "filter:videos")
    .replaceAll("-is:retweet", "-filter:retweets").replaceAll("-is:reply", "-filter:replies").replaceAll("-is:quote", "-filter:quote")
    .replace(/\b(since|until):(\d{4}-\d{2}-\d{2})(?=\s|$)/g, (_match, operator: string, day: string) => {
      const date = new Date(`${day}T00:00:00Z`);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) throw new Error("Invalid TwitterAPI date boundary");
      return `${operator}_time:${date.getTime() / 1000}`;
    });
}
export class TwitterAPIClient {
  constructor(private readonly key: string, private readonly budget: XSpendBudget,
    private readonly fetcher: typeof fetch = fetch) {
    if (!key.trim() || /\s/.test(key)) throw new Error("Missing or invalid TwitterAPI key");
  }
  private async read(url: URL, operation: "search" | "lookup", units: number, capture?: CaptureResponse) {
    const reservation = await this.budget.reserve("twitterapi", operation, url.toString(), units);
    try {
      let response: Response;
      try { response = await this.fetcher(url, { headers: { "X-API-Key": this.key }, redirect: "manual", signal: AbortSignal.timeout(60_000) }); }
      catch { throw new TransientXReadError("TwitterAPI transport failed; request remains accounted"); }
      if (!response.ok) {
        if (capture) {
          const bytes = await readResponseBytes(response, 64_000);
          await capture({ httpError: { status: response.status, retryAfter: response.headers.get("retry-after"), body: bytes.toString() } });
        } else await response.body?.cancel();
        if (response.status === 429 || response.status >= 500) {
          const retry = response.headers.get("retry-after");
          const wait = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 6500;
          throw new TransientXReadError(`TwitterAPI HTTP ${response.status}`,
            Number.isFinite(wait) ? Math.max(1000, Math.min(wait, 24 * 3600_000)) : 6500);
        }
        throw new Error(`TwitterAPI HTTP ${response.status}`);
      }
      let raw: unknown;
      try { raw = JSON.parse((await readResponseBytes(response, 8_000_000)).toString()); }
      catch { throw new Error("TwitterAPI returned invalid or oversized JSON"); }
      // Keep evidence outside the repository before validating an unfamiliar provider shape.
      // A parser repair can then replay the saved response without another paid request.
      await capture?.(raw);
      const count = z.object({ tweets: z.array(z.unknown()).max(units) }).parse(raw).tweets.length;
      // Billable results are counted before validation/filtering, including malformed source objects.
      await reservation.finish(count);
      return raw;
    } catch (error) {
      try { await reservation.finish(); } catch { /* Preserve the durable upper bound if settlement already succeeded or failed. */ }
      if (error instanceof TransientXReadError) throw error;
      throw new Error(error instanceof Error && !error.message.includes(this.key) && !error.name.includes("Zod")
        ? error.message : "TwitterAPI response validation failed");
    }
  }
  async search(query: string, cursor?: string, capture?: CaptureResponse) {
    if (!query.trim() || query.length > 1500 || (cursor !== undefined && (!cursor.length || cursor.length > 2000))) throw new Error("Invalid TwitterAPI search");
    const url = new URL("https://api.twitterapi.io/twitter/tweet/advanced_search");
    url.searchParams.set("query", twitterAPIQuery(query)); url.searchParams.set("queryType", "Latest");
    if (cursor) url.searchParams.set("cursor", cursor);
    const raw = await this.read(url, "search", 20, capture);
    const result = parseTwitterAPI(raw, { search: true });
    if (result.nextToken && result.nextToken === cursor) throw new Error("TwitterAPI pagination did not advance");
    return { raw, result };
  }
  async lookup(ids: readonly string[], capture?: CaptureResponse) {
    if (!ids.length || ids.length > 50 || new Set(ids).size !== ids.length || ids.some(value => !id.safeParse(value).success))
      throw new Error("TwitterAPI lookup requires 1–50 unique numeric IDs");
    const url = new URL("https://api.twitterapi.io/twitter/tweets"); url.searchParams.set("tweet_ids", ids.join(","));
    const raw = await this.read(url, "lookup", ids.length, capture);
    return { raw, result: parseTwitterAPI(raw, { ids }) };
  }
}
