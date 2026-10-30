import { FeedFailure, type Env } from "./feed.ts";
import { kindFromSlug, resolveLocale, type LegalPage, type Locale } from "./i18n.ts";
import { explore, parseExplore } from "./pages/explore.ts";
import { home } from "./pages/home.ts";
import { prompt, promptID } from "./pages/prompt.ts";
import { legal, notFound, removed, unavailable } from "./pages/simple.ts";
import { pagesSitemap, promptsSitemap, robots, sitemapIndex } from "./seo.ts";

const security = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://api.prompix.dev; media-src https://api.prompix.dev; connect-src 'self'; font-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; manifest-src 'self'",
  "Strict-Transport-Security": "max-age=31536000",
};

type Result = { body: string; status?: number; type?: string; ttl: number; locale?: Locale; headers?: Record<string, string> };
const legalPages = new Set<LegalPage>(["support", "privacy", "content", "report"]);
const cache = () => (caches as unknown as { default: Cache }).default;

function respond(request: Request, result: Result) {
  const headers = new Headers({
    "Content-Type": result.type ?? "text/html; charset=utf-8",
    "Cache-Control": result.ttl > 0 ? `public, max-age=${Math.min(result.ttl, 300)}` : "no-store",
    ...security, ...(result.locale ? { "Content-Language": result.locale.tag } : {}), ...result.headers,
  });
  return new Response(request.method === "HEAD" ? null : result.body, { status: result.status ?? 200, headers });
}

const redirect = (location: string, status = 301) => new Response(null, { status, headers: { Location: location, ...security } });

async function route(url: URL, env: Env, ctx: ExecutionContext, client: string | null): Promise<Result | Response> {
  const { pathname, searchParams } = url;
  if (pathname === "/robots.txt") return { body: robots(), type: "text/plain; charset=utf-8", ttl: 86400 };
  if (pathname === "/sitemap.xml") return { body: sitemapIndex(), type: "application/xml; charset=utf-8", ttl: 86400 };
  if (pathname === "/sitemaps/pages.xml") return { body: pagesSitemap(), type: "application/xml; charset=utf-8", ttl: 86400 };
  if (pathname === "/sitemaps/prompts.xml") {
    const { xml, complete } = await promptsSitemap(env, ctx);
    return { body: xml, type: "application/xml; charset=utf-8", ttl: complete ? 21600 : 1800 };
  }
  const { locale, path } = resolveLocale(pathname);
  if (path === "/") return { body: await home(locale, env, ctx, client), ttl: 600, locale };
  const segments = path.split("/").filter(Boolean);
  if (segments[0] === "explore" && segments.length <= 2) {
    const kind = segments[1] ? kindFromSlug(segments[1]) : undefined;
    if (segments[1] && !kind) return { body: notFound(locale, path), status: 404, ttl: 600, locale };
    const result = await explore(locale, parseExplore(searchParams, kind), env, ctx, client);
    if (typeof result !== "string") return redirect(result.redirect, 302);
    return { body: result, ttl: searchParams.has("q") ? 120 : 600, locale };
  }
  if (segments[0] === "prompts" && segments.length === 2 && promptID.test(segments[1])) {
    try {
      return { body: await prompt(locale, segments[1], env, ctx, client), ttl: 1800, locale };
    } catch (error) {
      if (error instanceof FeedFailure && [404, 410].includes(error.status))
        return { body: error.status === 410 ? removed(locale, path) : notFound(locale, path), status: error.status, ttl: 600, locale };
      throw error;
    }
  }
  if (segments.length === 1 && legalPages.has(segments[0] as LegalPage))
    return { body: legal(locale, segments[0] as LegalPage, searchParams), ttl: 3600, locale };
  return { body: notFound(locale, path), status: 404, ttl: 600, locale };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD", ...security } });
    // One canonical form for every page: no trailing slash and no ".html".
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) return redirect(url.pathname.replace(/\/+$/, "") + url.search);
    if (url.pathname.endsWith(".html")) return redirect(url.pathname.replace(/(\/index)?\.html$/, "") || "/");
    if (url.pathname.length > 512 || url.search.length > 2600) return new Response(null, { status: 414, headers: security });

    // Only the production host uses the shared page cache; local previews always render fresh.
    const shared = url.hostname === "prompix.dev";
    const key = new Request(url.toString(), { method: "GET" });
    const hit = shared ? await cache().match(key) : undefined;
    if (hit) {
      // The edge copy lives longer than what browsers may keep.
      const headers = new Headers(hit.headers);
      headers.set("Cache-Control", `public, max-age=${Math.min(Number(headers.get("X-Browser-TTL")) || 60, 300)}`);
      headers.delete("X-Browser-TTL");
      return new Response(request.method === "HEAD" ? null : hit.body, { status: hit.status, headers });
    }

    const { locale, path } = resolveLocale(url.pathname);
    const client = request.headers.get("CF-Connecting-IP");
    let result: Result | Response;
    try {
      result = await route(url, env, ctx, client);
    } catch (error) {
      console.error(JSON.stringify({ event: "site_render_failed", status: error instanceof FeedFailure ? error.status : 0 }));
      return respond(request, { body: unavailable(locale, path), status: 503, ttl: 0, locale, headers: { "Retry-After": "30" } });
    }
    if (result instanceof Response) return result;
    const response = respond(request, result);
    if (shared && result.ttl > 0 && request.method === "GET") {
      const stored = respond(key, result);
      stored.headers.set("Cache-Control", `public, max-age=${result.ttl}`);
      stored.headers.set("X-Browser-TTL", String(result.ttl));
      ctx.waitUntil(cache().put(key, stored).then(() => undefined));
    }
    return response;
  },
} satisfies ExportedHandler<Env>;

