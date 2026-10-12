export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const headers = new Headers({
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    });
    if (!["GET", "HEAD"].includes(request.method))
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    if (url.pathname === "/health")
      return new Response(request.method === "HEAD" ? null : JSON.stringify({ service: "prompix-content", status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    // Only published objects are reachable. Drafts, credentials and logs never leave the Mac.
    const key = url.pathname.slice(1);
    if (
      !/^(v[12]\/latest\.json|releases\/[a-z0-9-]+\/(catalog\.json|v2\/(base\.json|locales\/(en|zh-Hans|zh-Hant|ja|ko|es|fr|de|pt-BR)\.json))|media\/[a-f0-9]{64}\.(jpg|png|webp|mp4))$(?![\s\S])/.test(
        key,
      )
    ) {
      return new Response(request.method === "HEAD" ? null : "Not found", { status: 404, headers });
    }
    try {
      const object = await env.CONTENT.get(key, {
        onlyIf: request.headers,
        ...(request.method === "GET" && request.headers.has("range") ? { range: request.headers } : {}),
      });
      if (!object) return new Response(request.method === "HEAD" ? null : "Not found", { status: 404, headers });
      object.writeHttpMetadata(headers);
      headers.set("ETag", object.httpEtag);
      headers.set("Accept-Ranges", "bytes");
      headers.set(
        "Cache-Control",
        key === "v1/latest.json" || key === "v2/latest.json"
          ? "public, max-age=60"
          : "public, max-age=86400",
      );
      if (!("body" in object))
        return new Response(null, {
          status: request.headers.has("if-none-match") || request.headers.has("if-modified-since") ? 304 : 412,
          headers,
        });
      if (request.method === "HEAD") {
        await object.body.cancel();
        headers.set("Content-Length", String(object.size));
        return new Response(null, { headers });
      }
      let status = 200;
      if (
        request.headers.has("range") &&
        object.range &&
        "offset" in object.range &&
        "length" in object.range
      ) {
        const { offset, length } = object.range;
        if (offset !== undefined && length !== undefined) {
          headers.set(
            "Content-Range",
            `bytes ${offset}-${offset + length - 1}/${object.size}`,
          );
          headers.set("Content-Length", String(length));
          status = 206;
        }
      } else headers.set("Content-Length", String(object.size));
      return new Response(object.body, { status, headers });
    } catch {
      console.error(JSON.stringify({ event: "content_read_failed", key }));
      return new Response(request.method === "HEAD" ? null : "Content temporarily unavailable", {
        status: 503,
        headers,
      });
    }
  },
} satisfies ExportedHandler<Env>;
