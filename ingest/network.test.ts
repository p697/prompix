import { test } from "node:test";
import assert from "node:assert/strict";
import { download } from "./network.ts";

const url = "https://pbs.twimg.com/media/fixture.jpg", hosts = ["pbs.twimg.com"];
test("media GET recovers transport failure and HTTP 503, preserving byte and type checks", async () => {
  let calls = 0; const waits: number[] = [];
  const result = await download(url, hosts, 10, {}, { fetch: async () => {
    calls++;
    if (calls === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    return calls === 2 ? new Response("busy", { status: 503 }) : new Response("image", { headers: { "content-type": "image/jpeg" } });
  }, sleep: async ms => { waits.push(ms); } });
  assert.equal(calls, 3); assert.deepEqual(waits, [1000, 3000]); assert.equal(result.bytes.toString(), "image"); assert.equal(result.type, "image/jpeg");
});
test("HTTP retries respect Retry-After and stop after three reads", async () => {
  let calls = 0; const waits: number[] = [];
  await assert.rejects(download(url, hosts, 10, {}, { fetch: async () => { calls++; return new Response("busy", { status: 429, headers: { "retry-after": "12" } }); },
    sleep: async ms => { waits.push(ms); } }), /429/);
  assert.equal(calls, 3); assert.deepEqual(waits, [12000, 12000]); calls = 0;
  await assert.rejects(download(url, hosts, 10, {}, { fetch: async () => { calls++; return new Response("busy", { status: 429, headers: { "retry-after": "90" } }); },
    sleep: async () => assert.fail("Long provider cooldown must not be ignored") }), /429/);
  assert.equal(calls, 1);
});
test("permanent errors, TLS failures, invalid redirects and size limits never retry", async () => {
  for (const response of [() => new Response("gone", { status: 404 }),
    () => new Response("too large", { headers: { "content-length": "1000" } }),
    () => new Response("too large without declared length"),
    () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } })]) {
    let calls = 0;
    await assert.rejects(download(url, hosts, 2, {}, { fetch: async () => { calls++; return response(); }, sleep: async () => assert.fail("Permanent failure retried") }));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(download(url, hosts, 10, {}, { fetch: async () => { calls++; throw new TypeError("fetch failed", { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } }); },
    sleep: async () => assert.fail("TLS failure retried") }));
  assert.equal(calls, 1);
  await assert.rejects(download("https://evil.example/image.jpg", hosts, 10, {}, { fetch: async () => { calls++; return new Response("bad"); } }), /allowlisted/);
  assert.equal(calls, 1);
});
test("redirect destinations get their own bounded reads after host validation", async () => {
  const paths: string[] = []; let destinationCalls = 0;
  const result = await download(url, hosts, 10, {}, { fetch: async input => {
    const path = new URL(String(input)).pathname; paths.push(path);
    if (path.endsWith("fixture.jpg")) return new Response(null, { status: 302, headers: { location: "/media/final.jpg" } });
    return ++destinationCalls === 1 ? new Response("busy", { status: 502 }) : new Response("ok");
  }, sleep: async () => {} });
  assert.equal(result.bytes.toString(), "ok"); assert.deepEqual(paths, ["/media/fixture.jpg", "/media/final.jpg", "/media/final.jpg"]);
});
