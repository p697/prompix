import { html, jsonScript, raw, type Html } from "./html.ts";
import { kindSlugs, localePath, locales, type Kind, type Locale } from "./i18n.ts";

export const site = "https://prompix.dev";
export const repository = "https://github.com/p697/prompix";
/** Bumped with every visual change so long-lived asset caches refresh. */
export const assetVersion = "2026103001";

export interface PageMeta {
  locale: Locale;
  /** Locale-independent path starting with "/". */
  path: string;
  title: string;
  description: string;
  image?: string;
  imageAlt?: string;
  type?: "website" | "article";
  noindex?: boolean;
  /** Locales that have a real version of this page; defaults to all. */
  alternates?: Locale[];
  /** Query kept when switching language, e.g. "?id=…". */
  search?: string;
  jsonld?: unknown[];
  current?: "explore" | "support";
}

export const icons = {
  chevron: raw('<svg class="icon" viewBox="0 0 10 16" aria-hidden="true"><path d="M2 2l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
  back: raw('<svg class="icon" viewBox="0 0 10 16" aria-hidden="true"><path d="M8 2L2 8l6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
  external: raw('<svg class="icon" viewBox="0 0 14 14" aria-hidden="true"><path d="M5 2h7v7M12 2L3 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'),
  globe: raw('<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.6 10h14.8M10 2.4c2.2 2.3 3.2 4.8 3.2 7.6s-1 5.3-3.2 7.6c-2.2-2.3-3.2-4.8-3.2-7.6s1-5.3 3.2-7.6z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>'),
  search: raw('<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.8" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M13 13l4.5 4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'),
  play: raw('<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4.2v11.6c0 .8.9 1.3 1.6.9l9.3-5.8c.6-.4.6-1.4 0-1.8L7.6 3.3C6.9 2.9 6 3.4 6 4.2z" fill="currentColor"/></svg>'),
};

export const url = (locale: Locale, path: string) => site + localePath(locale, path);

function head(meta: PageMeta) {
  const { locale } = meta;
  const alternates = meta.alternates ?? locales;
  const canonical = url(locale, meta.path);
  const image = meta.image ?? `${site}/assets/og.png`;
  return html`<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${meta.title}</title>
<meta name="description" content="${meta.description}">
${meta.noindex ? raw('<meta name="robots" content="noindex,follow">') : ""}
<link rel="canonical" href="${canonical}">
${alternates.length > 1 ? alternates.map(l => html`<link rel="alternate" hreflang="${l.tag}" href="${url(l, meta.path)}">`) : ""}
${alternates.length > 1 && alternates.includes(locales[0]) ? html`<link rel="alternate" hreflang="x-default" href="${url(locales[0], meta.path)}">` : ""}
<meta property="og:site_name" content="Prompix">
<meta property="og:type" content="${meta.type ?? "website"}">
<meta property="og:title" content="${meta.title}">
<meta property="og:description" content="${meta.description}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${image}">
${meta.imageAlt ? html`<meta property="og:image:alt" content="${meta.imageAlt}">` : ""}
<meta property="og:locale" content="${locale.og}">
${alternates.filter(l => l !== locale).map(l => html`<meta property="og:locale:alternate" content="${l.og}">`)}
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#ffffff">
<meta name="color-scheme" content="light">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/icon-32.png">
<link rel="icon" type="image/png" sizes="192x192" href="/assets/icon-192.png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="preconnect" href="https://api.prompix.dev" crossorigin>
<link rel="stylesheet" href="/site.css?v=${assetVersion}">
<script src="/site.js?v=${assetVersion}" defer></script>
${(meta.jsonld ?? []).map(jsonScript)}`;
}

function languageMenu(meta: PageMeta) {
  const alternates = meta.alternates ?? locales;
  const m = meta.locale.messages;
  return html`<details class="lang"><summary aria-label="${m.nav.language}">${icons.globe}<span>${meta.locale.name}</span></summary>
<ul>${locales.map(l => html`<li><a href="${localePath(l, alternates.includes(l) ? meta.path : "/") + (alternates.includes(l) ? meta.search ?? "" : "")}" hreflang="${l.tag}" lang="${l.tag}"${l === meta.locale ? raw(' aria-current="true"') : ""}>${l.name}</a></li>`)}</ul></details>`;
}

function header(meta: PageMeta) {
  const { locale } = meta;
  const m = locale.messages;
  const at = (key: PageMeta["current"]) => meta.current === key ? raw(' aria-current="page"') : "";
  return html`<header class="globalnav"><nav class="globalnav-inner" aria-label="${m.nav.label}">
<a class="brand" href="${localePath(locale, "/")}" aria-label="${m.nav.home}"><img src="/assets/icon-64.png" width="22" height="22" alt=""><span>Prompix</span></a>
<div class="globalnav-links"><a href="${localePath(locale, "/explore")}"${at("explore")}>${m.nav.explore}</a><a href="${localePath(locale, "/support")}"${at("support")}>${m.nav.support}</a>${languageMenu(meta)}</div>
</nav></header>`;
}

function footer(meta: PageMeta) {
  const { locale } = meta;
  const m = locale.messages;
  const kinds: Kind[] = ["image", "video", "text"];
  return html`<footer class="footer"><div class="footer-inner">
<div class="footer-columns">
<div><h2>${m.footer.explore}</h2><ul>${kinds.map(kind => html`<li><a href="${localePath(locale, `/explore/${kindSlugs[kind]}`)}">${m.kinds.plural[kind]}</a></li>`)}</ul></div>
<div><h2>${m.footer.prompix}</h2><ul>
<li><a href="${localePath(locale, "/support")}">${m.legal.supportLink}</a></li>
<li><a href="${localePath(locale, "/privacy")}">${m.legal.privacyLink}</a></li>
<li><a href="${localePath(locale, "/content")}">${m.legal.contentLink}</a></li>
<li><a href="${localePath(locale, "/report")}">${m.legal.reportLink}</a></li></ul></div>
<div><h2>${m.footer.project}</h2><ul><li><a href="${repository}">${m.footer.github}</a></li><li><a href="${repository}/blob/main/LICENSE">${m.footer.license}</a></li></ul></div>
</div>
<p class="footer-note">${m.footer.note}</p>
<div class="footer-bottom"><span>© 2026 Prompix</span><nav aria-label="${m.footer.languages}">${locales.map(l => html`<a href="${localePath(l, (meta.alternates ?? locales).includes(l) ? meta.path : "/")}" hreflang="${l.tag}" lang="${l.tag}"${l === locale ? raw(' aria-current="true"') : ""}>${l.name}</a>`)}</nav></div>
</div></footer>`;
}

export function page(meta: PageMeta, body: Html, bodyClass = "") {
  const m = meta.locale.messages;
  return `<!doctype html>
<html lang="${meta.locale.tag}"><head>${head(meta)}</head>
<body${bodyClass ? ` class="${bodyClass}"` : ""}><a class="skip" href="#main">${m.nav.skip}</a>${header(meta)}<main id="main">${body}</main>${footer(meta)}</body></html>`;
}

export const organization = {
  "@type": "Organization", "@id": `${site}/#organization`, name: "Prompix", url: site,
  logo: `${site}/assets/icon-512.png`, sameAs: [repository],
};
