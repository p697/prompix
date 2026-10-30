import { avatar, cardMedia, cover, dimensions, formatCount, promptPath, tile } from "../components.ts";
import { coverImage, feed, isMedia, kindOf, listable, localize, preferFitting, type Card, type CreatorEntry, type Env, type Item, type Page } from "../feed.ts";
import { html, raw } from "../html.ts";
import { kindSlugs, localePath, type Kind, type Locale } from "../i18n.ts";
import { icons, organization, page, repository, site, url } from "../layout.ts";

/** Prompix original shown in every reading language. */
const showcaseID = "summer-citrus";
const readingLanguages: [string, string][] = [
  ["en", "English"], ["zh-Hans", "简体中文"], ["zh-Hant", "繁體中文"], ["ja", "日本語"], ["ko", "한국어"],
  ["es", "Español"], ["pt-BR", "Português"], ["fr", "Français"], ["de", "Deutsch"],
];

type Load = <T>(path: string, ttl: number) => Promise<T>;
const settle = async <T>(promise: Promise<T>) => { try { return await promise; } catch { return undefined; } };

async function load(locale: Locale, get: Load) {
  const q = (params: string) => `/v3/feed?locale=${locale.feed}&${params}`;
  const [state, wall, latest, videos, texts, webs, skills, creators, languages] = await Promise.all([
    settle(get<{ count: number }>("/v3/state", 600)),
    settle(get<Page>(q("kind=image&sort=latest&limit=50"), 600)),
    settle(get<Page>(q("sort=discovery&limit=40"), 600)),
    settle(get<Page>(q("kind=video&sort=latest&limit=20"), 900)),
    settle(get<Page>(q("kind=text&sort=latest&limit=20"), 900)),
    settle(get<Page>(q("kind=web&limit=10"), 3600)),
    settle(get<Page>(q("kind=skill&sort=latest&limit=20"), 900)),
    settle(get<{ items: CreatorEntry[] }>("/v3/creators?sort=recommended&limit=40", 1800)),
    Promise.all(readingLanguages.map(([language]) =>
      settle(get<{ item: Item }>(`/v3/contents/${showcaseID}?locale=${language}`, 86400)))),
  ]);
  return { state, wall, latest, videos, texts, webs, skills, creators, languages };
}

const pick = (page: Page | undefined, locale: Locale, test: (card: Card) => boolean = () => true) =>
  preferFitting((page?.items ?? []).filter(card => listable(card) && test(card)), locale.fits);

function hero(locale: Locale, wall: Card[]) {
  const m = locale.messages;
  const rows = [wall.filter((_, i) => i % 2 === 0), wall.filter((_, i) => i % 2 === 1)].filter(row => row.length >= 4);
  const wallTile = (card: Card, copy: boolean, index: number) => {
    const { width, height } = dimensions(card.media?.aspectRatio, 400);
    return html`<li><a href="${promptPath(locale, card.id)}"${copy ? raw(' tabindex="-1"') : ""}><img src="${coverImage(card)}" width="${width}" height="${height}" alt="${copy ? "" : card.title}"${!copy && index < 7 ? "" : raw(' loading="lazy"')} decoding="async"></a></li>`;
  };
  return html`<section class="hero">
<div class="hero-copy container">
<h1 class="hero-title">${raw(m.hero.title)}</h1>
<p class="hero-lead">${m.hero.lead}</p>
<div class="cta"><a class="button" href="${localePath(locale, "/explore")}">${m.hero.primary}</a><a class="link" href="#iphone">${m.hero.secondary}${icons.chevron}</a></div>
</div>
${rows.length ? html`<div class="wall" role="region" aria-label="${m.hero.wallLabel}">${rows.map((row, index) => html`<div class="wall-row${index ? " wall-row-reverse" : ""}"><ul>${row.map((card, i) => wallTile(card, false, i))}</ul><ul aria-hidden="true">${row.map((card, i) => wallTile(card, true, i))}</ul></div>`)}</div>` : ""}
</section>`;
}

function latest(locale: Locale, cards: Card[]) {
  const m = locale.messages;
  if (cards.length < 4) return "";
  return html`<section class="section section-alt" aria-labelledby="latest-title">
<div class="container section-head"><h2 id="latest-title" class="headline">${m.latest.title}</h2><a class="link" href="${localePath(locale, "/explore")}">${m.latest.all}${icons.chevron}</a></div>
<div class="rail" data-rail><ul class="rail-track">${cards.map(card => tile(card, locale))}</ul></div>
<div class="container rail-controls"><button type="button" class="round" data-rail-prev aria-label="${m.latest.previous}" disabled>${icons.back}</button><button type="button" class="round" data-rail-next aria-label="${m.latest.next}">${icons.chevron}</button></div>
</section>`;
}

function bentoCopy(locale: Locale, kind: Kind) {
  const m = locale.messages;
  return html`<div class="bento-copy"><p class="eyebrow">${m.kinds.names[kind]}</p><h3>${m.kinds.lines[kind]}</h3><span class="link">${m.kinds.browse}${icons.chevron}</span></div>`;
}

function kinds(locale: Locale, data: { images: Card[]; video?: Card; texts: Card[]; web?: Card; skill?: Card }) {
  const m = locale.messages;
  const href = (kind: Kind) => localePath(locale, `/explore/${kindSlugs[kind]}`);
  const mosaic = data.images.slice(0, 6);
  const video = data.video;
  return html`<section class="section" aria-labelledby="kinds-title">
<div class="container">
<h2 id="kinds-title" class="headline headline-center">${raw(m.kinds.title)}</h2>
<div class="bento">
<a class="bento-tile bento-image" href="${href("image")}">${bentoCopy(locale, "image")}
${mosaic.length === 6 ? html`<div class="mosaic" aria-hidden="true">${mosaic.map(card => html`<img src="${coverImage(card)}" width="400" height="500" alt="" loading="lazy" decoding="async">`)}</div>` : ""}</a>
<a class="bento-tile bento-video dark" href="${href("video")}">
${video && isMedia(video.media?.videoURL) ? html`<video muted loop playsinline preload="none" poster="${coverImage(video)}" data-autoplay aria-hidden="true"><source src="${video.media!.videoURL}" type="video/mp4"></video>` : ""}
${bentoCopy(locale, "video")}</a>
<a class="bento-tile bento-text" href="${href("text")}">${bentoCopy(locale, "text")}
${data.texts.length ? html`<div class="quotes" aria-hidden="true">${data.texts.slice(0, 2).reverse().map(text => html`<blockquote class="quote"><p class="quote-title">${text.title}</p><p>${text.summary}</p></blockquote>`)}</div>` : ""}</a>
<a class="bento-tile bento-web" href="${href("web")}">${bentoCopy(locale, "web")}
${data.web ? html`<div class="browser" aria-hidden="true"><div class="browser-bar"><i></i><i></i><i></i></div><div class="browser-page">${coverImage(data.web) ? cardMedia(data.web, locale) : cover(data.web, m.kinds.names.web, "large")}</div></div>` : ""}</a>
<a class="bento-tile bento-skill dark" href="${href("skill")}">${bentoCopy(locale, "skill")}
${data.skill ? html`<pre class="skill-file" aria-hidden="true"><span class="skill-file-name">SKILL.md</span>
<span class="dim">---</span>
<span class="key">name:</span> ${data.skill.title}
<span class="key">description:</span> ${data.skill.summary}
<span class="dim">---</span></pre>` : ""}</a>
</div></div></section>`;
}

function stats(locale: Locale, count: number | undefined) {
  const m = locale.messages;
  if (!count) return "";
  return html`<section class="section section-dark stats" aria-label="Prompix">
<div class="container center">
<p class="stat-hero">${raw(m.stats.title(formatCount(locale, count)))}</p>
<p class="stat-label">${m.stats.label}</p>
<ul class="stat-row">${m.stats.items.map(item => html`<li><strong>${item.value}</strong><span>${item.label}</span></li>`)}</ul>
</div></section>`;
}

function creators(locale: Locale, entries: CreatorEntry[]) {
  const m = locale.messages;
  if (entries.length < 4) return "";
  return html`<section class="section" aria-labelledby="creators-title">
<div class="container">
<h2 id="creators-title" class="headline">${m.creators.title}</h2>
<p class="section-lead">${m.creators.lead}</p>
<ul class="creators">${entries.map(entry => html`<li><a class="creator" href="${localePath(locale, "/explore")}?creator=${encodeURIComponent(entry.creator.id)}">
<div class="creator-cover"><img src="${coverImage(entry.preview!)}" width="400" height="400" alt="" loading="lazy" decoding="async"></div>
<div class="creator-info">${avatar(entry.creator, 44)}<div><h3>${entry.creator.displayName}</h3><p>${m.creators.works(entry.count)}</p></div></div>
</a></li>`)}</ul>
</div></section>`;
}

function languages(locale: Locale, details: ({ item: Item } | undefined)[]) {
  const m = locale.messages;
  const rows = readingLanguages.map(([language, name], index) => {
    const item = details[index]?.item;
    return item ? { language, name, title: localize(item, language).item.title, item } : undefined;
  }).filter(row => !!row);
  if (rows.length < 6) return "";
  const image = coverImage(rows[0].item);
  return html`<section class="section section-alt" aria-labelledby="languages-title">
<div class="container">
<h2 id="languages-title" class="headline">${m.languages.title}</h2>
<p class="section-lead">${m.languages.lead}</p>
<div class="languages">
${image ? html`<a class="languages-art" href="${promptPath(locale, showcaseID)}"><img src="${image}" width="800" height="1000" alt="" loading="lazy" decoding="async"></a>` : ""}
<ul class="languages-list">${rows.map(row => html`<li lang="${row.language}"><span>${row.name}</span><strong>${row.title}</strong></li>`)}</ul>
</div></div></section>`;
}

function iphone(locale: Locale) {
  const m = locale.messages;
  return html`<section class="section iphone" id="iphone" aria-labelledby="iphone-title">
<div class="container center">
<div class="app-icon"><img src="/assets/icon-512.png" width="168" height="168" alt="Prompix"></div>
<h2 id="iphone-title" class="headline headline-center">${m.iphone.title}</h2>
<p class="section-lead center">${m.iphone.lead}</p>
<p class="pill">${m.iphone.status}</p>
<p><a class="link" href="${repository}">${m.iphone.follow}${icons.chevron}</a></p>
</div></section>`;
}

export async function home(locale: Locale, env: Env, ctx: ExecutionContext, client: string | null): Promise<string> {
  const m = locale.messages;
  const get: Load = (path, ttl) => feed(env, ctx, path, ttl, client);
  const data = await load(locale, get);
  const latestCards = pick(data.latest, locale).slice(0, 12);
  const used = new Set(latestCards.map(card => card.id));
  const images = pick(data.wall, locale, card => !!coverImage(card) && !used.has(card.id));
  const wall = images.slice(0, 24);
  const mosaic = images.slice(24, 30).length === 6 ? images.slice(24, 30) : images.slice(0, 6);
  const fitting = (page: Page | undefined, test?: (card: Card) => boolean) => pick(page, locale, test)[0];
  const featuredCreators = (data.creators?.items ?? [])
    .filter(entry => entry.preview && listable(entry.preview) && coverImage(entry.preview) && isMedia(entry.creator.avatarURL))
    .slice(0, 8).sort((a, b) => b.count - a.count);
  const body = html`${hero(locale, wall)}
${latest(locale, latestCards)}
${kinds(locale, {
    images: mosaic,
    video: fitting(data.videos, card => isMedia(card.media?.videoURL) && !!coverImage(card) && !used.has(card.id)),
    texts: pick(data.texts, locale, card => kindOf(card) === "text" && locale.fits(card.title)),
    web: fitting(data.webs),
    skill: fitting(data.skills),
  })}
${stats(locale, data.state?.count)}
${creators(locale, featuredCreators)}
${languages(locale, data.languages)}
${iphone(locale)}`;
  return page({
    locale, path: "/", title: m.meta.homeTitle, description: m.meta.homeDescription,
    jsonld: [{
      "@context": "https://schema.org", "@graph": [organization, {
        "@type": "WebSite", "@id": `${site}/#website`, url: url(locale, "/"), name: "Prompix", inLanguage: locale.tag,
        description: m.meta.homeDescription, publisher: { "@id": organization["@id"] },
        potentialAction: { "@type": "SearchAction", target: `${url(locale, "/explore")}?q={search_term_string}`, "query-input": "required name=search_term_string" },
      }],
    }],
  }, body, "home");
}

