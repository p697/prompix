import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { base, manifestByteLimit, verifyManifest, verifyCatalog } from "../ingest/publication.ts";
import { catalogByteLimit } from "../ingest/library.ts";
import { readResponseBytes } from "../ingest/network.ts";
import { localizationLanguages } from "../packages/schema/catalog.ts";
import { languagePackByteLimit, languagePackManifestByteLimit } from "../packages/schema/language-packs.ts";
import { joinLanguagePacks, verifyLanguagePackManifest, type LocaleBytes } from "../ingest/language-packs.ts";

export async function checkDeployment(fetcher: typeof fetch = fetch, options: { requireV2?: boolean } = {}) {
  // A redirect to a missing page must not be mistaken for an unbootstrapped v2 channel.
  const request = (url: string, init?: RequestInit) => fetcher(url, {
    ...init, redirect: "manual", signal: AbortSignal.timeout(60_000),
  });
  async function verifyHTTP(url: string, response: Response, pointer = false) {
    const etag = response.headers.get("etag");
    assert.ok(etag, `Missing ETag: ${url}`);
    assert.equal(response.headers.get("cache-control"), pointer ? "public, max-age=60" : "public, max-age=86400");
    const conditional = await request(url, { headers: { "If-None-Match": etag } });
    assert.equal(conditional.status, 304, `Conditional GET failed: ${url}`);
    assert.equal(conditional.headers.get("etag"), etag);
    const head = await request(url, { method: "HEAD" });
    assert.equal(head.status, 200, `HEAD failed: ${url}`);
    assert.equal(head.body, null, `HEAD returned a body: ${url}`);
    assert.equal(head.headers.get("etag"), etag);
    const conditionalHead = await request(url, { method: "HEAD", headers: { "If-None-Match": etag } });
    assert.equal(conditionalHead.status, 304, `Conditional HEAD failed: ${url}`);
  }
  const manifestResponse = await request(`${base}/v1/latest.json`);
  assert.equal(
    manifestResponse.status,
    200,
    "Full downloads must never return 206",
  );
  const manifest = verifyManifest(await readResponseBytes(manifestResponse, manifestByteLimit));
  const response = await request(manifest.catalog);
  assert.equal(response.status, 200);
  const bytes = await readResponseBytes(response, catalogByteLimit);
  const catalog = verifyCatalog(manifest, bytes);
  await verifyHTTP(`${base}/v1/latest.json`, manifestResponse, true);
  await verifyHTTP(manifest.catalog, response);

  const v2Response = await request(`${base}/v2/latest.json`);
  let v2: { status: "absent" } | { status: "verified"; version: string; count: number; locales: string[] };
  if (v2Response.status === 404 && !v2Response.redirected) {
    await v2Response.body?.cancel();
    assert.ok(!options.requireV2, "v2 is required but /v2/latest.json returned 404");
    v2 = { status: "absent" };
  } else {
    assert.equal(v2Response.status, 200, "v2 latest must return 200 (only 404 permits optional bootstrap)");
    const manifestBytes = await readResponseBytes(v2Response, languagePackManifestByteLimit);
    const languageManifest = verifyLanguagePackManifest(manifestBytes);
    const baseResponse = await request(languageManifest.base.url);
    assert.equal(baseResponse.status, 200, "Full v2 base downloads must return 200");
    const baseBytes = await readResponseBytes(baseResponse, languagePackByteLimit);
    const localeBytes: LocaleBytes = {};
    const artifacts = [{ url: languageManifest.base.url, response: baseResponse }];
    for (const locale of localizationLanguages) {
      const descriptor = languageManifest.locales[locale];
      if (!descriptor) continue;
      const packResponse = await request(descriptor.url);
      assert.equal(packResponse.status, 200, `Full ${locale} downloads must return 200`);
      localeBytes[locale] = await readResponseBytes(packResponse, languagePackByteLimit);
      artifacts.push({ url: descriptor.url, response: packResponse });
    }
    const joined = joinLanguagePacks(manifestBytes, baseBytes, localeBytes);
    await verifyHTTP(`${base}/v2/latest.json`, v2Response, true);
    for (const artifact of artifacts) await verifyHTTP(artifact.url, artifact.response);
    for (const path of ["manifest.json", "index.json", "locales/en-US.json"]) {
      assert.equal((await request(`${base}/releases/${languageManifest.version}/v2/${path}`)).status, 404);
    }
    v2 = { status: "verified", version: joined.version, count: joined.prompts.length, locales: Object.keys(localeBytes) };
  }
  assert.equal((await request(`${base}/drafts/private.json`)).status, 404);
  for (const channel of ["v1", "v2"]) {
    assert.equal((await request(`${base}/${channel}/latest.json`, { method: "PUT", body: "x" })).status, 405);
  }
  const video = catalog.prompts.find((p) => p.media?.videoURL)?.media?.videoURL;
  assert.ok(video);
  const partial = await request(video, { headers: { Range: "bytes=0-15" } });
  assert.equal(partial.status, 206);
  assert.equal((await readResponseBytes(partial, 16)).byteLength, 16);
  assert.match(partial.headers.get("content-range") ?? "", /^bytes 0-15\//);
  assert.equal((await request(video, { method: "HEAD" })).status, 200);
  return {
    verified: true,
    version: catalog.version,
    count: catalog.prompts.length,
    v2,
    checks: [
      "checksum",
      "client-byte-limits",
      "full-body-200",
      "conditional-304",
      "range-206",
      "head",
      "private-path-404",
      "writes-405",
      ...(v2.status === "verified" ? ["v2-all-packs", "v2-full-join", "v2-conditional-head"] : ["v2-not-bootstrapped"]),
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--require-v2")) throw new Error("Usage: npm run check:deployment -- [--require-v2]");
  console.log(JSON.stringify(await checkDeployment(fetch, { requireV2: args.includes("--require-v2") })));
}
