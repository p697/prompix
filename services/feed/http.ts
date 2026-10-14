import { ZodError } from "zod";
import { detailResponseByteLimit, feedLocale, feedResponseByteLimit, parseFeedQuery } from "../../packages/schema/feed.ts";
import { FeedError, type Database } from "./database.ts";
import { getBrowse, getCreators, getDetail, getFeed, getRemovals, getState } from "./queries.ts";

export async function serveFeed(request: Request, db: Database, secret: string): Promise<Response> {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" });
  const respond = (value: unknown, status = 200, maxBytes = feedResponseByteLimit) => {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > maxBytes) throw new FeedError("unavailable", 503);
    headers.set("Content-Length", String(Buffer.byteLength(body)));
    return new Response(request.method === "HEAD" ? null : body, { status, headers });
  };
  if (!["GET", "HEAD"].includes(request.method)) {
    headers.set("Allow", "GET, HEAD"); return respond({ error: "method_not_allowed" }, 405);
  }
  const url = new URL(request.url);
  try {
    if (url.href.length > 4096) throw new FeedError("invalid_request", 400);
    if (url.pathname === "/v3/state" || url.pathname === "/v3/health") {
      if (url.search) throw new FeedError("invalid_request", 400);
      return respond(await getState(db));
    }
    if (url.pathname === "/v3/browse") {
      const keys = [...url.searchParams.keys()];
      if (keys.length > 1 || keys.some(key => key !== "locale")) throw new FeedError("invalid_request", 400);
      return respond(await getBrowse(db, feedLocale.parse(url.searchParams.get("locale") ?? "original")));
    }
    if (url.pathname === "/v3/feed") {
      let query: ReturnType<typeof parseFeedQuery>;
      try { query = parseFeedQuery(url); } catch { throw new FeedError("invalid_request", 400); }
      return respond(await getFeed(db, query, secret));
    }
    if (url.pathname === "/v3/creators") {
      if ([...url.searchParams.keys()].some(key => !["q", "limit", "cursor"].includes(key)))
        throw new FeedError("invalid_request", 400);
      let query: ReturnType<typeof parseFeedQuery>;
      try { query = parseFeedQuery(url); } catch { throw new FeedError("invalid_request", 400); }
      return respond(await getCreators(db, { q: query.filters.q, limit: query.limit, cursor: query.cursor }, secret));
    }
    if (url.pathname === "/v3/removals") {
      const keys = [...url.searchParams.keys()];
      if (keys.some(key => key !== "after") || keys.length > 1) throw new FeedError("invalid_request", 400);
      return respond(await getRemovals(db, url.searchParams.get("after") ?? "0"));
    }
    const detail = url.pathname.match(/^\/v3\/contents\/([a-z0-9-]{1,200})$/);
    if (detail) {
      const keys = [...url.searchParams.keys()];
      if (keys.some(key => !["locale", "revision"].includes(key)) || new Set(keys).size !== keys.length)
        throw new FeedError("invalid_request", 400);
      return respond(await getDetail(db, detail[1], feedLocale.parse(url.searchParams.get("locale") ?? "original"),
        url.searchParams.get("revision") ?? undefined), 200, detailResponseByteLimit);
    }
    return respond({ error: "not_found" }, 404);
  } catch (error) {
    const known = error instanceof FeedError ? error : error instanceof ZodError ? new FeedError("invalid_request", 400) : null;
    if (!known || known.status >= 500) console.error(JSON.stringify({ event: "feed_request_failed", path: url.pathname.slice(0, 250) }));
    if (!known || known.status === 503) headers.set("Retry-After", "5");
    return respond({ error: known?.code ?? "unavailable" }, known?.status ?? 503);
  }
}
