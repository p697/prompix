import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDeployment } from "../scripts/check-deployment.ts";
import { localizationLanguages, type Catalog, type Prompt } from "../packages/schema/catalog.ts";
import { languagePackByteLimit, languagePackManifestByteLimit } from "../packages/schema/language-packs.ts";
import { splitLanguagePacks } from "./language-packs.ts";
import { base, digest, serializeCatalog } from "./publication.ts";
import { translationFingerprint } from "./translation.ts";

const video = `${base}/media/${"a".repeat(64)}.mp4`;
const text = { title: "Deployment fixture", summary: "Original synthetic fixture.", prompt: "Keep {{name}} and 中文.", example: "Example", previewLabel: "Preview" };
const item: Prompt = { id: "deployment-fixture", kind: "text", ...text, tags: ["test"], model: "Any", toolURL: null, artwork: "test",
  source: { name: "Prompix", url: null, license: "Original", method: "Written for tests" },
  media: { image: null, video: null, demoURL: null, videoURL: video } };
item.localization = { sourceLanguage: "en", sourceFingerprint: translationFingerprint(item),
  translations: Object.fromEntries(localizationLanguages.map(locale => [locale, { ...text, title: `Fixture ${locale}` }])) };
const catalog: Catalog = { schemaVersion: 1, version: "edition-1111111111111111", publishedAt: "2026-10-01T00:00:00.000Z", prompts: [item] };
const v1Bytes = serializeCatalog(catalog), v1URL = `${base}/releases/${catalog.version}/catalog.json`;
// A healthy v1 pointer may intentionally remain on an earlier complete edition.
const bundle = splitLanguagePacks({ ...catalog, version: "edition-2222222222222222" });
const latest = `${base}/v2/latest.json`;
const urls = [latest, bundle.manifest.base.url, ...Object.values(bundle.manifest.locales).map(value => value.url)];
type Call = { url: string; method: string; headers: Headers; redirect: RequestRedirect | undefined };
function fixture(override?: (call: Call) => Response | undefined) {
  const objects = new Map<string, Uint8Array>([
    [`${base}/v1/latest.json`, Buffer.from(JSON.stringify({ schemaVersion: 1, version: catalog.version, publishedAt: catalog.publishedAt,
      count: catalog.prompts.length, sha256: digest(v1Bytes), catalog: v1URL }))],
    [v1URL, v1Bytes], [latest, bundle.manifestBytes], [bundle.manifest.base.url, bundle.baseBytes],
    ...localizationLanguages.map(locale => [bundle.manifest.locales[locale]!.url, bundle.localeBytes[locale]!] as const),
  ]);
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input), call: Call = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), redirect: init?.redirect };
    calls.push(call);
    const replacement = override?.(call);
    if (replacement) return replacement;
    if (call.method === "PUT") return new Response(null, { status: 405 });
    if (url === video) return call.method === "HEAD" ? new Response(null) : new Response("0123456789abcdef", {
      status: 206, headers: { "Content-Range": "bytes 0-15/100" },
    });
    const bytes = objects.get(url);
    if (!bytes) return new Response(null, { status: 404 });
    const headers = { ETag: `"${digest(Buffer.from(bytes))}"`, "Cache-Control": url.endsWith("latest.json") ? "public, max-age=60" : "public, max-age=86400" };
    if (call.headers.has("If-None-Match")) return new Response(null, { status: 304, headers });
    if (call.method === "HEAD") return new Response(null, { headers });
    return new Response(Buffer.from(bytes), { headers });
  };
  return { calls, fetcher };
}

test("deployment checker validates both independent channels and all nine packs with GET and HEAD conditions", async () => {
  const stub = fixture(), result = await checkDeployment(stub.fetcher, { requireV2: true });
  assert.equal(result.version, catalog.version);
  assert.deepEqual(result.v2, { status: "verified", version: bundle.manifest.version, count: 1, locales: [...localizationLanguages] });
  assert.ok(result.checks.includes("v2-full-join"));
  for (const url of urls) {
    assert.ok(stub.calls.some(call => call.url === url && call.method === "GET" && !call.headers.has("If-None-Match")), url);
    assert.ok(stub.calls.some(call => call.url === url && call.method === "GET" && call.headers.has("If-None-Match")), url);
    assert.ok(stub.calls.some(call => call.url === url && call.method === "HEAD" && !call.headers.has("If-None-Match")), url);
    assert.ok(stub.calls.some(call => call.url === url && call.method === "HEAD" && call.headers.has("If-None-Match")), url);
  }
  assert.ok(stub.calls.every(call => call.redirect === "manual"));
});

test("only a genuine v2 404 permits bootstrap, and requireV2 rejects it", async () => {
  const absent = () => fixture(call => call.url === latest && call.method === "GET" ? new Response(null, { status: 404 }) : undefined);
  assert.deepEqual((await checkDeployment(absent().fetcher)).v2, { status: "absent" });
  await assert.rejects(checkDeployment(absent().fetcher, { requireV2: true }), /v2 is required/);
  for (const status of [206, 301, 302, 403, 500, 503]) {
    const stub = fixture(call => call.url === latest ? new Response("Synthetic failure", { status }) : undefined);
    await assert.rejects(checkDeployment(stub.fetcher), /only 404 permits optional bootstrap/);
  }
  const redirected = fixture(call => {
    if (call.url !== latest) return;
    const response = new Response(null, { status: 404 });
    Object.defineProperty(response, "redirected", { value: true });
    return response;
  });
  await assert.rejects(checkDeployment(redirected.fetcher), /only 404 permits optional bootstrap/);
  await assert.rejects(checkDeployment(fixture(call => { if (call.url === latest) throw new Error("Synthetic network failure"); return undefined; }).fetcher), /network failure/);
});

test("malformed manifests, partial downloads, missing packs and corrupt pack bytes fail closed", async () => {
  const invalidManifest = fixture(call => call.url === latest ? new Response('{"schemaVersion":2}') : undefined);
  await assert.rejects(checkDeployment(invalidManifest.fetcher));
  assert.equal(invalidManifest.calls.some(call => call.url === bundle.manifest.base.url), false);
  for (const url of [bundle.manifest.base.url, bundle.manifest.locales.ja!.url]) {
    for (const status of [206, 404]) await assert.rejects(checkDeployment(fixture(call => call.url === url ? new Response("bad", { status }) : undefined).fetcher), /must return 200/);
    await assert.rejects(checkDeployment(fixture(call => call.url === url ? new Response("corrupt") : undefined).fetcher), /byte count or checksum mismatch/);
  }
});

test("deployment checker enforces decoded caps despite compressed or deceptive lengths", async () => {
  for (const [url, maximum] of [[latest, languagePackManifestByteLimit], [bundle.manifest.base.url, languagePackByteLimit],
    [bundle.manifest.locales.ja!.url, languagePackByteLimit]] as const) {
    let cancelled = false;
    const stub = fixture(call => call.url === url ? new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(maximum + 1)); }, cancel() { cancelled = true; },
    }), { headers: { "Content-Length": "1", "Content-Encoding": "br" } }) : undefined);
    await assert.rejects(checkDeployment(stub.fetcher), /exceeds size limit/);
    assert.equal(cancelled, true);
  }
});

test("all-pack join rejects inconsistent locale identity even when file hash and byte count match", async () => {
  const pack = JSON.parse(Buffer.from(bundle.localeBytes.ja!).toString());
  pack.entries[0].sourceFingerprint = "0".repeat(64);
  const bytes = Buffer.from(JSON.stringify(pack));
  const manifest = structuredClone(bundle.manifest);
  manifest.locales.ja!.sha256 = digest(bytes); manifest.locales.ja!.byteCount = bytes.length;
  const stub = fixture(call => call.url === latest ? new Response(JSON.stringify(manifest))
    : call.url === manifest.locales.ja!.url ? new Response(bytes) : undefined);
  await assert.rejects(checkDeployment(stub.fetcher), /Locale entry identity mismatch/);
});

test("checker rejects incorrect v2 caches and conditional HEAD behavior", async () => {
  const badCache = fixture(call => call.url === latest && call.method === "GET" && !call.headers.has("If-None-Match")
    ? new Response(bundle.manifestBytes.toString(), { headers: { ETag: '"fixture"', "Cache-Control": "public, max-age=86400" } }) : undefined);
  await assert.rejects(checkDeployment(badCache.fetcher), /max-age=60/);
  for (const url of urls) {
    const badHead = fixture(call => call.url === url && call.method === "HEAD" && call.headers.has("If-None-Match") ? new Response(null) : undefined);
    await assert.rejects(checkDeployment(badHead.fetcher), /Conditional HEAD failed/);
  }
});
