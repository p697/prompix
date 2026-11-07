import { html, raw } from "../html.ts";
import { localePath, type LegalPage, type Locale } from "../i18n.ts";
import { page, repository } from "../layout.ts";
import { promptID } from "./prompt.ts";

/** Support, privacy, content and report pages. Only a validated public prompt ID enters the report page. */
export function legal(locale: Locale, name: LegalPage, params: URLSearchParams): string {
  const m = locale.messages;
  const { title, intro, body } = m.legal[name];
  const id = name === "report" ? params.get("id") ?? "" : "";
  const reportID = promptID.test(id) && id.length <= 180 ? id : "";
  const issue = new URL(`${repository}/issues/new?template=content.yml`);
  if (reportID) issue.searchParams.set("content-id", reportID);
  const content = body
    .replace("{{context}}", reportID ? html`<div class="callout"><strong>${m.legal.reportID}</strong><p class="report-id">${reportID}</p></div>`.value : "")
    .replace("{{issue}}", issue.href.replace(/&/g, "&amp;"));
  const updated = name === "privacy" ? m.legal.privacyUpdated : m.legal.updated;
  return page({
    locale, path: `/${name}`, title: `${title.replace(/[.。？?]$/u, "")} — Prompix`, description: intro,
    noindex: !!reportID, search: reportID ? `?id=${reportID}` : "", current: name === "support" ? "support" : undefined,
  }, html`<article class="article container-narrow"><p class="eyebrow">${updated}</p><h1>${title}</h1><p class="intro">${intro}</p>${raw(content)}</article>`, "article-page");
}

export function notFound(locale: Locale, path = "/404"): string {
  const m = locale.messages;
  return page({ locale, path, title: `${m.errors.notFoundTitle} — Prompix`, description: m.errors.notFoundBody, noindex: true },
    html`<section class="message container-narrow"><p class="eyebrow">404</p><h1>${m.errors.notFoundTitle}</h1><p class="intro">${m.errors.notFoundBody}</p>
<p class="cta"><a class="button" href="${localePath(locale, "/")}">${m.errors.home}</a><a class="link" href="${localePath(locale, "/explore")}">${m.nav.explore}</a></p></section>`, "message-page");
}

export function unavailable(locale: Locale, path: string): string {
  const m = locale.messages;
  return page({ locale, path, title: `${m.errors.unavailableTitle} — Prompix`, description: m.errors.unavailableBody, noindex: true },
    html`<section class="message container-narrow"><h1>${m.errors.unavailableTitle}</h1><p class="intro">${m.errors.unavailableBody}</p>
<p class="cta"><a class="button" href="${localePath(locale, path)}">${m.errors.retry}</a><a class="link" href="${localePath(locale, "/")}">${m.errors.home}</a></p></section>`, "message-page");
}

export function removed(locale: Locale, path: string): string {
  const m = locale.messages;
  return page({ locale, path, title: `${m.prompt.unavailable} — Prompix`, description: m.prompt.unavailable, noindex: true },
    html`<section class="message container-narrow"><h1>${m.prompt.unavailable}</h1>
<p class="cta"><a class="button" href="${localePath(locale, "/explore")}">${m.nav.explore}</a></p></section>`, "message-page");
}
