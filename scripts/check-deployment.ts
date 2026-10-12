import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { base, manifestByteLimit, verifyManifest, verifyCatalog } from "../ingest/publication.ts";
import { catalogByteLimit } from "../ingest/library.ts";
import { readResponseBytes } from "../ingest/network.ts";

export async function checkDeployment(fetcher: typeof fetch = fetch) {
  const manifestResponse = await fetcher(`${base}/v1/latest.json`);
  assert.equal(
    manifestResponse.status,
    200,
    "Full downloads must never return 206",
  );
  const manifest = verifyManifest(await readResponseBytes(manifestResponse, manifestByteLimit));
  const response = await fetcher(manifest.catalog);
  assert.equal(response.status, 200);
  const bytes = await readResponseBytes(response, catalogByteLimit);
  const catalog = verifyCatalog(manifest, bytes);
  const etag = response.headers.get("etag");
  assert.ok(etag);
  assert.equal(
    (await fetcher(manifest.catalog, { headers: { "If-None-Match": etag } }))
      .status,
    304,
  );
  assert.equal((await fetcher(`${base}/drafts/private.json`)).status, 404);
  assert.equal(
    (await fetcher(`${base}/v1/latest.json`, { method: "PUT", body: "x" })).status,
    405,
  );
  const video = catalog.prompts.find((p) => p.media?.videoURL)?.media?.videoURL;
  assert.ok(video);
  const partial = await fetcher(video, { headers: { Range: "bytes=0-15" } });
  assert.equal(partial.status, 206);
  assert.equal((await partial.arrayBuffer()).byteLength, 16);
  assert.match(partial.headers.get("content-range") ?? "", /^bytes 0-15\//);
  assert.equal((await fetcher(video, { method: "HEAD" })).status, 200);
  return {
    verified: true,
    version: catalog.version,
    count: catalog.prompts.length,
    checks: [
      "checksum",
      "client-byte-limits",
      "full-body-200",
      "conditional-304",
      "range-206",
      "head",
      "private-path-404",
      "writes-405",
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await checkDeployment()));
}
