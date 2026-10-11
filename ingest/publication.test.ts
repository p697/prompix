import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Catalog, type Prompt } from "../packages/schema/catalog.ts";
import { atomic, json, lockContent, rollbackCatalog, verifyCatalog, manifestSchema, digest, base, type Manifest } from "./publication.ts";
import { recoverRelease, type RecoveryTransport } from "./recovery.ts";

const prompt = (id: string): Prompt => ({ id, kind: "text", title: id, summary: "An original test fixture", prompt: "Write a short story about a teacup.", example: "A teacup grew wings.", tags: ["test"], model: "Any", toolURL: null, artwork: "test", previewLabel: "Test", source: { name: "Prompix", url: null, license: "Original", method: "Written for tests" }, media: null });
const target: Catalog = { schemaVersion: 1, version: "edition-1111111111111111", publishedAt: "2026-10-01T00:00:00Z", prompts: [prompt("keep"), prompt("removed-later"), prompt("removed-locally")], removedIDs: ["removed-earlier"] };
const current: Catalog = { ...target, version: "edition-2222222222222222", prompts: [prompt("keep"), prompt("removed-locally")], removedIDs: ["removed-later"] };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
function manifest(catalog: Catalog): Manifest {
  return manifestSchema.parse({ schemaVersion: 1, version: catalog.version, publishedAt: catalog.publishedAt, count: catalog.prompts.length, sha256: digest(encode(catalog)), catalog: `${base}/releases/${catalog.version}/catalog.json` });
}
test("rollback unions all tombstones and cannot publish an empty edition", () => {
  const plan = rollbackCatalog(target, [...current.removedIDs!, "removed-locally"]);
  assert.deepEqual(plan.prompts.map(p => p.id), ["keep"]);
  assert.deepEqual(plan.removedIDs, ["removed-earlier", "removed-later", "removed-locally"]);
  assert.equal(plan.version, rollbackCatalog(target, ["removed-locally", "removed-later", "removed-locally"]).version);
  assert.throws(() => rollbackCatalog(target, target.prompts.map(p => p.id)));
});
test("catalog verification rejects tampering, metadata mismatch and cross-host locations", () => {
  const m = manifest(target);
  assert.deepEqual(verifyCatalog(m, encode(target)), target);
  assert.throws(() => verifyCatalog(m, encode(current)), /checksum/);
  assert.throws(() => verifyCatalog({ ...m, count: 1 }, encode(target)), /metadata/);
  assert.throws(() => verifyCatalog({ ...m, catalog: "https://example.com/catalog.json" }, encode(target)));
});
test("shared content lock rejects overlapping operations and permits the next after release", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-lock-"));
  try {
    const release = await lockContent(root);
    await assert.rejects(lockContent(root), /Another content operation/);
    await release();
    await (await lockContent(root))();
  } finally { await rm(root, { recursive: true, force: true }); }
});
async function fixture(failure?: "media" | "catalog" | "activation" | "changed") {
  const root = await mkdtemp(join(tmpdir(), "prompix-recovery-"));
  const files = new Map<string, Buffer>();
  for (const catalog of [target, current]) files.set(manifest(catalog).catalog, encode(catalog));
  let active = manifest(current);
  let reads = 0;
  const calls: string[] = [];
  await atomic(join(root, "releases", target.version, "manifest.json"), manifest(target));
  await atomic(join(root, "latest.json"), active);
  await atomic(join(root, "moderation.json"), { removedIDs: ["removed-locally"] });
  const transport: RecoveryTransport = {
    async currentManifest() {
      reads++;
      if (failure === "changed" && reads === 2) return manifest(target);
      return active;
    },
    async remoteCatalog(m) { return verifyCatalog(m, files.get(m.catalog)!); },
    async verifyMedia() { calls.push("media"); if (failure === "media") throw new Error("Missing media"); },
    async upload(key, path) {
      calls.push(key);
      if (failure === "catalog" && key.startsWith("releases/")) throw new Error("Upload failed");
      const bytes = await readFile(path);
      files.set(`${base}/${key}`, bytes);
      if (key === "v1/latest.json") {
        active = manifestSchema.parse(JSON.parse(bytes.toString()));
        if (failure === "activation") throw new Error("Ambiguous upload response");
      }
    },
  };
  return { root, transport, calls, getActive: () => active, cleanup: () => rm(root, { recursive: true, force: true }) };
}
test("dry-run verifies and stages without activation, hold or moderation changes", async () => {
  const f = await fixture();
  try {
    await recoverRelease(f.root, target.version, false, f.transport);
    assert.deepEqual(f.calls, []);
    assert.equal(f.getActive().version, current.version);
    assert.equal(await json(join(f.root, "publication-hold.json"), null), null);
    assert.deepEqual(await json(join(f.root, "moderation.json"), null), { removedIDs: ["removed-locally"] });
    assert.equal((await json<any>(join(f.root, "rollback-status.json"), null)).published, false);
  } finally { await f.cleanup(); }
});
for (const failure of ["media", "catalog", "changed", "activation"] as const) {
  test(`recovery handles ${failure} failure without losing removals or enabling automatic overwrite`, async () => {
    const f = await fixture(failure);
    try {
      await assert.rejects(recoverRelease(f.root, target.version, true, f.transport));
      const hold = await json<any>(join(f.root, "publication-hold.json"), null);
      assert.equal(!!hold, failure === "activation");
      if (failure === "activation") {
        assert.ok(f.getActive().version.startsWith("rollback-"));
        assert.ok((await json<any>(join(f.root, "moderation.json"), null)).removedIDs.includes("removed-later"));
      } else assert.equal(f.getActive().version, current.version);
      assert.equal((await json<any>(join(f.root, "latest.json"), null)).version, current.version);
      const status = await json<any>(join(f.root, "rollback-status.json"), null);
      assert.equal(status.published, false); assert.ok(status.error);
      await (await lockContent(f.root))();
    } finally { await f.cleanup(); }
  });
}
test("successful recovery activates last, holds daily publishing and preserves immutable bytes on retry", async () => {
  const f = await fixture();
  try {
    await recoverRelease(f.root, target.version, true, f.transport);
    const active = f.getActive();
    const firstBytes = await readFile(join(f.root, "releases", active.version, "catalog.json"));
    assert.equal(f.calls.at(-1), "v1/latest.json");
    assert.equal((await json<any>(join(f.root, "publication-hold.json"), null)).version, active.version);
    assert.equal((await json<any>(join(f.root, "latest.json"), null)).sha256, active.sha256);
    assert.deepEqual(verifyCatalog(active, firstBytes).prompts.map(p => p.id), ["keep"]);
    await recoverRelease(f.root, target.version, true, f.transport);
    assert.equal(f.getActive().sha256, active.sha256);
    assert.deepEqual(await readFile(join(f.root, "releases", active.version, "catalog.json")), firstBytes);
  } finally { await f.cleanup(); }
});
