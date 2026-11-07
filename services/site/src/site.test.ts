import assert from "node:assert/strict";
import { test } from "node:test";
import type { Card, Env, Item } from "./feed.ts";
import { listable, localize } from "./feed.ts";
import { html, jsonScript, raw } from "./html.ts";
import { localePath, locales, resolveLocale } from "./i18n.ts";
import { parseExplore } from "./pages/explore.ts";
import { legal } from "./pages/simple.ts";
import { cardLocales } from "./seo.ts";
import worker from "./worker.ts";

const [en, zh] = locales;
const media = (id: string) => `https://api.prompix.dev/media/${id}.jpg`;

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: "sample", kind: "image", contentType: "prompt", title: "A quiet orange", summary: "Summary", tags: ["still life"],
    model: "GPT Image 2", previewLabel: "Source image", media: { imageURL: media("a"), aspectRatio: 0.8 },
    language: "en", availableLanguages: ["en", "zh-Hans"], presentation: "general", ...overrides,
  };
}

function item(overrides: Partial<Item> = {}): Item {
  return {
    ...card(), title: "一颗橘子", prompt: "Photograph an orange <b>", example: "Use warm light", toolURL: null,
    source: { name: "X", url: "https://x.com/i/web/status/1", license: "CC-BY-4.0", method: "API" },
    localization: { sourceLanguage: "en", translations: { en: {
      title: "An orange", summary: "Warm", prompt: "Photograph an orange <b>", example: "Use warm light", previewLabel: "Source image" } } },
    ...overrides,
  };
}

test("html escapes interpolations and JSON-LD cannot close its script", () => {
  assert.equal(html`<p title="${'"x"'}">${"<script>"}</p>`.value, '<p title="&quot;x&quot;">&lt;script&gt;</p>');
  assert.equal(html`${raw("<b>")}${["<", 1, null, false]}`.value, "<b>&lt;1");
  assert.ok(!jsonScript({ text: "</script><script>alert(1)" }).value.includes("</script><script>"));
});

test("locale routing keeps the default locale unprefixed", () => {
  assert.deepEqual(resolveLocale("/zh"), { locale: zh, path: "/" });
  assert.deepEqual(resolveLocale("/zh/prompts/a"), { locale: zh, path: "/prompts/a" });
  assert.deepEqual(resolveLocale("/zhx"), { locale: en, path: "/zhx" });
  assert.equal(localePath(en, "/"), "/");
  assert.equal(localePath(zh, "/"), "/zh");
  assert.equal(localePath(zh, "/support"), "/zh/support");
});

test("every locale provides the same message keys", () => {
  const keys = (value: object): string[] => Object.entries(value).flatMap(([key, child]) =>
    child && typeof child === "object" && !Array.isArray(child) ? keys(child).map(sub => `${key}.${sub}`) : [key]);
  for (const locale of locales.slice(1)) assert.deepEqual(keys(locale.messages).sort(), keys(locales[0].messages).sort());
});

test("translations apply metadata even when the prompt is already in that language", () => {
  const shown = localize(item(), "en");
  assert.equal(shown.item.title, "An orange");
  assert.equal(shown.translated, false);
  const other = localize(item({ localization: { sourceLanguage: "zh", translations: { en: {
    title: "An orange", summary: "Warm", prompt: "Translated", example: "e", previewLabel: "p" } } } }), "en");
  assert.equal(other.translated, true);
  assert.equal(localize(item(), "ja").item.title, "一颗橘子");
});

test("lists show reviewed visuals and any prompt without a visual", () => {
  assert.equal(listable(card()), true);
  assert.equal(listable(card({ presentation: "suggestive" })), false);
  assert.equal(listable(card({ presentation: "unknown" })), false);
  assert.equal(listable(card({ presentation: undefined, media: null })), true);
  assert.equal(listable(card({ presentation: "unknown", media: { imageURL: "https://example.com/a.jpg" } })), true);
});

test("sitemap languages follow translations or a naturally fitting title", () => {
  assert.deepEqual(cardLocales(card({ title: "一颗橘子", availableLanguages: [] })), [zh]);
  assert.deepEqual(cardLocales(card({ title: "An orange", availableLanguages: ["zh-Hans"] })), [en, zh]);
  assert.deepEqual(cardLocales(card({ title: "Orange", availableLanguages: [] })), [en]);
});

test("explore queries are bounded and stripped of control characters", () => {
  const query = parseExplore(new URLSearchParams({ q: "  one\ttwo three four five six seven eight nine ", creator: "x".repeat(300) }));
  assert.equal(query.q, "one two three four five six seven eight");
  assert.equal(query.creator?.length, 200);
  assert.equal(parseExplore(new URLSearchParams({ after: "x".repeat(3000) })).after, undefined);
});

test("report page shows only a valid public prompt ID", () => {
  const valid = legal(en, "report", new URLSearchParams({ id: "gentle-tarot" }));
  assert.match(valid, /class="report-id">gentle-tarot</);
  assert.match(valid, /template=content\.yml&amp;content-id=gentle-tarot/);
  assert.match(valid, /noindex/);
  const hostile = legal(en, "report", new URLSearchParams({ id: '"><script>alert(1)</script>' }));
  assert.ok(!hostile.includes("<script>alert"));
  assert.ok(!hostile.includes("report-id"));
  assert.ok(!legal(zh, "privacy", new URLSearchParams()).includes("{{"));
});

function fakeEnv(routes: Record<string, unknown>): Env {
  const respond = (request: Request) => {
    const url = new URL(request.url);
    const key = Object.keys(routes).find(prefix => (url.pathname + url.search).startsWith(prefix));
    return key ? Response.json(routes[key]) : Response.json({ error: "not_found" }, { status: 404 });
  };
  return { FEED: { fetch: async (input: RequestInfo) => respond(input as Request) } as unknown as Fetcher, ASSETS: {} as Fetcher };
}
const memoryCache = { match: async () => undefined, put: async () => undefined };
(globalThis as unknown as { caches: unknown }).caches = { default: memoryCache };
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const get = (env: Env, path: string) => worker.fetch!(new Request(`https://prompix.dev${path}`) as never, env, ctx);

test("pages render from the feed with canonical, hreflang and structured data", async () => {
  const env = fakeEnv({
    "/v3/contents/sample": { item: item(), availableLanguages: ["en", "zh-Hans"] },
    "/v3/feed": { items: [card(), card({ id: "b", title: "Hidden", presentation: "suggestive" })], nextCursor: null },
    "/v3/state": { count: 3130 },
  });
  const detail = await get(env, "/prompts/sample");
  assert.equal(detail.status, 200);
  const page = await detail.text();
  assert.match(page, /<link rel="canonical" href="https:\/\/prompix\.dev\/prompts\/sample">/);
  assert.match(page, /hreflang="zh-Hans" href="https:\/\/prompix\.dev\/zh\/prompts\/sample"/);
  assert.match(page, /"@type":"CreativeWork"/);
  assert.match(page, /<h1 class="prompt-title">An orange<\/h1>/);
  assert.match(page, /Photograph an orange &lt;b&gt;/);
  assert.ok(detail.headers.get("Content-Security-Policy")?.includes("frame-ancestors 'none'"));

  const list = await (await get(env, "/explore/images")).text();
  assert.match(list, /href="\/prompts\/sample"/);
  assert.ok(!list.includes('href="/prompts/b"'));

  assert.equal((await get(env, "/prompts/missing")).status, 404);
  assert.equal((await get(env, "/explore/unknown")).status, 404);
  assert.equal((await get(env, "/support/")).headers.get("Location"), "/support");
  const home = await get(env, "/zh");
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<html lang="zh-Hans">/);
});

test("feed outages render a retryable page instead of an error", async () => {
  const env = { FEED: { fetch: async () => new Response("{}", { status: 503 }) } as unknown as Fetcher, ASSETS: {} as Fetcher };
  const response = await get(env, "/prompts/sample");
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "30");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("the retired website and skill categories redirect to explore and no longer appear", async () => {
  const env = fakeEnv({ "/v3/feed": { items: [card()], nextCursor: null }, "/v3/state": { count: 3130 } });
  for (const [path, target] of [["/explore/websites", "/explore"], ["/zh/explore/skills", "/zh/explore"]]) {
    const response = await get(env, path);
    assert.equal(response.status, 301); assert.equal(response.headers.get("Location"), target);
  }
  const explore = await (await get(env, "/explore")).text();
  assert.ok(!/websites|skills/i.test(explore.match(/<nav class="segments"[\s\S]*?<\/nav>/)?.[0] ?? ""));
  const support = legal(zh, "support", new URLSearchParams());
  assert.ok(!support.includes("Skill"));
  assert.match(legal(zh, "report", new URLSearchParams()), /24 小时内/);
});
