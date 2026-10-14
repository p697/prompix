import { serveFeed } from "./http.ts";
import { connectDatabase } from "./postgres.ts";

function failure(request: Request, error: string, status: number, retry: string) {
  return new Response(request.method === "HEAD" ? null : JSON.stringify({ error }), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*", "Retry-After": retry,
  } });
}

export default {
  async fetch(request, env, ctx) {
    let db: Awaited<ReturnType<typeof connectDatabase>> | undefined;
    const started = performance.now();
    let databaseMs = 0, queries = 0;
    try {
      if (!(await env.REQUEST_LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") ?? "unknown" })).success)
        return failure(request, "rate_limited", 429, "60");
      if (Buffer.byteLength(env.CURSOR_SECRET ?? "") < 32) throw new Error("Missing cursor key");
      // Lazy connection: malformed URLs and unsupported methods do not consume DB connections.
      const response = await serveFeed(request, { async query(sql, parameters) {
        const began = performance.now(); queries++;
        try {
          db ??= await connectDatabase({ connectionString: env.DATABASE.connectionString });
          return await db.query(sql, parameters);
        } finally { databaseMs += performance.now() - began; }
      } }, env.CURSOR_SECRET);
      const durationMs = Math.round(performance.now() - started);
      response.headers.set("Server-Timing", `db;dur=${Math.round(databaseMs)},total;dur=${durationMs}`);
      console.log(JSON.stringify({ event: "feed_response", status: response.status, queries, durationMs,
        databaseMs: Math.round(databaseMs) }));
      return response;
    } catch {
      console.error(JSON.stringify({ event: "feed_connection_failed" }));
      return failure(request, "unavailable", 503, "5");
    } finally {
      if (db) ctx.waitUntil(db.close().catch(() => {
        console.error(JSON.stringify({ event: "feed_connection_close_failed" }));
      }));
    }
  },
} satisfies ExportedHandler<FeedEnv>;
