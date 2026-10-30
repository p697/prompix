import { avatar, card, cover, dimensions, formatDate, modelName } from "../components.ts";
import { feed, isMedia, kindOf, listable, localize, type Env, type Item, type Page } from "../feed.ts";
import { html, raw } from "../html.ts";
import { kindSlugs, localePath, locales, type Locale } from "../i18n.ts";
import { icons, organization, page, url } from "../layout.ts";

export const promptID = /^[a-z0-9-]{1,200}$/;
const cjk = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u;

const hostOf = (value: string | null | undefined) => {
  try { return value ? new URL(value).hostname.replace(/^www\./, "") : ""; } catch { return ""; }
};
const safeLink = (value: string | null | undefined) => {
  try { return value && new URL(value).protocol === "https:" ? value : undefined; } catch { return undefined; }
};
const sourceLanguageTag = (item: Item) => item.localization?.sourceLanguage;

function promptBlock(locale: Locale, shown: Item, original: Item, translated: boolean) {
  const m = locale.messages;
  const body = (item: Item, lang: string | undefined, hidden: boolean, id: string) =>
    html`<pre class="prompt-text" id="${id}"${lang ? html` lang="${lang}"` : ""}${hidden ? raw(" hidden") : ""}>${item.prompt}</pre>`;
  return html`<section class="prompt-block" aria-labelledby="prompt-heading" data-prompt>
<div class="prompt-head"><h2 id="prompt-heading">${m.prompt.prompt}</h2>
${translated ? html`<div class="toggle" role="group"><button type="button" aria-pressed="true" data-show="prompt-translated">${m.prompt.translated}</button><button type="button" aria-pressed="false" data-show="prompt-original">${m.prompt.original}</button></div>` : ""}</div>
<div class="prompt-body" data-clamp>${translated ? [body(shown, locale.tag, false, "prompt-translated"), body(original, sourceLanguageTag(original), true, "prompt-original")]
    : body(shown, sourceLanguageTag(original), false, "prompt-original")}
<button type="button" class="prompt-expand" data-expand hidden>${m.prompt.expand}</button></div>
</section>`;
}

function mediaColumn(locale: Locale, item: Item) {
  const m = locale.messages;
  const kind = kindOf(item);
  const images = (item.media?.imageURLs?.length ? item.media.imageURLs : [item.media?.imageURL]).filter(isMedia);
  const { width, height } = dimensions(item.media?.aspectRatio, 1200);
  let media;
  if (item.kind === "video" && isMedia(item.media?.videoURL))
    media = html`<video class="media-main" controls playsinline preload="metadata"${images[0] ? html` poster="${images[0]}"` : ""} width="${width}" height="${height}"><source src="${item.media!.videoURL}" type="video/mp4"></video>`;
  else if (images.length)
    media = html`<img class="media-main" src="${images[0]}" width="${width}" height="${height}" alt="${item.title}" fetchpriority="high">
${images.length > 1 ? html`<div class="media-more">${images.slice(1).map(src => html`<img src="${src}" width="600" height="600" alt="" loading="lazy" decoding="async">`)}</div>` : ""}`;
  else if (kind === "skill")
    media = html`<pre class="skill-file skill-file-large" aria-hidden="true"><span class="skill-file-name">SKILL.md</span>
<span class="dim">---</span>
<span class="key">name:</span> ${item.skill?.name ?? item.title}
<span class="key">description:</span> ${item.summary}
<span class="dim">---</span></pre>`;
  else media = cover(item, m.kinds.one[kind], "large");
  return html`<figure class="media">${media}<figcaption>${item.previewLabel}</figcaption></figure>`;
}

function details(locale: Locale, item: Item) {
  const m = locale.messages;
  const kind = kindOf(item);
  const model = modelName(item.model, locale);
  const published = formatDate(locale, item.publishedAt);
  const source = safeLink(item.source.url);
  const rows = [
    [m.prompt.type, html`<a href="${localePath(locale, `/explore/${kindSlugs[kind]}`)}">${m.kinds.one[kind]}</a>`],
    model ? [m.prompt.model, model] : undefined,
    [m.prompt.source, source ? html`<a href="${source}" rel="nofollow noopener" target="_blank">${item.source.author ?? item.source.name} ${icons.external}</a>` : item.source.author ?? item.source.name],
    [m.prompt.license, item.source.license],
    published ? [m.prompt.published, html`<time datetime="${item.publishedAt}">${published}</time>`] : undefined,
    item.skill?.files?.length ? [m.prompt.skillFiles, html`<code>${item.skill.files.join(", ")}</code>`] : undefined,
  ].filter(row => !!row);
  const tags = item.tags.filter(tag => locale.fits(tag) || !cjk.test(tag)).slice(0, 12);
  return html`<section class="details" aria-labelledby="details-heading"><h2 id="details-heading">${m.prompt.details}</h2>
<dl>${rows.map(([label, value]) => html`<div><dt>${label}</dt><dd>${value}</dd></div>`)}</dl>
${tags.length ? html`<ul class="tags" aria-label="${m.prompt.tags}">${tags.map(tag => html`<li><a href="${localePath(locale, "/explore")}?tag=${encodeURIComponent(tag)}">${tag}</a></li>`)}</ul>` : ""}
</section>`;
}

export async function prompt(locale: Locale, id: string, env: Env, ctx: ExecutionContext, client: string | null): Promise<string> {
  const m = locale.messages;
  const detail = await feed<{ item: Item; availableLanguages: string[] }>(env, ctx, `/v3/contents/${id}?locale=${locale.feed}`, 1800, client);
  const { item, translated, original } = localize(detail.item, locale.feed);
  const kind = kindOf(item);
  const creator = item.creator;
  const related = await feed<Page>(env, ctx, `/v3/feed?locale=${locale.feed}&limit=13&sort=latest&${creator ? `creator=${encodeURIComponent(creator.id)}` : `kind=${kind}`}`, 1800, client)
    .then(page => page.items.filter(card => card.id !== id && listable(card) && (!!creator || locale.fits(card.title))).slice(0, 8))
    .catch(() => []);
  const tool = safeLink(item.toolURL);
  const repositoryURL = safeLink(item.skill?.installURL ?? item.skill?.repository);
  const source = safeLink(item.source.url);
  const image = isMedia(item.media?.imageURL) ? item.media!.imageURL : undefined;
  // A language version is worth indexing only when it has a translation or its base title reads naturally there.
  const fits = (l: Locale) => detail.availableLanguages.includes(l.feed) || l.fits(detail.item.title);
  const alternates = locales.filter(fits);
  const indexable = listable(item) && alternates.includes(locale);
  const usage = item.example && item.example.trim() !== item.prompt.trim() ? item.example : "";
  const body = html`<article class="prompt container">
<nav class="crumbs" aria-label="Breadcrumb"><a href="${localePath(locale, "/explore")}">${m.nav.explore}</a>${icons.chevron}<a href="${localePath(locale, `/explore/${kindSlugs[kind]}`)}">${m.kinds.plural[kind]}</a></nav>
<div class="prompt-layout">
<div class="prompt-media">${mediaColumn(locale, item)}</div>
<div class="prompt-main">
<p class="eyebrow">${m.kinds.one[kind]}${modelName(item.model, locale) ? html` · ${modelName(item.model, locale)}` : ""}</p>
<h1 class="prompt-title">${item.title}</h1>
<p class="prompt-summary">${item.summary}</p>
${creator ? html`<a class="byline" href="${localePath(locale, "/explore")}?creator=${encodeURIComponent(creator.id)}">${avatar(creator, 40)}<span><strong>${creator.displayName}</strong>${creator.username ? html`<small>@${creator.username}</small>` : ""}</span></a>` : ""}
<div class="actions">
<button type="button" class="button" data-copy="${translated ? "prompt-translated" : "prompt-original"}" data-copied="${m.prompt.copied}" data-failed="${m.prompt.copyFailed}">${m.prompt.copy}</button>
${tool ? html`<a class="button button-quiet" href="${tool}" rel="noopener" target="_blank">${m.prompt.openTool(hostOf(tool))} ${icons.external}</a>` : ""}
${repositoryURL ? html`<a class="link" href="${repositoryURL}" rel="noopener" target="_blank">${m.prompt.repository}${icons.external}</a>`
    : source ? html`<a class="link" href="${source}" rel="nofollow noopener" target="_blank">${m.prompt.viewSource}${icons.external}</a>` : ""}
<span class="copy-status" role="status" aria-live="polite"></span>
</div>
${promptBlock(locale, item, original, translated)}
${usage ? html`<section class="usage"><h2>${m.prompt.usage}</h2><p>${usage}</p></section>` : ""}
${details(locale, item)}
<p class="report"><a href="${localePath(locale, "/report")}?id=${id}">${m.prompt.report}</a></p>
</div></div>
${related.length ? html`<section class="related" aria-labelledby="related-heading"><h2 id="related-heading" class="subhead">${creator ? m.prompt.moreFrom(creator.displayName) : m.prompt.moreLike}</h2>
<ul class="grid grid-compact">${related.map(entry => card(entry, locale))}</ul></section>` : ""}
</article>`;
  const description = m.meta.promptDescription(item.title, creator?.displayName);
  return page({
    locale, path: `/prompts/${id}`, title: `${item.title} — Prompix`, description,
    image, imageAlt: image ? item.title : undefined, type: "article", noindex: !indexable,
    alternates: alternates.includes(locale) ? alternates : [locale],
    jsonld: [{
      "@context": "https://schema.org", "@graph": [{
        "@type": "CreativeWork", "@id": `${url(locale, `/prompts/${id}`)}#prompt`, name: item.title, headline: item.title,
        description: item.summary, url: url(locale, `/prompts/${id}`), inLanguage: translated ? locale.tag : sourceLanguageTag(original),
        genre: m.kinds.one[kind], keywords: item.tags.join(", "), text: item.prompt,
        ...(image ? { image } : {}),
        ...(item.publishedAt ? { datePublished: item.publishedAt } : {}),
        ...(creator ? { author: { "@type": creator.platform === "web" ? "Organization" : "Person", name: creator.displayName, url: creator.profileURL } } : {}),
        ...(source ? { isBasedOn: source } : {}),
        ...(item.source.license ? { license: item.source.license } : {}),
        ...(translated ? { translationOfWork: { "@type": "CreativeWork", inLanguage: sourceLanguageTag(original) } } : {}),
        publisher: { "@id": organization["@id"] },
      }, {
        "@type": "BreadcrumbList", itemListElement: [
          { "@type": "ListItem", position: 1, name: m.nav.explore, item: url(locale, "/explore") },
          { "@type": "ListItem", position: 2, name: m.kinds.plural[kind], item: url(locale, `/explore/${kindSlugs[kind]}`) },
          { "@type": "ListItem", position: 3, name: item.title },
        ],
      }],
    }],
  }, body, kind === "skill" ? "prompt-page skill" : "prompt-page");
}

