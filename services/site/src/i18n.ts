import { en } from "./locales/en.ts";
import { zh } from "./locales/zh.ts";

export type Kind = "text" | "image" | "video";
export type LegalPage = "support" | "privacy" | "content" | "report";
export type LegalPages = Record<LegalPage, { title: string; intro: string; body: string }>;

export interface Messages {
  meta: { homeTitle: string; homeDescription: string; exploreDescription: string; promptDescription: (title: string, creator?: string) => string };
  nav: { label: string; home: string; explore: string; support: string; menu: string; skip: string; language: string };
  hero: { title: string; lead: string; primary: string; secondary: string; wallLabel: string };
  latest: { title: string; all: string; previous: string; next: string };
  kinds: { title: string; browse: string; one: Record<Kind, string>; names: Record<Kind, string>; plural: Record<Kind, string>; lines: Record<Kind, string> };
  stats: { title: (count: string) => string; label: string; items: { value: string; label: string }[] };
  creators: { title: string; lead: string; works: (count: number) => string };
  languages: { title: string; lead: string; original: string };
  iphone: { title: string; lead: string; status: string; follow: string };
  explore: {
    title: string; titles: Record<Kind, string>; all: string; search: string; searchLabel: string; results: (q: string) => string;
    more: string; empty: string; clear: string; by: (name: string) => string; tagged: (tag: string) => string; filters: string;
  };
  prompt: {
    copy: string; copied: string; copyFailed: string; prompt: string; translated: string; original: string; expand: string;
    usage: string; details: string; type: string; model: string; tags: string; source: string; license: string; published: string;
    viewSource: string; profile: string; openTool: (host: string) => string; report: string;
    moreFrom: (name: string) => string; moreLike: string; unavailable: string; previewNote: string;
  };
  footer: { explore: string; prompix: string; project: string; github: string; license: string; note: string; languages: string };
  legal: LegalPages & { updated: string; privacyUpdated: string; reportID: string; supportLink: string; privacyLink: string; contentLink: string; reportLink: string };
  errors: { notFoundTitle: string; notFoundBody: string; unavailableTitle: string; unavailableBody: string; home: string; retry: string };
  dates: Intl.DateTimeFormatOptions;
}

export interface Locale {
  id: string;
  /** URL prefix without trailing slash; the default locale uses "". */
  prefix: string;
  /** BCP 47 tag for <html lang> and hreflang. */
  tag: string;
  /** Locale requested from the content feed. */
  feed: string;
  og: string;
  name: string;
  messages: Messages;
  /** Whether a card or prompt title reads naturally on this locale's pages. */
  fits: (title: string) => boolean;
}

const cjk = /[぀-ヿ㐀-鿿가-힯]/u;
const han = /[㐀-鿿]/u;

/**
 * Supported website locales, in display order. To add a language, add its messages under
 * `locales/`, then register it here; routes, hreflang, sitemaps and the language menu follow.
 */
export const locales: Locale[] = [
  { id: "en", prefix: "", tag: "en", feed: "en", og: "en_US", name: "English", messages: en, fits: title => !cjk.test(title) },
  { id: "zh", prefix: "/zh", tag: "zh-Hans", feed: "zh-Hans", og: "zh_CN", name: "简体中文", messages: zh, fits: title => han.test(title) },
];
export const defaultLocale = locales[0];

/** Splits a pathname into its locale and the locale-independent remainder ("/" for home). */
export function resolveLocale(pathname: string): { locale: Locale; path: string } {
  for (const locale of locales) {
    if (!locale.prefix) continue;
    if (pathname === locale.prefix) return { locale, path: "/" };
    if (pathname.startsWith(locale.prefix + "/")) return { locale, path: pathname.slice(locale.prefix.length) };
  }
  return { locale: defaultLocale, path: pathname };
}

/** Locale-prefixed path; `path` is locale-independent and starts with "/". */
export const localePath = (locale: Locale, path: string) => path === "/" ? (locale.prefix || "/") : locale.prefix + path;

export const kindSlugs: Record<Kind, string> = { image: "images", video: "videos", text: "text" };
/** Categories retired on 2026-11-07; their old pages redirect to Explore. */
export const retiredKindSlugs = ["websites", "skills"];
export const kindFromSlug = (slug: string) => (Object.keys(kindSlugs) as Kind[]).find(kind => kindSlugs[kind] === slug);
