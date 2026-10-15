import { test } from "node:test";
import assert from "node:assert/strict";
import { createReleaseTransport } from "./release-publication.ts";

const url = "https://api.prompix.dev/v2/latest.json";
function connectionFailure() {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }) });
}
test("publication GET retries nested fetch failures with bounded backoff", async () => {
  let calls = 0; const delays: number[] = [];
  const transport = createReleaseTransport({ fetcher: (async (input, init) => {
    assert.equal(input, url); assert.equal(init?.redirect, "error");
    if (++calls < 4) throw connectionFailure();
    return new Response("complete");
  }) as typeof fetch, sleep: async ms => { delays.push(ms); } });
  const result = await transport.read(url, 100);
  assert.equal(result.status, 200);
  if (result.status === 200) assert.equal(result.bytes.toString(), "complete");
  assert.equal(calls, 4); assert.deepEqual(delays, [1000, 3000, 8000]);
});
test("publication GET retries throttling and transient server responses and cancels their bodies", async () => {
  let cancelled = 0, calls = 0;
  const transport = createReleaseTransport({ fetcher: (async () => {
    if (++calls <= 2) return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: calls === 1 ? 429 : 503 });
    return new Response("verified");
  }) as typeof fetch, sleep: async () => {} });
  assert.equal((await transport.read(url, 100)).status, 200);
  assert.equal(calls, 3); assert.equal(cancelled, 2);
});
test("publication GET retries a reset during the body without concatenating partial attempts", async () => {
  let calls = 0;
  const transport = createReleaseTransport({ fetcher: (async () => {
    if (++calls === 1) return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("partial")); c.error(connectionFailure()); } }));
    return new Response("complete");
  }) as typeof fetch, sleep: async () => {} });
  const result = await transport.read(url, 100);
  assert.equal(result.status, 200);
  if (result.status === 200) assert.equal(result.bytes.toString(), "complete");
  assert.equal(calls, 2);
});
test("publication GET does not retry auth, redirects, certificates, malformed responses or size violations", async () => {
  for (const value of [401, 403, 302, new TypeError("invalid request"), Object.assign(new Error("certificate failed"), { code: "CERT_HAS_EXPIRED" }), "oversized", "empty"]) {
    let calls = 0;
    const transport = createReleaseTransport({ fetcher: (async () => {
      calls++;
      if (value instanceof Error) throw value;
      if (typeof value === "number") return new Response("failure", { status: value });
      return value === "empty" ? new Response(null) : new Response("too large");
    }) as typeof fetch, sleep: async () => assert.fail("Permanent failures must not retry") });
    await assert.rejects(transport.read(url, 4), /Publication read failed.*after 1 attempt/);
    assert.equal(calls, 1);
  }
});
test("publication GET preserves missing-artifact handling and refuses untrusted hosts", async () => {
  let calls = 0;
  const transport = createReleaseTransport({ fetcher: (async () => { calls++; return new Response(null, { status: 404 }); }) as typeof fetch });
  assert.deepEqual(await transport.read(url, 100), { status: 404 });
  await assert.rejects(transport.read("https://untrusted.example/v2/latest.json", 100), /Untrusted/);
  assert.equal(calls, 1);
});
test("exhausted publication reads retain the original cause and omit query credentials from diagnostics", async () => {
  let calls = 0; const failure = connectionFailure();
  const transport = createReleaseTransport({ fetcher: (async () => { calls++; throw failure; }) as typeof fetch, sleep: async () => {} });
  await assert.rejects(transport.read(url + "?token=private-value", 100), error => {
    assert.ok(error instanceof Error); assert.equal(error.cause, failure);
    assert.match(error.message, /api.prompix.dev\/v2\/latest.json after 4 attempt/);
    assert.ok(!error.message.includes("private-value")); return true;
  });
  assert.equal(calls, 4);
});
