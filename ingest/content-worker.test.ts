import assert from "node:assert/strict";
import { test } from "node:test";
import { localizationLanguages } from "../packages/schema/catalog.ts";
import { websiteArtifactByteLimit, websiteContentSecurityPolicy } from "../packages/schema/website-artifact.ts";

type GetOptions = { onlyIf: Headers; range?: Headers };
type Metadata = { size: number; httpEtag: string; range?: { offset: number; length: number }; writeHttpMetadata(headers: Headers): void };
type StoredObject = Metadata | (Metadata & { body: ReadableStream<Uint8Array> });
type Binding = { get(key: string, options: GetOptions): Promise<StoredObject | null> };
// Runtime import keeps the Worker's generated platform types in its own tsconfig.
const worker: { fetch(request: Request, env: { CONTENT: Binding }): Promise<Response> } =
  (await import(new URL("../services/content/index.ts", import.meta.url).href)).default;
const origin = "https://api.prompix.dev";
const version = "edition-1111111111111111";
const examplePath = `/examples/${"a".repeat(64)}.html`;
const payload = "0123456789abcdefghijklmnop";
function fixture(overrides: { size?: number; httpMetadata?: Record<string, string> } = {}) {
  const calls: { key: string; options: GetOptions }[] = [];
  let cancelled = false;
  const content: Binding = {
    async get(key, options) {
      calls.push({ key, options });
      const metadata: Metadata = { size: overrides.size ?? payload.length, httpEtag: '"fixture"',
        writeHttpMetadata(headers) {
          headers.set("Content-Type", "application/json");
          for (const [name, value] of Object.entries(overrides.httpMetadata ?? {})) headers.set(name, value);
        } };
      if (options.onlyIf.get("If-None-Match") === metadata.httpEtag || options.onlyIf.has("If-Match") ||
        options.onlyIf.has("If-Modified-Since") || options.onlyIf.has("If-Unmodified-Since")) return metadata;
      const ranged = options.range?.get("Range") === "bytes=2-5";
      return { ...metadata, ...(ranged ? { range: { offset: 2, length: 4 } } : {}),
        body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(ranged ? payload.slice(2, 6) : payload)); },
          cancel() { cancelled = true; } }) };
    },
  };
  return { calls, content, wasCancelled: () => cancelled,
    request: (path: string, init?: RequestInit) => worker.fetch(new Request(origin + path, init), { CONTENT: content }) };
}

test("Worker serves only published v1, v2, media and example paths with correct caches", async () => {
  const paths = ["/v1/latest.json", "/v2/latest.json", `/releases/${version}/catalog.json`, `/releases/${version}/v2/base.json`,
    ...localizationLanguages.map(locale => `/releases/${version}/v2/locales/${locale}.json`),
    ...["jpg", "png", "webp", "mp4"].map(extension => `/media/${"a".repeat(64)}.${extension}`), examplePath];
  for (const path of paths) {
    const stub = fixture(), response = await stub.request(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("Cache-Control"), path.endsWith("latest.json") ? "public, max-age=60" : "public, max-age=86400");
    assert.equal(response.headers.get("ETag"), '"fixture"');
    assert.equal(response.headers.get("Accept-Ranges"), "bytes");
    assert.equal(response.headers.get("Content-Length"), String(payload.length));
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.deepEqual(stub.calls.map(call => call.key), [path.slice(1)]);
    await response.body?.cancel();
  }
});

test("Worker rejects private files, unsupported locales and path variants before reading R2", async () => {
  const paths = ["/drafts/private.json", "/v2/manifest.json", "/v2/index.json", "/v2/base.json", "/v2/latest.json/", "/v2/LATEST.json",
    `/releases/${version}/v2/manifest.json`, `/releases/${version}/v2/index.json`, `/releases/${version}/v2/locales.json`,
    `/releases/${version}/manifest.json`, `/releases/${version}/v2/locales/ja.json/private.json`,
    `/releases/${version}/v2/locales/%6Aa.json`, `/releases/${version}/v2/locales/ja%2Ejson`,
    `/releases/${version}/v2//base.json`, `/releases/${version}/v2/base.json%0A`, `/releases/${version}/v2/base.json.bak`,
    ...["xx", "en-US", "pt", "zh-hans", "zh_CN", "JA", "ja.json"].map(locale => `/releases/${version}/v2/locales/${locale}.json`),
    ...["UPPER", "edition_1", "edition.1", "edition%2F1", "edition%0A", ""].map(release => `/releases/${release}/v2/base.json`),
    "/examples/index.html", `/examples/${"A".repeat(64)}.html`, `/examples/${"g".repeat(64)}.html`,
    `/examples/${"a".repeat(63)}.html`, `/examples/${"a".repeat(65)}.html`,
    ...["/", ".bak", "%0A", "?preview=1", "#preview"].map(suffix => examplePath + suffix),
    examplePath.replace(".html", ".HTML"), examplePath.replace(".html", "%2Ehtml"),
    examplePath.replace("/examples/", "/examples//"), examplePath.replace("/examples/", "/examples/%61")];
  const stub = fixture();
  for (const path of paths) for (const method of ["GET", "HEAD"]) {
    const response = await stub.request(path, { method });
    assert.equal(response.status, 404, path);
    if (method === "HEAD") assert.equal(response.body, null);
  }
  assert.deepEqual(stub.calls, []);
});

test("Worker rejects write and preflight methods without reading storage", async () => {
  const stub = fixture();
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    for (const path of ["/v1/latest.json", "/v2/latest.json", `/releases/${version}/v2/base.json`, examplePath, "/health"]) {
      const response = await stub.request(path, { method });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("Allow"), "GET, HEAD");
    }
  }
  assert.deepEqual(stub.calls, []);
});

test("Worker preserves GET and HEAD preconditions and never returns a HEAD body", async () => {
  for (const path of ["/v1/latest.json", "/v2/latest.json", `/releases/${version}/v2/locales/ja.json`, examplePath]) {
    for (const method of ["GET", "HEAD"]) {
      for (const [header, value, status] of [["If-None-Match", '"fixture"', 304], ["If-Match", '"different"', 412],
        ["If-Modified-Since", "Sun, 11 Oct 2026 00:00:00 GMT", 304],
        ["If-Unmodified-Since", "Sun, 11 Oct 2026 00:00:00 GMT", 412]] as const) {
        const stub = fixture(), response = await stub.request(path, { method, headers: { [header]: value } });
        assert.equal(response.status, status);
        assert.equal(response.body, null);
        assert.equal(response.headers.get("ETag"), '"fixture"');
        assert.equal(stub.calls[0].options.onlyIf.get(header), value);
      }
    }
    const stub = fixture(), head = await stub.request(path, { method: "HEAD", headers: { Range: "bytes=2-5" } });
    assert.equal(head.status, 200);
    assert.equal(head.body, null);
    assert.equal(head.headers.get("Content-Length"), String(payload.length));
    assert.equal(stub.calls[0].options.range, undefined);
    assert.equal(stub.wasCancelled(), true);
  }
  assert.equal((await fixture().request("/health", { method: "HEAD" })).body, null);
});

test("Website examples force the sandbox and serving headers over stored metadata", async () => {
  const metadata = { "Content-Type": "application/javascript", "Content-Encoding": "gzip", "Content-Disposition": "attachment",
    "Cache-Control": "private, no-cache", "Content-Security-Policy": "default-src *", "Referrer-Policy": "unsafe-url",
    "X-Frame-Options": "SAMEORIGIN", "Permissions-Policy": "camera=*", "X-Content-Type-Options": "unsafe" };
  const requests: RequestInit[] = [{}, { method: "HEAD" }, { headers: { "If-None-Match": '"fixture"' } },
    { headers: { "If-Match": '"different"' } }, { headers: { Range: "bytes=2-5" } }];
  for (const init of requests) {
    const stub = fixture({ httpMetadata: metadata }), response = await stub.request(examplePath, init);
    assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
    assert.equal(response.headers.get("Content-Security-Policy"), websiteContentSecurityPolicy);
    assert.match(response.headers.get("Content-Security-Policy")!, /(?:^|; )sandbox allow-scripts$/);
    assert.doesNotMatch(response.headers.get("Content-Security-Policy")!, /allow-same-origin/);
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(response.headers.get("X-Frame-Options"), "DENY");
    for (const capability of ["camera", "microphone", "geolocation", "payment", "usb", "clipboard-read", "clipboard-write", "display-capture", "fullscreen"])
      assert.ok(response.headers.get("Permissions-Policy")!.split(", ").includes(`${capability}=()`));
    assert.equal(response.headers.get("Content-Encoding"), null);
    assert.equal(response.headers.get("Content-Disposition"), null);
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=86400");
    await response.body?.cancel();
  }
});

test("Website example size limits apply to full objects before ranges or conditional responses", async () => {
  const requestHeaders: HeadersInit[] = [{}, { Range: "bytes=2-5" }, { "If-None-Match": '"fixture"' }];
  for (const method of ["GET", "HEAD"]) {
    for (const headers of requestHeaders) {
      const stub = fixture({ size: websiteArtifactByteLimit + 1 }), response = await stub.request(examplePath, { method, headers });
      assert.equal(response.status, 413);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("Content-Length"), null);
      assert.equal(response.headers.get("Content-Range"), null);
      assert.equal(response.headers.get("ETag"), null);
      assert.equal(stub.wasCancelled(), !new Headers(headers).has("If-None-Match"));
      if (method === "HEAD") assert.equal(response.body, null);
      else assert.equal(await response.text(), "Example exceeds the size limit");
    }
  }
  const accepted = fixture({ size: websiteArtifactByteLimit });
  const head = await accepted.request(examplePath, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Content-Length"), String(websiteArtifactByteLimit));
  assert.equal(accepted.wasCancelled(), true);
  const media = fixture({ size: websiteArtifactByteLimit + 1 });
  assert.equal((await media.request(`/media/${"b".repeat(64)}.mp4`, { method: "HEAD" })).status, 200);
});

test("Website examples preserve range streaming, missing objects and storage failures", async t => {
  const stub = fixture(), range = await stub.request(examplePath, { headers: { Range: "bytes=2-5" } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("Content-Range"), `bytes 2-5/${payload.length}`);
  assert.equal(range.headers.get("Content-Length"), "4");
  const reader = range.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "2345");
  await reader.cancel();
  assert.equal(stub.wasCancelled(), true);
  t.mock.method(console, "error", () => {});
  for (const method of ["GET", "HEAD"]) for (const failure of [false, true]) {
    const response = await worker.fetch(new Request(origin + examplePath, { method }), { CONTENT: { async get() {
      if (failure) throw new Error("Synthetic storage failure");
      return null;
    } } });
    assert.equal(response.status, failure ? 503 : 404);
    assert.equal(response.headers.get("Content-Security-Policy"), websiteContentSecurityPolicy);
    assert.equal(response.headers.get("Cache-Control"), failure ? "no-store" : null);
    if (method === "HEAD") assert.equal(response.body, null);
  }
});

test("Worker streams byte ranges and keeps missing storage distinct from read failures", async t => {
  const stub = fixture(), response = await stub.request(`/releases/${version}/v2/base.json`, { headers: { Range: "bytes=2-5" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("Content-Range"), `bytes 2-5/${payload.length}`);
  assert.equal(response.headers.get("Content-Length"), "4");
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "2345");
  await reader.cancel();
  assert.equal(stub.calls[0].options.range?.get("Range"), "bytes=2-5");
  const request = new Request(`${origin}/v2/latest.json`);
  assert.equal((await worker.fetch(request, { CONTENT: { async get() { return null; } } })).status, 404);
  t.mock.method(console, "error", () => {});
  assert.equal((await worker.fetch(request, { CONTENT: { async get() { throw new Error("Synthetic storage failure"); } } })).status, 503);
  for (const failure of [false, true]) {
    const head = await worker.fetch(new Request(request.url, { method: "HEAD" }), { CONTENT: { async get() {
      if (failure) throw new Error("Synthetic storage failure");
      return null;
    } } });
    assert.equal(head.status, failure ? 503 : 404);
    assert.equal(head.body, null);
  }
});
