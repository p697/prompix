import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { catalogSchema, type Catalog, type Prompt } from "../packages/schema/catalog.ts";
import { atomic, base, digest, json, manifestByteLimit, manifestSchema, remoteCatalog, rollbackCatalog,
  serializeCatalog, verifyCatalog, verifyManifest, writeCatalog, type Manifest } from "./publication.ts";
import { catalogByteLimit } from "./library.ts";
import { readResponseBytes } from "./network.ts";
import { recoverRelease, type RecoveryTransport } from "./recovery.ts";
import { checkDeployment } from "../scripts/check-deployment.ts";

const item: Prompt = { id: "capacity-fixture", kind: "text", title: "容量测试", summary: "An original capacity fixture.",
  prompt: "Preserve  two spaces.\nKeep the next line and 中文。", example: "Original example.", tags: ["test"], model: "Any",
  toolURL: null, artwork: "test", previewLabel: "Test", source: { name: "Prompix", url: null, license: "Original", method: "Test fixture" }, media: null };
const fixture: Catalog = { schemaVersion: 1, version: "edition-1111111111111111", publishedAt: "2026-10-01T00:00:00.000Z", removedIDs: [], prompts: [item] };
const pretty = (catalog: Catalog) => Buffer.from(JSON.stringify(catalog, null, 2) + "\n");
const manifestFor = (catalog: Catalog, bytes: Buffer): Manifest => manifestSchema.parse({ schemaVersion: 1, version: catalog.version,
  publishedAt: catalog.publishedAt, count: catalog.prompts.length, sha256: digest(bytes), catalog: `${base}/releases/${catalog.version}/catalog.json` });

function catalogOfSize(size: number): Catalog {
  const result = catalogSchema.parse({ ...fixture, prompts: [{ ...item, example: "x" }] });
  const payloadBytes = size - Buffer.byteLength(JSON.stringify(result) + "\n") + 1;
  result.prompts[0].example = "文".repeat(Math.floor(payloadBytes / 3)) + "x".repeat(payloadBytes % 3);
  return result;
}

test("compact catalog preserves multilingual content and measures the exact UTF-8 boundary", () => {
  const bytes = serializeCatalog(fixture);
  assert.deepEqual(JSON.parse(bytes.toString()), fixture);
  assert.equal(bytes.toString().endsWith("\n"), true);
  assert.ok(bytes.length < pretty(fixture).length);
  const atLimit = catalogOfSize(catalogByteLimit);
  const exact = serializeCatalog(atLimit);
  assert.equal(exact.length, 10_000_000);
  assert.deepEqual(verifyCatalog(manifestFor(atLimit, exact), exact), atLimit);
  const over = catalogOfSize(catalogByteLimit + 1);
  const oversize = Buffer.from(JSON.stringify(over) + "\n");
  assert.ok(oversize.toString().length < catalogByteLimit, "Character count must not replace UTF-8 bytes");
  assert.throws(() => serializeCatalog(over), /10000001 bytes.*10000000-byte/);
  assert.throws(() => verifyCatalog(manifestFor(over, oversize), oversize), /10000001 bytes.*10000000-byte/);
});

test("new files are compact while existing pretty releases retain every byte, hash and timestamp", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-catalog-format-"));
  try {
    const freshPath = join(root, "new", "catalog.json");
    const fresh = await writeCatalog(freshPath, fixture);
    assert.deepEqual(await readFile(freshPath), serializeCatalog(fixture));
    assert.equal(digest(fresh.bytes), digest(await readFile(freshPath)));
    const oldPath = join(root, "old", "catalog.json");
    await atomic(oldPath, fixture);
    const before = await readFile(oldPath), beforeStat = await stat(oldPath);
    const retry = { ...fixture, publishedAt: "2026-10-12T00:00:00.000Z" };
    const reused = await writeCatalog(oldPath, retry, { reuseExistingPublishedAt: true });
    assert.deepEqual(reused.bytes, before);
    assert.equal(digest(reused.bytes), digest(before));
    assert.equal(reused.catalog.publishedAt, fixture.publishedAt);
    assert.deepEqual(await readFile(oldPath), before);
    assert.equal((await stat(oldPath)).mtimeMs, beforeStat.mtimeMs);
    await assert.rejects(writeCatalog(oldPath, retry), /different content/);
    await assert.rejects(writeCatalog(oldPath, { ...fixture, prompts: [{ ...item, prompt: item.prompt + " Changed." }] },
      { reuseExistingPublishedAt: true }), /different content/);
    assert.deepEqual(await readFile(oldPath), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an oversized existing edition is refused without rewriting it to a smaller encoding", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-catalog-large-"));
  try {
    const path = join(root, "catalog.json");
    const valid = pretty(fixture);
    const padded = Buffer.concat([valid, Buffer.alloc(catalogByteLimit + 1 - valid.length, " ")]);
    await writeFile(path, padded);
    await assert.rejects(writeCatalog(path, fixture), /10000001 bytes.*10000000-byte/);
    assert.deepEqual(await readFile(path), padded);
    const newPath = join(root, "new", "catalog.json");
    await assert.rejects(writeCatalog(newPath, catalogOfSize(catalogByteLimit + 1)), /10000001 bytes/);
    await assert.rejects(stat(newPath), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent immutable creation cannot replace the winner or leave a partial catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-catalog-race-"));
  try {
    const path = join(root, "catalog.json");
    const changed = { ...fixture, prompts: [{ ...item, title: "Different original fixture" }] };
    const outcomes = await Promise.allSettled([writeCatalog(path, fixture), writeCatalog(path, changed)]);
    const success = outcomes.filter(result => result.status === "fulfilled");
    assert.equal(success.length, 1);
    assert.equal(outcomes.filter(result => result.status === "rejected").length, 1);
    assert.deepEqual(await readFile(path), success[0].value.bytes);
    assert.deepEqual(await readdir(root), ["catalog.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("decoded stream bytes cannot bypass limits with compressed, missing or incorrect lengths", async () => {
  const cases: Record<string, string>[] = [{}, { "Content-Length": "1" }, { "Content-Length": "1", "Content-Encoding": "br" }];
  for (const headers of cases) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.alloc(6)); controller.enqueue(Buffer.alloc(5)); },
      cancel() { cancelled = true; } });
    await assert.rejects(readResponseBytes(new Response(stream, { headers }), 10), /exceeds size limit/);
    assert.equal(cancelled, true);
  }
  assert.equal((await readResponseBytes(new Response("中文xy"), 8)).length, 8);
  const bytes = Buffer.from(JSON.stringify(manifestFor(fixture, serializeCatalog(fixture))));
  assert.deepEqual(verifyManifest(bytes), manifestFor(fixture, serializeCatalog(fixture)));
  assert.throws(() => verifyManifest(Buffer.concat([bytes, Buffer.alloc(manifestByteLimit + 1, " ")])), /32000-byte/);
});

test("remote verification rejects a formerly readable 10–20 MB artifact before accepting its hash", async t => {
  const catalog = catalogOfSize(catalogByteLimit + 1), bytes = Buffer.from(JSON.stringify(catalog) + "\n");
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL) => {
    requests.push(String(url));
    return new Response(bytes.toString(), { headers: { "Content-Encoding": "br", "Content-Length": "100" } });
  });
  await assert.rejects(remoteCatalog(manifestFor(catalog, bytes)), /exceeds size limit/);
  assert.deepEqual(requests, [manifestFor(catalog, bytes).catalog]);
});

for (const storedOversize of [false, true]) test(`rollback refuses ${storedOversize ? "cached" : "newly assembled"} oversize before media, uploads, hold and activation`, async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-recovery-capacity-"));
  try {
    const target = storedOversize ? fixture : catalogOfSize(catalogByteLimit);
    const before: Catalog = { ...fixture, version: "edition-2222222222222222", removedIDs: ["already-removed"] };
    const targetBytes = serializeCatalog(target), beforeBytes = serializeCatalog(before);
    const active = manifestFor(before, beforeBytes), targetManifest = manifestFor(target, targetBytes);
    const moderation = { removedIDs: [] }, hold = { reason: "preserve-existing-hold" };
    await atomic(join(root, "releases", target.version, "manifest.json"), targetManifest);
    await atomic(join(root, "latest.json"), active);
    await atomic(join(root, "moderation.json"), moderation);
    await atomic(join(root, "publication-hold.json"), hold);
    const plan = rollbackCatalog(target, before.removedIDs!);
    const path = join(root, "releases", plan.version, "catalog.json");
    let preserved: Buffer | undefined;
    if (storedOversize) {
      const valid = pretty(plan);
      preserved = Buffer.concat([valid, Buffer.alloc(catalogByteLimit + 1 - valid.length, " ")]);
      await mkdir(join(root, "releases", plan.version), { recursive: true }); await writeFile(path, preserved);
    }
    const calls: string[] = [];
    const transport: RecoveryTransport = {
      async currentManifest() { return active; },
      async remoteCatalog(manifest) { return verifyCatalog(manifest, manifest.version === target.version ? targetBytes : beforeBytes); },
      async verifyMedia() { calls.push("media"); }, async upload(key) { calls.push(key); },
    };
    await assert.rejects(recoverRelease(root, target.version, true, transport), /10000000-byte client download limit/);
    assert.deepEqual(calls, []);
    assert.deepEqual(await json(join(root, "latest.json"), null), active);
    assert.deepEqual(await json(join(root, "moderation.json"), null), moderation);
    assert.deepEqual(await json(join(root, "publication-hold.json"), null), hold);
    if (preserved) assert.deepEqual(await readFile(path), preserved);
    else await assert.rejects(stat(path), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("staging reuses legacy bytes, rejects changed content and never stages an oversized catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-stage-capacity-"));
  const stage = (path: string) => promisify(execFile)(process.execPath, ["--import", "tsx", "ingest/cli.ts", "stage", path],
    { cwd: process.cwd(), env: { ...process.env, PROMPIX_CONTENT_DIR: root }, timeout: 10000 });
  try {
    const input = join(root, "input.json"), path = join(root, "releases", fixture.version, "catalog.json");
    await atomic(input, fixture); await atomic(path, fixture);
    const before = await readFile(path);
    const staged = JSON.parse((await stage(input)).stdout);
    assert.equal(staged.sha256, digest(before)); assert.deepEqual(await readFile(path), before);
    assert.equal((await json<any>(join(root, "releases", fixture.version, "manifest.json"), null)).sha256, digest(before));
    await atomic(input, { ...fixture, prompts: [{ ...item, title: "Changed fixture" }] });
    await assert.rejects(stage(input), /different content/);
    assert.deepEqual(await readFile(path), before);
    const over = { ...catalogOfSize(catalogByteLimit + 1), version: "edition-3333333333333333" };
    await atomic(input, over);
    await assert.rejects(stage(input), /10000001 bytes/);
    await assert.rejects(stat(join(root, "releases", over.version, "catalog.json")), { code: "ENOENT" });
    await assert.rejects(stat(join(root, "releases", over.version, "manifest.json")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

function deploymentFetch(catalog: Catalog, bytes: Buffer, requests: string[]): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    if (init?.method === "PUT") return new Response(null, { status: 405 });
    if (url.endsWith("/v2/latest.json")) return new Response(null, { status: 404 });
    if (url.includes("drafts/private")) return new Response(null, { status: 404 });
    const headers = new Headers(init?.headers);
    const metadata = { ETag: '"fixture"', "Cache-Control": url.endsWith("latest.json") ? "public, max-age=60" : "public, max-age=86400" };
    if (headers.has("If-None-Match")) return new Response(null, { status: 304, headers: metadata });
    if (headers.has("Range")) return new Response("0123456789abcdef", { status: 206, headers: { "Content-Range": "bytes 0-15/100" } });
    if (init?.method === "HEAD") return new Response(null, { headers: metadata });
    if (url.endsWith("/v1/latest.json")) return new Response(JSON.stringify(manifestFor(catalog, bytes)), { headers: metadata });
    return new Response(bytes.toString(), { headers: { ...metadata, "Content-Encoding": "br", "Content-Length": "100" } });
  };
}

test("deployment checks retain legacy and compact support while rejecting decoded overflow before later probes", async () => {
  const video: Catalog = { ...fixture, prompts: [{ ...item, media: { image: null, video: null, demoURL: null,
    videoURL: `${base}/media/${"a".repeat(64)}.mp4` } }] };
  for (const bytes of [pretty(video), serializeCatalog(video)]) {
    const result = await checkDeployment(deploymentFetch(video, bytes, []));
    assert.equal(result.verified, true); assert.ok(result.checks.includes("client-byte-limits"));
  }
  const catalog = catalogOfSize(catalogByteLimit + 1), bytes = Buffer.from(JSON.stringify(catalog) + "\n");
  const requests: string[] = [];
  await assert.rejects(checkDeployment(deploymentFetch(catalog, bytes, requests)), /exceeds size limit/);
  assert.deepEqual(requests, [`${base}/v1/latest.json`, manifestFor(catalog, bytes).catalog]);
  let reads = 0;
  await assert.rejects(checkDeployment(async () => { reads++; return new Response(JSON.stringify(manifestFor(fixture, serializeCatalog(fixture))) + " ".repeat(manifestByteLimit)); }), /exceeds size limit/);
  assert.equal(reads, 1);
});
