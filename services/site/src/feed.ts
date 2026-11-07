import type { Kind } from "./i18n.ts";

export interface Creator {
  id: string; platform: "x" | "github" | "web"; displayName: string; username?: string;
  profileURL: string; avatarURL?: string; bio?: string;
}
export interface Media {
  imageURL?: string; imageURLs?: string[]; videoURL?: string; aspectRatio?: number; demoURL?: string | null;
}
export interface Cover { text: string; eyebrow: string; tone?: "sage" | "clay" | "ink" | "sky" | "cream" }
export interface Card {
  id: string; kind: Kind | "web"; contentType: "prompt" | "skill"; title: string; summary: string;
  tags: string[]; model: string; previewLabel: string; creator?: Creator; media: Media | null; cover?: Cover | null;
  language: string; availableLanguages: string[]; presentation?: string;
}
export interface Translation { title: string; summary: string; prompt: string; example: string; previewLabel: string; cover?: Cover }
export interface Item extends Omit<Card, "language" | "availableLanguages"> {
  prompt: string; example: string; toolURL: string | null; publishedAt?: string;
  source: { name: string; url: string | null; license: string; method: string; author?: string; repository?: string };
  localization?: { sourceLanguage: string; translations: Partial<Record<string, Translation>> };
}
export interface Page { items: Card[]; nextCursor: string | null }
export interface CreatorEntry { creator: Creator; count: number; preview?: Card }
export interface Env { FEED?: Fetcher; ASSETS: Fetcher }

export class FeedFailure extends Error {
  constructor(readonly status: number) { super(`feed ${status}`); }
}

const origin = "https://api.prompix.dev";
const mediaOrigin = "https://api.prompix.dev/media/";

/** Reads a JSON document from the content feed, sharing a short edge cache across visitors. */
export async function feed<T>(env: Env, ctx: ExecutionContext, path: string, ttl: number, client: string | null): Promise<T> {
  const key = new Request(`https://prompix.dev/__feed${path}`);
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(key);
  if (hit) return hit.json<T>();
  const request = new Request(origin + path, { headers: { Accept: "application/json", ...(client ? { "CF-Connecting-IP": client } : {}) } });
  const response = await (env.FEED ? env.FEED.fetch(request) : fetch(request));
  if (!response.ok) throw new FeedFailure(response.status);
  const body = await response.text();
  ctx.waitUntil(cache.put(key, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } })));
  return JSON.parse(body) as T;
}

/** Only published media from the content service is rendered; anything else falls back to a typographic cover. */
export const isMedia = (url: string | undefined | null): url is string => !!url && url.startsWith(mediaOrigin);

export const coverImage = (card: Pick<Card, "media">) => isMedia(card.media?.imageURL) ? card.media!.imageURL! : undefined;

/**
 * Lists show only previews reviewed as ordinary imagery, matching the app's default of reducing
 * suggestive previews. Prompts without a visual preview have nothing to review.
 */
export const listable = (card: Pick<Card, "presentation" | "media">) => card.presentation === "general" || !coverImage(card);

// Skills and web prompts left the library on 2026-11-07; a stray one reads as text.
export const kindOf = (card: Pick<Card, "kind" | "contentType">): Kind => card.contentType === "skill" || card.kind === "web" ? "text" : card.kind;

/**
 * Merges the translation for `language` into an item. Metadata may be translated even when the
 * prompt is already in that language; `translated` reports whether the prompt text itself differs.
 */
export function localize(item: Item, language: string): { item: Item; translated: boolean; original: Item } {
  const translation = item.localization?.translations?.[language];
  if (!translation) return { item, translated: false, original: item };
  return {
    item: { ...item, ...translation, cover: translation.cover ? { ...item.cover, ...translation.cover } : item.cover },
    translated: translation.prompt.trim() !== item.prompt.trim(), original: item,
  };
}

/** Stable reorder that puts cards readable in the page language first. */
export function preferFitting<T extends { title: string }>(cards: T[], fits: (title: string) => boolean) {
  return [...cards.filter(card => fits(card.title)), ...cards.filter(card => !fits(card.title))];
}
