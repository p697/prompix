import assert from "node:assert/strict";
import { Agent, request as httpsRequest } from "node:https";

// A bounded read-only probe: 40 real requests, then invalid requests which must not
// connect to Postgres. Run separately from other probes sharing this client's IP.
const endpoint = "https://api.prompix.dev";
const agent = new Agent({ keepAlive: true, maxSockets: 8 });
const readsOnly = process.argv[2] === "--reads-only";
assert.ok(process.argv.length <= 3 && (!process.argv[2] || readsOnly), "Supported option: --reads-only");
const latencies: number[] = [], statuses: Record<number, number> = {}, locations: Record<string, number> = {};
const timings: { path: string; durationMs: number; tlsMs: number; serverTiming: string | null }[] = [];
let transportFailures = 0;
const started = performance.now();
async function request(path: string) {
  const start = performance.now();
  let tlsMs = 0;
  let response: Response;
  try {
    response = await new Promise<Response>((resolve, reject) => {
      const request = httpsRequest(endpoint + path, { agent, signal: AbortSignal.timeout(20000) }, incoming => {
        const chunks: Buffer[] = []; let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1_000_000) incoming.destroy(new Error("Response exceeds limit"));
          else chunks.push(chunk);
        });
        incoming.on("error", reject);
        incoming.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers))
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
          resolve(new Response(Buffer.concat(chunks).toString("utf8"), { status: incoming.statusCode, headers }));
        });
      });
      request.on("socket", socket => {
        if (socket.connecting) socket.once("secureConnect", () => { tlsMs = Math.round(performance.now() - start); });
      });
      request.on("error", reject); request.end();
    });
  }
  catch { transportFailures++; throw new Error("Transport failed before receiving HTTP response"); }
  const body = await response.json() as { schemaVersion?: number; items?: unknown[]; error?: string };
  latencies.push(performance.now() - start);
  timings.push({ path, durationMs: Math.round(performance.now() - start), tlsMs, serverTiming: response.headers.get("server-timing") });
  statuses[response.status] = (statuses[response.status] ?? 0) + 1;
  const location = response.headers.get("cf-ray")?.split("-").at(-1) ?? "unknown";
  locations[location] = (locations[location] ?? 0) + 1;
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  if (response.status === 429) {
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal(body?.error, "rate_limited");
  }
  return { response, body };
}
async function concurrent(count: number, action: (index: number) => Promise<void>, concurrency = 8) {
  let next = 0;
  const failures: string[] = [];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < count) {
      const index = next++;
      try { await action(index); } catch (error) { failures.push(error instanceof Error ? error.message : "Probe failed"); }
    }
  }));
  if (failures.length) console.log(JSON.stringify({ verified: false, phaseRequests: count, failures, transportFailures, statuses, locations,
    elapsedMs: Math.round(performance.now() - started) }));
  assert.equal(failures.length, 0, "Probe failures recorded above");
}
const paths = ["/v3/feed?limit=30", "/v3/feed?limit=30&locale=zh-Hans", "/v3/feed?q=prompt&limit=30", "/v3/creators?limit=30", "/v3/state"];
await concurrent(40, async index => {
  const { response, body } = await request(paths[index % paths.length]);
  assert.equal(response.status, 200, "Concurrent read failed; allow the IP quota to recover before retrying");
  assert.equal(body?.schemaVersion, 3);
  if (body?.items) assert.ok(body.items.length <= 30);
});
const readTimes = [...latencies].sort((a, b) => a - b);
const slowestRead = [...timings].sort((a, b) => b.durationMs - a.durationMs)[0];
if (!readsOnly) await concurrent(180, async () => {
  const { response } = await request("/v3/feed?limit=0");
  assert.ok([400, 429].includes(response.status));
}, 1);
agent.destroy();
console.log(JSON.stringify({ verified: readsOnly || Boolean(statuses[429]), endpoint, concurrentReads: 40, readConcurrency: 8, invalidRequests: readsOnly ? 0 : 180, invalidConcurrency: 1,
  statuses, readMedianMs: Math.round(readTimes[20]), readP95Ms: Math.round(readTimes[37]), readMaxMs: Math.round(readTimes[39]),
  transportFailures, locations, elapsedMs: Math.round(performance.now() - started), slowestRead,
  recoveryCheckRequiredAfterSeconds: readsOnly ? 0 : 60 }));
assert.ok(readsOnly || statuses[429] > 0, "No rate limit observed; do not claim the distributed limiter was exercised");
