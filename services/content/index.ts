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
      return Response.json({ service: "prompix-content", status: "ok" });
    // Only published objects are reachable. Drafts, credentials and logs never leave the Mac.
    const key = url.pathname.slice(1);
    if (
      !/^(v1\/latest\.json|releases\/[a-z0-9-]+\/catalog\.json|media\/[a-f0-9]{64}\.(jpg|png|webp|mp4))$/.test(
        key,
      )
    ) {
      return new Response("Not found", { status: 404, headers });
    }
    try {
      const object = await env.CONTENT.get(key, {
        onlyIf: request.headers,
        ...(request.headers.has("range") ? { range: request.headers } : {}),
      });
      if (!object) return new Response("Not found", { status: 404, headers });
      object.writeHttpMetadata(headers);
      headers.set("ETag", object.httpEtag);
      headers.set("Accept-Ranges", "bytes");
      headers.set(
        "Cache-Control",
        key === "v1/latest.json"
          ? "public, max-age=60"
          : "public, max-age=86400",
      );
      if (request.method === "HEAD") {
        headers.set("Content-Length", String(object.size));
        return new Response(null, { headers });
      }
      if (!("body" in object))
        return new Response(null, {
          status: request.headers.has("if-none-match") ? 304 : 412,
          headers,
        });
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
      return new Response("Content temporarily unavailable", {
        status: 503,
        headers,
      });
    }
  },
} satisfies ExportedHandler<Env>;
