import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { catalogSchema } from "../packages/schema/catalog.ts";
const base = "https://api.prompix.dev";
const manifestResponse = await fetch(`${base}/v1/latest.json`);
assert.equal(
  manifestResponse.status,
  200,
  "Full downloads must never return 206",
);
const manifest = (await manifestResponse.json()) as {
  catalog: string;
  sha256: string;
  version: string;
};
assert.ok(manifest.catalog.startsWith(`${base}/releases/`));
const response = await fetch(manifest.catalog);
assert.equal(response.status, 200);
const bytes = Buffer.from(await response.arrayBuffer());
assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.sha256);
const catalog = catalogSchema.parse(JSON.parse(bytes.toString()));
assert.equal(catalog.version, manifest.version);
const etag = response.headers.get("etag");
assert.ok(etag);
assert.equal(
  (await fetch(manifest.catalog, { headers: { "If-None-Match": etag } }))
    .status,
  304,
);
assert.equal((await fetch(`${base}/drafts/private.json`)).status, 404);
assert.equal(
  (await fetch(`${base}/v1/latest.json`, { method: "PUT", body: "x" })).status,
  405,
);
const video = catalog.prompts.find((p) => p.media?.videoURL)?.media?.videoURL;
assert.ok(video);
const partial = await fetch(video, { headers: { Range: "bytes=0-15" } });
assert.equal(partial.status, 206);
assert.equal((await partial.arrayBuffer()).byteLength, 16);
assert.match(partial.headers.get("content-range") ?? "", /^bytes 0-15\//);
assert.equal((await fetch(video, { method: "HEAD" })).status, 200);
console.log(
  JSON.stringify({
    verified: true,
    version: catalog.version,
    count: catalog.prompts.length,
    checks: [
      "checksum",
      "full-body-200",
      "conditional-304",
      "range-206",
      "head",
      "private-path-404",
      "writes-405",
    ],
  }),
);
