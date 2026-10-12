import type { Prompt } from "../packages/schema/catalog.ts";

export type Creator = NonNullable<Prompt["creator"]>;
export type CreatorCache = Record<string, Creator>;
const xHosts = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
const reservedX = new Set(["home", "i", "intent", "search", "explore", "settings", "messages", "notifications", "share"]);

/** Identity comes from a source profile URL, never a display name guess. */
export function creatorFromURL(value: string | null | undefined, displayName?: string): Creator | undefined {
  if (!value) return;
  let url: URL;
  try { url = new URL(value); } catch { return; }
  if (url.protocol !== "https:" || url.username || url.password) return;
  const username = url.pathname.split("/").filter(Boolean)[0];
  if (!username) return;
  if (xHosts.has(url.hostname) && /^[a-z0-9_]{1,15}$/i.test(username) && !reservedX.has(username.toLowerCase())) {
    return { id: `x-${username.toLowerCase()}`, platform: "x", username, displayName: displayName?.trim() || username, profileURL: `https://x.com/${username}` };
  }
  if (url.hostname === "github.com" && /^[a-z0-9](?:[a-z0-9-]{0,38})$/i.test(username)) {
    return {
      id: `github-${username.toLowerCase()}`, platform: "github", username,
      displayName: displayName?.trim() || username, profileURL: `https://github.com/${username}`,
      avatarURL: `https://github.com/${username}.png?size=160`,
    };
  }
}

export function inferCreator(source: Prompt["source"]): Creator | undefined {
  const url = source.url;
  if (url && xHosts.has(new URL(url).hostname)) return creatorFromURL(url, source.author);
  if (source.name === "prompts.chat" && source.author && /^[a-z0-9](?:[a-z0-9-]{0,38})$/i.test(source.author)) {
    // Its public CSV exporter uses GitHub OAuth/imported usernames, emails
    // otherwise; the scalar username test excludes emails and joint credits.
    return creatorFromURL(`https://github.com/${source.author}`, source.author);
  }
  return undefined;
}

/** Keep aliases for renamed handles, but their published identity is the real numeric account ID. */
export function mergeCreatorCache(previous: CreatorCache, updates: readonly Creator[]): CreatorCache {
  const cache = { ...previous };
  for (const update of updates) {
    const identity = update.platform === "x" && update.externalID ? `x-id-${update.externalID}` : update.id;
    const canonical = { ...update, id: identity };
    for (const [alias, existing] of Object.entries(cache)) {
      if (existing.platform === update.platform && update.externalID && existing.externalID === update.externalID) cache[alias] = canonical;
    }
    cache[update.id] = canonical;
    cache[identity] = canonical;
    if (update.username) cache[`${update.platform}-${update.username.toLowerCase()}`] = canonical;
  }
  return cache;
}

function platformIdentity(creator: Creator): string | undefined {
  if (creator.externalID) return creator.externalID;
  const prefix = `${creator.platform}-id-`;
  const suffix = creator.id.startsWith(prefix) ? creator.id.slice(prefix.length) : "";
  return /^\d+$/.test(suffix) ? suffix : undefined;
}

export function enrichCreators<T extends Prompt>(items: readonly T[], cache: CreatorCache): T[] {
  return items.map(item => {
    const inferred = item.creator ?? inferCreator(item.source);
    if (!inferred) return item;
    const identity = platformIdentity(inferred);
    const cached = [cache[inferred.id], identity ? cache[`${inferred.platform}-id-${identity}`] : undefined,
      inferred.username ? cache[`${inferred.platform}-${inferred.username.toLowerCase()}`] : undefined]
      .find(candidate => candidate && candidate.platform === inferred.platform &&
        // A restored cache may know only the handle's new owner. Once a post
        // has a verified account ID, a handle match cannot replace its author.
        (!identity || platformIdentity(candidate) === identity));
    return { ...item, creator: cached ? { ...inferred, ...cached } : inferred };
  });
}

/** Avatars are optional: a failed image must not remove a creator or their work. */
export async function mirrorCreatorAvatars<T extends Prompt>(
  items: readonly T[], mirror: (url: string) => Promise<string>, onFailure: (creatorID: string, error: unknown) => void,
): Promise<T[]> {
  const avatars = new Map<string, string | undefined>();
  const result: T[] = [];
  for (const item of items) {
    const creator = item.creator;
    if (!creator?.avatarURL) { result.push(item); continue; }
    if (!avatars.has(creator.avatarURL)) {
      try { avatars.set(creator.avatarURL, await mirror(creator.avatarURL)); }
      catch (error) { avatars.set(creator.avatarURL, undefined); onFailure(creator.id, error); }
    }
    const { avatarURL: _, ...identity } = creator;
    const mirrored = avatars.get(creator.avatarURL);
    result.push({ ...item, creator: { ...identity, ...(mirrored ? { avatarURL: mirrored } : {}) } });
  }
  return result;
}
