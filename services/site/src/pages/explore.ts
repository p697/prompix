import { card, promptPath } from "../components.ts";
import { feed, FeedFailure, listable, type Env, type Page } from "../feed.ts";
import { html } from "../html.ts";
import { kindSlugs, localePath, type Kind, type Locale } from "../i18n.ts";
import { icons, page, site, url } from "../layout.ts";

export interface ExploreQuery { kind?: Kind; q: string; creator?: string; tag?: string; after?: string }

const clean = (value: string | null, max: number) => {
  const text = (value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return text.length > max ? text.slice(0, max) : text;
};

export function parseExplore(params: URLSearchParams, kind?: Kind): ExploreQuery {
  const words = clean(params.get("q"), 120).split(" ").slice(0, 8).join(" ");
  const creator = clean(params.get("creator"), 200) || undefined;
  const tag = clean(params.get("tag"), 100) || undefined;
  const after = params.get("after") ?? undefined;
  return { kind, q: words, creator, tag, after: after && after.length <= 2048 ? after : undefined };
}

export const exploreSearch = (query: ExploreQuery, after?: string) => {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.creator) params.set("creator", query.creator);
  if (query.tag) params.set("tag", query.tag);
  if (after) params.set("after", after);
  const value = params.toString();
  return value ? `?${value}` : "";
};

/** Returns the page, or a redirect target when a pagination cursor has expired. */
export async function explore(locale: Locale, query: ExploreQuery, env: Env, ctx: ExecutionContext, client: string | null): Promise<string | { redirect: string }> {
  const m = locale.messages;
  const path = query.kind ? `/explore/${kindSlugs[query.kind]}` : "/explore";
  const filtered = !!(query.q || query.creator || query.tag);
  // Unfiltered browsing shows prompts whose titles read naturally in the page language.
  const visible = (cards: Page["items"]) => cards.filter(item => listable(item) && (filtered || locale.fits(item.title)));
  const params = new URLSearchParams({ locale: locale.feed, limit: "50" });
  if (query.kind) params.set("kind", query.kind);
  if (query.q) params.set("q", query.q);
  else params.set("sort", query.kind || query.creator || query.tag ? "latest" : "discovery");
  if (query.creator) params.set("creator", query.creator);
  if (query.tag) params.set("tag", query.tag);
  if (query.after) params.set("cursor", query.after);
  let result: Page;
  try {
    result = await feed<Page>(env, ctx, `/v3/feed?${params}`, query.after ? 1800 : 300, client);
    for (let extra = 0; extra < 4 && result.nextCursor && visible(result.items).length < 24; extra++) {
      params.set("cursor", result.nextCursor);
      const next = await feed<Page>(env, ctx, `/v3/feed?${params}`, 1800, client);
      result = { items: [...result.items, ...next.items], nextCursor: next.nextCursor };
    }
  } catch (error) {
    if (error instanceof FeedFailure && query.after && [400, 410].includes(error.status))
      return { redirect: localePath(locale, path) + exploreSearch({ ...query, after: undefined }) };
    if (error instanceof FeedFailure && error.status === 400) result = { items: [], nextCursor: null };
    else throw error;
  }
  const items = visible(result.items);
  const creatorName = query.creator ? result.items.find(item => item.creator?.id === query.creator)?.creator?.displayName : undefined;
  const heading = query.q ? m.explore.results(query.q)
    : creatorName ? m.explore.by(creatorName)
    : query.tag ? m.explore.tagged(query.tag)
    : query.kind ? m.explore.titles[query.kind] : m.explore.title;
  const kinds: (Kind | undefined)[] = [undefined, "image", "video", "text"];
  const keep = exploreSearch({ ...query, after: undefined, creator: undefined, tag: undefined });
  const filters = html`<nav class="segments" aria-label="${m.explore.filters}">${kinds.map(kind => {
    const href = localePath(locale, kind ? `/explore/${kindSlugs[kind]}` : "/explore") + keep;
    return html`<a href="${href}"${kind === query.kind ? html` aria-current="page"` : ""}>${kind ? m.kinds.plural[kind] : m.explore.all}</a>`;
  })}</nav>`;
  const more = result.nextCursor
    ? html`<div class="more"><a class="button button-quiet" href="${localePath(locale, path) + exploreSearch(query, result.nextCursor)}" data-more rel="next">${m.explore.more}</a></div>` : "";
  const body = html`<section class="explore container">
<header class="explore-head"><h1 class="headline">${heading}</h1>
<form class="search" role="search" action="${localePath(locale, path)}" method="get">
<label class="search-field">${icons.search}<span class="visually-hidden">${m.explore.searchLabel}</span><input type="search" name="q" value="${query.q}" placeholder="${m.explore.search}" maxlength="120" autocomplete="off" enterkeyhint="search"></label>
${filtered ? html`<a class="link search-clear" href="${localePath(locale, path)}">${m.explore.clear}</a>` : ""}
</form>
${filters}</header>
${items.length ? html`<ul class="grid" data-grid>${items.map((item, index) => card(item, locale, index < 4 && !query.after))}</ul>` : html`<p class="empty">${m.explore.empty}</p>`}
${more}
</section>`;
  const description = m.meta.exploreDescription;
  return page({
    locale, path, title: `${heading.replace(/[.。]$/u, "")} — Prompix`, description,
    noindex: filtered || !!query.after, search: exploreSearch(query), current: "explore",
    jsonld: filtered || query.after ? [] : [{
      "@context": "https://schema.org", "@type": "CollectionPage", name: heading, url: url(locale, path), inLanguage: locale.tag,
      isPartOf: { "@id": `${site}/#website` },
      mainEntity: { "@type": "ItemList", itemListElement: items.slice(0, 24).map((item, index) => ({
        "@type": "ListItem", position: index + 1, url: site + promptPath(locale, item.id), name: item.title })) },
    }],
  }, body, "explore-page");
}
