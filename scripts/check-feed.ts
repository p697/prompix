import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { feedPageSchema, feedDetailSchema } from "../packages/schema/feed.ts";
import { preparePublication, type PublicationInput } from "../services/feed/publication.ts";
import { publicationIdentity } from "../ingest/release-publication.ts";
import { validateArtifact } from "../ingest/language-packs.ts";

const [sourcePath, origin = "https://api.prompix.dev"] = process.argv.slice(2);
if (!sourcePath || process.argv.length > 4 || !["https://api.prompix.dev", "https://prompix-feed.clawket.workers.dev"].includes(origin))
  throw new Error("Usage: npm run check:feed -- /external/verified-catalog.json [https://api.prompix.dev]");
const source = JSON.parse(await readFile(sourcePath, "utf8")) as PublicationInput;
const expected = preparePublication(source), measurements: number[] = [];
let maximumPageBytes = 0;
async function request(path: string, status = 200, method = "GET"): Promise<unknown> {
  const started = performance.now(), response = await fetch(origin + path, { method, redirect: "error", signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, status, path);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const bytes = await response.arrayBuffer();
  measurements.push(Math.round(performance.now() - started));
  if (path.startsWith("/v3/feed?")) {
    assert.ok(bytes.byteLength <= 1_000_000); maximumPageBytes = Math.max(maximumPageBytes, bytes.byteLength);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
const byID = new Map(expected.records.map(row => [row.content_id, row]));
for (const locale of ["original", "zh-Hans"] as const) for (const sort of ["curated", "latest"] as const) {
  const ids: string[] = []; let cursor: string | null = null, pages = 0;
  do {
    const query = new URLSearchParams({ limit: "50", locale, sort }); if (cursor) query.set("cursor", cursor);
    const page = validateArtifact(feedPageSchema, await request("/v3/feed?" + query));
    assert.equal(page.release, expected.id);
    for (const card of page.items) {
      const row = sort === "curated" ? expected.records[ids.length] : byID.get(card.id); assert.ok(row, "Unexpected feed row");
      const expectedCard = row.translations.find(item => item.locale === locale)?.card ?? row.card;
      assert.equal(publicationIdentity(card), publicationIdentity(expectedCard)); ids.push(card.id);
    }
    assert.notEqual(page.nextCursor, cursor || "never-a-cursor"); cursor = page.nextCursor;
    assert.ok(++pages <= 2001, "Pagination did not terminate");
  } while (cursor);
  const expectedIDs = source.prompts.map(item => item.id);
  assert.deepEqual(sort === "curated" ? ids : [...ids].sort(), sort === "curated" ? expectedIDs : expectedIDs.sort());
  assert.equal(new Set(ids).size, ids.length);
}
const latest = validateArtifact(feedPageSchema, await request("/v3/feed?sort=latest&limit=50"));
if (latest.nextCursor) await request("/v3/feed?" + new URLSearchParams({ sort: "curated", limit: "50", cursor: latest.nextCursor }), 400);
const richest = [...expected.records].sort((a, b) => b.translations.length - a.translations.length)[0];
for (const locale of ["original", ...richest.languages]) {
  const detail = validateArtifact(feedDetailSchema, await request(`/v3/contents/${richest.content_id}?revision=${richest.id}&locale=${locale}`));
  const translation = richest.translations.find(item => item.locale === locale)?.content;
  const original = richest.original;
  const item = { ...original, ...(original.localization ? { localization: { ...original.localization, translations: translation ? { [locale]: translation } : {} } } : {}) };
  assert.equal(publicationIdentity(detail.item), publicationIdentity(item)); assert.equal(detail.revision, richest.id);
}
const removed: string[] = []; let after = "0", more = false;
do {
  const page = await request(`/v3/removals?after=${after}`) as { items: { id: string; sequence: string }[]; nextAfter: string; hasMore: boolean };
  assert.ok(page.items.length <= 500);
  for (const item of page.items) { assert.ok(BigInt(item.sequence) > BigInt(after)); after = item.sequence; removed.push(item.id); }
  assert.equal(page.nextAfter, after); more = page.hasMore;
  assert.ok(!more || page.items.length > 0);
} while (more);
assert.deepEqual(removed.sort(), [...(source.removedIDs ?? [])].sort());
if (removed[0]) await request(`/v3/contents/${removed[0]}`, 410);
await request("/v3/feed?limit=51", 400);
await request("/v3/feed?limit=1&limit=2", 400);
await request("/v3/feed", 405, "POST");
measurements.sort((a, b) => a - b);
console.log(JSON.stringify({ verified: true, origin, release: expected.id, items: source.prompts.length,
  requests: measurements.length, maximumPageBytes, medianMs: measurements[Math.floor(measurements.length / 2)],
  p95Ms: measurements[Math.min(measurements.length - 1, Math.ceil(measurements.length * 0.95) - 1)], maxMs: measurements.at(-1) }));
