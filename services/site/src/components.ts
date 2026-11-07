import { coverImage, isMedia, kindOf, type Card, type Cover, type Creator } from "./feed.ts";
import { html, type Html } from "./html.ts";
import { localePath, type Locale } from "./i18n.ts";
import { icons } from "./layout.ts";

export const promptPath = (locale: Locale, id: string) => localePath(locale, `/prompts/${id}`);

/** Natural pixel size for an image with a known aspect ratio; lets the browser reserve space without inline styles. */
export function dimensions(aspect: number | undefined, width = 800) {
  const ratio = aspect && aspect > 0.2 && aspect < 5 ? aspect : 0.8;
  return { width, height: Math.round(width / ratio) };
}

const hidden = new Set(["unspecified", "未指定"]);
const cjk = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u;
/** Model label, hidden when unspecified or written in a script the page language does not use. */
export const modelName = (model: string, locale: Locale) =>
  hidden.has(model.trim().toLowerCase()) || (cjk.test(model) && !locale.fits(model)) ? "" : model;

export function avatar(creator: Creator, size: number) {
  if (isMedia(creator.avatarURL))
    return html`<img class="avatar" src="${creator.avatarURL}" width="${size}" height="${size}" alt="" loading="lazy" decoding="async">`;
  return html`<span class="avatar avatar-initial" aria-hidden="true">${[...creator.displayName.trim()][0]?.toUpperCase() ?? "P"}</span>`;
}

/** Typographic cover for prompts without media. */
export function cover(card: { title: string; cover?: Cover | null }, kindLabel: string, size: "small" | "large" = "small"): Html {
  const tone = card.cover?.tone ?? "sky";
  return html`<div class="cover cover-${size} tone-${tone}"><span class="cover-eyebrow">${card.cover?.eyebrow ?? kindLabel}</span><span class="cover-text">${card.cover?.text ?? card.title}</span></div>`;
}

export function cardMedia(card: Card, locale: Locale, eager = false): Html {
  const kindLabel = locale.messages.kinds.one[kindOf(card)];
  const image = coverImage(card);
  if (!image) return cover(card, kindLabel);
  const { width, height } = dimensions(card.media?.aspectRatio);
  return html`<img src="${image}" width="${width}" height="${height}" alt="" ${eager ? "" : html`loading="lazy" `}decoding="async">${card.kind === "video" ? html`<span class="play-badge">${icons.play}</span>` : ""}`;
}

/** Grid card used by explore and related lists. */
export function card(item: Card, locale: Locale, eager = false): Html {
  const m = locale.messages;
  const kind = kindOf(item);
  const byline = item.creator?.displayName ?? modelName(item.model, locale);
  return html`<li><a class="card" href="${promptPath(locale, item.id)}">
<div class="card-media${coverImage(item) ? "" : " card-media-cover"}">${cardMedia(item, locale, eager)}</div>
<h3 class="card-title">${item.title}</h3>
<p class="card-meta"><span>${m.kinds.one[kind]}</span>${byline ? html`<span>${byline}</span>` : ""}</p>
</a></li>`;
}

/** Large overlay tile used by the home carousel. */
export function tile(item: Card, locale: Locale): Html {
  const m = locale.messages;
  const image = coverImage(item);
  const kind = kindOf(item);
  return html`<li class="tile${image ? "" : " tile-cover"}"><a href="${promptPath(locale, item.id)}">
<div class="tile-media">${image ? html`<img src="${image}" width="640" height="853" alt="" loading="lazy" decoding="async">` : cover(item, m.kinds.one[kind], "large")}</div>
<div class="tile-text"><p class="tile-eyebrow">${m.kinds.one[kind]}${item.kind === "video" ? html` ${icons.play}` : ""}</p><h3>${item.title}</h3>
${item.creator ? html`<p class="tile-by">${avatar(item.creator, 22)}<span>${item.creator.displayName}</span></p>` : ""}</div>
</a></li>`;
}

export const formatDate = (locale: Locale, value: string | undefined) => {
  const date = value ? new Date(value) : undefined;
  return date && !Number.isNaN(date.getTime()) ? new Intl.DateTimeFormat(locale.tag, locale.messages.dates).format(date) : "";
};

export const formatCount = (locale: Locale, value: number) => new Intl.NumberFormat(locale.tag).format(value);
