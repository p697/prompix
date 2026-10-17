import { z } from "zod";
import { inspectRapidAPILookup } from "./rapidapi-pilot.ts";
import { parseTwitterAPI, type TwitterAPIResult } from "./twitterapi.ts";

const id = z.string().regex(/^\d{1,19}$/);
const object = z.record(z.string(), z.unknown());
const legacySchema = z.object({ id_str: id, user_id_str: id, full_text: z.string(), created_at: z.string(),
  conversation_id_str: id, in_reply_to_status_id_str: id.nullish(), in_reply_to_user_id_str: id.nullish(),
  quoted_status_id_str: id.optional(), is_quote_status: z.boolean(), truncated: z.boolean().optional(),
  possibly_sensitive: z.boolean().optional(), withheld_in_countries: z.array(z.string()).optional(),
  entities: object, extended_entities: z.object({ media: z.array(object).max(20) }).optional(),
}).passthrough();
const userSchema = z.object({ __typename: z.literal("User"), rest_id: id,
  core: z.object({ screen_name: z.string(), name: z.string() }),
  privacy: z.object({ protected: z.boolean() }),
  avatar: z.object({ image_url: z.string() }).optional(),
  legacy: z.object({ description: z.string().optional(), withheld_in_countries: z.array(z.string()).optional() }).passthrough(),
}).passthrough();

export type RapidAPISources = Omit<TwitterAPIResult, "provider" | "nextToken"> & { provider: "rapidapi" };

/** Offline normalization of captured pilot responses. Never updates availability,
 * approves content, or routes production traffic. Unknown/protected sources stay
 * unresolved. The existing source validator handles media, links and references.
 */
export function parseRapidAPISources(raw: unknown, ids: readonly string[]): RapidAPISources {
  inspectRapidAPILookup(raw, ids);
  const rows = z.object({ result: z.object({ tweetResult: z.array(z.object({ result: object })) }) }).parse(raw).result.tweetResult;
  const mapped: unknown[] = [], profiles = new Map<string, string>();
  for (const row of rows) {
    const wrapper = row.result;
    if (["TweetTombstone", "TweetUnavailable"].includes(String(wrapper.__typename))) continue;
    const tweet = object.parse(wrapper.__typename === "TweetWithVisibilityResults" ? wrapper.tweet : wrapper);
    const legacy = legacySchema.parse(tweet.legacy);
    if (tweet.rest_id !== legacy.id_str) throw new Error("RapidAPI source identity conflict");
    const account = z.object({ user_results: z.object({ result: object }) }).parse(tweet.core).user_results.result;
    if (["UserUnavailable", "UserTombstone"].includes(String(account.__typename))) continue;
    const user = userSchema.parse(account);
    if (user.rest_id !== legacy.user_id_str) throw new Error("RapidAPI source author conflict");
    const profile = JSON.stringify([user.core.screen_name, user.core.name, user.avatar?.image_url, user.legacy.description,
      user.privacy.protected, user.legacy.withheld_in_countries]);
    if (profiles.has(user.rest_id) && profiles.get(user.rest_id) !== profile) throw new Error("RapidAPI conflicting attribution");
    profiles.set(user.rest_id, profile);
    if (user.privacy.protected || user.legacy.withheld_in_countries?.length || legacy.withheld_in_countries?.length) continue;
    if (legacy.entities.media !== undefined) {
      const advertised = z.array(z.object({ id_str: id })).max(20).parse(legacy.entities.media);
      if (advertised.some(m => !legacy.extended_entities?.media.some(full => full.id_str === m.id_str)))
        throw new Error("RapidAPI incomplete media expansion");
    }
    // Unavailable media cannot be mistaken for an unchanged gallery.
    if (legacy.extended_entities?.media.some(m => m.ext_media_availability !== undefined &&
      z.object({ status: z.string() }).parse(m.ext_media_availability).status !== "Available")) continue;
    const note = tweet.note_tweet === undefined ? undefined : z.object({ note_tweet_results: z.object({
      result: z.object({ text: z.string().min(1).max(50_000), entity_set: object }),
    }) }).parse(tweet.note_tweet).note_tweet_results.result;
    const retweet = tweet.retweeted_status_result === undefined ? undefined
      : z.object({ result: z.object({ rest_id: id }) }).parse(tweet.retweeted_status_result).result;
    mapped.push({ id: legacy.id_str, text: legacy.full_text, createdAt: legacy.created_at,
      isReply: !!legacy.in_reply_to_status_id_str, inReplyToId: legacy.in_reply_to_status_id_str,
      inReplyToUserId: legacy.in_reply_to_user_id_str, conversationId: legacy.conversation_id_str,
      isQuote: legacy.is_quote_status, ...(legacy.quoted_status_id_str ? { quoted_tweet: { id: legacy.quoted_status_id_str } } : {}),
      isRetweet: !!retweet, ...(retweet ? { retweeted_tweet: { id: retweet.rest_id } } : {}),
      author: { id: user.rest_id, userName: user.core.screen_name, name: user.core.name,
        profilePicture: user.avatar?.image_url, description: user.legacy.description, isProtected: user.privacy.protected },
      entities: legacy.entities, extendedEntities: legacy.extended_entities,
      ...(note ? { note_tweet: { text: note.text, entities: note.entity_set } } : {}),
      truncated: legacy.truncated, possiblySensitive: legacy.possibly_sensitive,
    });
  }
  const posts: RapidAPISources["posts"] = [], creators = new Map<string, RapidAPISources["creators"][number]>(),
    media = new Map<string, RapidAPISources["media"][number]>();
  for (let offset = 0; offset < mapped.length; offset += 50) {
    const parsed = parseTwitterAPI({ tweets: mapped.slice(offset, offset + 50) }, { ids });
    posts.push(...parsed.posts);
    for (const creator of parsed.creators) {
      const previous = creators.get(creator.externalID!);
      if (previous && JSON.stringify(previous) !== JSON.stringify(creator)) throw new Error("RapidAPI conflicting attribution");
      creators.set(creator.externalID!, creator);
    }
    for (const item of parsed.media) {
      const previous = media.get(item.media_key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw new Error("RapidAPI conflicting media");
      media.set(item.media_key, item);
    }
  }
  return { provider: "rapidapi", posts, creators: [...creators.values()], media: [...media.values()],
    unknownIDs: ids.filter(id => !posts.some(post => post.id === id)) };
}
