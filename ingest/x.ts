import { download } from "./network.ts";
import { z } from "zod";
import type { Creator } from "./creators.ts";

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
  const result = await download(xUserLookupURL(usernames).toString(), ["api.x.com"], 500_000, { Authorization: `Bearer ${bearer}` });
  const body = JSON.parse(result.bytes.toString());
  if (!body || (!Array.isArray(body.data) && !Array.isArray(body.errors))) throw new Error("X user lookup returned an invalid response; account availability unchanged");
  const creators = parseXUsers(body.data);
  if (Array.isArray(body.data) && creators.length !== body.data.length) throw new Error("X user lookup returned invalid profile data; account availability unchanged");
  return { creators, errors: body.errors ?? [] };
}

export function xSearchURL(since?: string): URL {
  const url = new URL("https://api.x.com/2/tweets/search/recent");
  url.searchParams.set("query", '("prompt" OR "提示词" OR "SKILL.md") ("Seedance" OR "Nano Banana" OR "website" OR "tarot" OR "Claude" OR "GPT") -is:retweet -is:reply');
  url.searchParams.set("max_results", "10");
  url.searchParams.set("tweet.fields", "created_at,author_id,public_metrics,lang,entities,note_tweet,attachments");
  url.searchParams.set("expansions", "author_id,attachments.media_keys");
  url.searchParams.set("user.fields", "id,name,username,profile_image_url,description,url");
  url.searchParams.set("media.fields", "media_key,type,url,preview_image_url,variants");
  if (since && /^\d+$/.test(since)) url.searchParams.set("since_id", since);
  return url;
}
/** X search is discovery only: tweets are not automatically republished as licensed prompts. */
export async function searchX(bearer: string, since?: string) {
  const url = xSearchURL(since);
  const result = await download(url.toString(), ["api.x.com"], 500_000, {
    Authorization: `Bearer ${bearer}`,
  });
  const body = JSON.parse(result.bytes.toString());
  if (body.errors?.length)
    throw new Error("X returned partial errors; cursor unchanged");
  return {
    posts: body.data ?? [],
    creators: parseXUsers(body.includes?.users),
    media: body.includes?.media ?? [],
    newest: body.meta?.newest_id as string | undefined,
  };
}
