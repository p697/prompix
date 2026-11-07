# Public website

The official site at `https://prompix.dev`: a server-rendered Cloudflare Worker that shows the
latest published prompts, a page per prompt, and the support, privacy, content and report pages
the app links to. It is a companion to the native iOS app, not a web version of it. It has no user
accounts, analytics, third-party scripts, cookies or forms that submit user data.

## How it works

- `src/worker.ts` routes requests, applies security headers and caches rendered pages at the edge
  (home and lists 10 minutes, prompt pages 30 minutes, sitemaps up to 6 hours). Only the
  `prompix.dev` host uses the shared page cache; local previews always render fresh.
- Content comes from the `prompix-feed` Worker through the `FEED` service binding, using the same
  public `/v3` endpoints as the app. The visitor's `CF-Connecting-IP` is forwarded so the feed's
  per-IP rate limit still applies. Feed responses are cached for a few minutes per URL.
- Lists show only previews reviewed as `general` (and prompts without a visual), matching the
  app's default of reducing suggestive previews. Other prompts stay reachable by direct link
  but are `noindex` and left out of sitemaps.
- Images and videos load directly from `api.prompix.dev/media`; nothing is copied into this
  directory. Website assets in `public/assets` are derived from the app icon by
  `scripts/make-assets.py`.
- `public/site.js` is progressive enhancement only (copy, translation toggle, rail buttons,
  "show more", muted video in view, scroll reveal). Every page works without it.

## Languages

English lives at `/`, Simplified Chinese at `/zh`. Messages are typed by `Messages` in
`src/i18n.ts`, and a test checks every locale has the same keys. To add a language, add
`src/locales/<id>.ts` (and its legal pages), then register it in `locales` with its URL prefix,
feed locale and a `fits` rule for which titles read naturally in it. Routes, `hreflang`,
sitemaps and the language menu follow from the registry.

Many recent prompts only have Chinese metadata. Unfiltered English lists skip titles that do not
fit English; English prompt pages without an English title are `noindex`. Searches and creator
or tag filters show everything.

## SEO

Each page has a canonical URL, `hreflang` alternates with `x-default`, Open Graph and Twitter
cards (prompt images on prompt pages), and JSON-LD (`WebSite` with `SearchAction`,
`CollectionPage`/`ItemList`, `CreativeWork` with author, source and license, `BreadcrumbList`).
`/sitemap.xml` indexes `/sitemaps/pages.xml` and `/sitemaps/prompts.xml`; the latter walks the
newest-first feed. If the platform's subrequest budget stops the walk early, the partial sitemap
is cached for 30 minutes instead of 6 hours. `robots.txt` keeps search result pages out of
crawling.

## Develop and publish

From the repository root with Node 22 and `npm ci`:

```sh
npm run dev:site            # http://localhost:8788
npx tsx --test services/site/src/site.test.ts
npm run deploy:site
```

`wrangler dev` reaches the deployed feed through a remote service binding, which needs
`wrangler login`; without a binding the Worker falls back to the public API. `/report?id=<public-prompt-id>` renders a validated
public ID and prefills the repository's content issue form; personal drafts and saved state never
enter the URL.

After deployment, check `/`, `/zh`, an explore page, a prompt page in both languages, the custom
404, `/sitemap.xml` and `/robots.txt`, and confirm the app's `/support`, `/privacy` and
`/report?id=` links still resolve.

Support, privacy and content-report pages offer `support@prompix.dev`. Cloudflare Email Routing
forwards only that address to the owner's verified destination, which must never appear in the
repository. Before App Store submission, review the privacy text against the final build's
network behavior and Cloudflare settings.
