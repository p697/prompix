import { feed, listable, type Card, type Env, type Page } from "./feed.ts";
import { escape } from "./html.ts";
import { kindSlugs, locales, type Locale } from "./i18n.ts";
import { site, url } from "./layout.ts";

const pagesPerSitemap = 70;
const staticPaths = ["/", "/explore", ...Object.values(kindSlugs).map(slug => `/explore/${slug}`), "/support", "/privacy", "/content", "/report"];

export const robots = () => `User-agent: *
Allow: /
Disallow: /*?q=
Disallow: /*&q=

Sitemap: ${site}/sitemap.xml
`;

export const sitemapIndex = () => `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>${site}/sitemaps/pages.xml</loc></sitemap>
<sitemap><loc>${site}/sitemaps/prompts.xml</loc></sitemap>
</sitemapindex>
`;

function entry(path: string, available: Locale[]) {
  const links = available.length > 1 ? available.map(l => `<xhtml:link rel="alternate" hreflang="${l.tag}" href="${escape(url(l, path))}"/>`).join("") : "";
  return available.map(l => `<url><loc>${escape(url(l, path))}</loc>${links}</url>`).join("\n");
}

const urlset = (entries: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.join("\n")}
</urlset>
`;

export const pagesSitemap = () => urlset(staticPaths.map(path => entry(path, locales)));

/** Languages in which a card has a natural title: a translation exists, or its base title fits. */
export const cardLocales = (card: Pick<Card, "title" | "availableLanguages">) =>
  locales.filter(l => card.availableLanguages.includes(l.feed) || l.fits(card.title));

/**
 * Lists every indexable prompt by walking the newest-first feed in its original language.
 * The walk stops early if the platform's subrequest budget runs out; `complete` reports it.
 */
export async function promptsSitemap(env: Env, ctx: ExecutionContext): Promise<{ xml: string; complete: boolean }> {
  const entries: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null, complete = false;
  try {
    for (let index = 0; index < pagesPerSitemap; index++) {
      const path: string = `/v3/feed?locale=original&sort=latest&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const result: Page = await feed<Page>(env, ctx, path, 3600, null);
      for (const card of result.items) {
        if (seen.has(card.id) || !listable(card)) continue;
        seen.add(card.id);
        const available = cardLocales(card);
        if (available.length) entries.push(entry(`/prompts/${card.id}`, available));
      }
      cursor = result.nextCursor;
      if (!cursor) { complete = true; break; }
    }
  } catch {
    // Keep what was collected; a later refresh retries the full walk.
  }
  return { xml: urlset(entries), complete };
}
