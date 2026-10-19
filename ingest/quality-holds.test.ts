import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Prompt } from "../packages/schema/catalog.ts";
import { atomic, lockContent } from "./publication.ts";
import { applyQualityHolds, assertNoQualityHolds, qualityHoldIdentity, qualityHoldsByteLimit, qualityHoldsSchema, readQualityHolds, saveQualityHold,
  type QualityHoldRecord } from "./quality-holds.ts";

const execute = promisify(execFile);
const item: Prompt = { id: "quality-fixture", kind: "image", title: "Original fixture", summary: "A synthetic diagram.",
  prompt: "Draw two labeled circles.", example: "Check the labels before use.", tags: ["Diagram"], model: "Any", toolURL: null,
  artwork: "test", previewLabel: "Preview", source: { name: "Prompix", url: null, license: "Original", method: "Written for tests" },
  media: { image: null, video: null, demoURL: null, imageURL: `https://api.prompix.dev/media/${"a".repeat(64)}.jpg` } };
const record = (): QualityHoldRecord => ({ sourceIdentitySHA256: qualityHoldIdentity(item), evidenceSHA256: "b".repeat(64),
  reason: "The synthetic labels are reversed.", reviewerID: "test-reviewer", reviewedAt: "2026-10-01T00:00:00Z" });
const holds = () => ({ schemaVersion: 1 as const, holds: { [item.id]: record() } });

test("quality evidence binds exact original, attribution and media without depending on translated metadata", () => {
  const identity = qualityHoldIdentity(item);
  for (const change of [
    (p: Prompt) => { p.id += "-different"; }, (p: Prompt) => { p.prompt += " "; },
    (p: Prompt) => { p.model += " changed"; }, (p: Prompt) => { p.source.author = "Another author"; },
    (p: Prompt) => { p.source.revision = "c".repeat(40); }, (p: Prompt) => { p.source.license = "Other"; },
    (p: Prompt) => { p.media!.imageURL = `https://api.prompix.dev/media/${"c".repeat(64)}.jpg`; },
    (p: Prompt) => { p.media!.imageURLs = [p.media!.imageURL!, `https://api.prompix.dev/media/${"c".repeat(64)}.jpg`]; },
    (p: Prompt) => { p.media!.demoURL = "https://example.com/changed"; },
  ]) { const changed = structuredClone(item); change(changed); assert.notEqual(qualityHoldIdentity(changed), identity); }
  const displayOnly = { ...item, title: "Updated display title", summary: "Updated display summary" };
  assert.equal(qualityHoldIdentity(displayOnly), identity);
  const changedSource = { ...item, prompt: "Draw a corrected diagram." };
  assert.deepEqual(applyQualityHolds([changedSource], holds()).withheldIDs, [item.id], "Changed source cannot silently clear an operator hold");
});

test("filtering preserves surviving snapshots and cannot mutate personal-removal signals", () => {
  const kept = { ...item, id: "keep" }, removedIDs = ["explicit-removal"];
  const catalog = { prompts: [item, kept], removedIDs };
  const filtered = { ...catalog, ...applyQualityHolds(catalog.prompts, holds()) };
  assert.deepEqual(filtered.prompts, [kept]); assert.equal(filtered.prompts[0], kept);
  assert.equal(filtered.removedIDs, removedIDs); assert.deepEqual(catalog.prompts, [item, kept]);
  assert.throws(() => assertNoQualityHolds(catalog, holds()), /quality hold/);
  assert.doesNotThrow(() => assertNoQualityHolds(filtered, holds()));
});

test("quality hold metadata rejects incomplete, unknown and unbounded operator records", () => {
  const invalid: unknown[] = [{}, { ...holds(), schemaVersion: 2 }, { ...holds(), removedIDs: [item.id] },
    { schemaVersion: 1, holds: { "../unsafe": record() } }, { schemaVersion: 1, holds: { [item.id]: { ...record(), extra: true } } },
    { schemaVersion: 1, holds: { [item.id]: { ...record(), evidenceSHA256: "" } } },
    { schemaVersion: 1, holds: { [item.id]: { ...record(), sourceIdentitySHA256: "A".repeat(64) } } },
    { schemaVersion: 1, holds: { [item.id]: { ...record(), reason: " " } } },
    { schemaVersion: 1, holds: { [item.id]: { ...record(), reviewedAt: "tomorrow" } } },
    { schemaVersion: 1, holds: Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`item-${i}`, record()])) },
  ];
  for (const value of invalid) assert.equal(qualityHoldsSchema.safeParse(value).success, false);
  assert.deepEqual(qualityHoldsSchema.parse(holds()), holds());
});

test("missing hold storage is empty; malformed, oversized and symlinked storage fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-quality-storage-")), path = join(root, "quality-holds.json");
  try {
    assert.deepEqual(await readQualityHolds(root), { schemaVersion: 1, holds: {} });
    await writeFile(path, "{"); await assert.rejects(readQualityHolds(root));
    await writeFile(path, " ".repeat(1_000_001)); await assert.rejects(readQualityHolds(root), /Invalid quality hold review file/);
    await rm(path); await writeFile(join(root, "elsewhere.json"), JSON.stringify(holds())); await symlink(join(root, "elsewhere.json"), path);
    await assert.rejects(readQualityHolds(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("locked operator writes only quality metadata and preserves existing holds and removal history", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-quality-write-"));
  try {
    await atomic(join(root, "moderation.json"), { removedIDs: ["explicit-removal"], history: [{ reason: "Prior removal" }] });
    const prior = await readFile(join(root, "moderation.json"));
    const unlock = await lockContent(root);
    try {
      const other = { ...item, id: "other" };
      await saveQualityHold(root, other, { ...record(), sourceIdentitySHA256: qualityHoldIdentity(other) });
      await saveQualityHold(root, item, record());
      assert.deepEqual(Object.keys((await readQualityHolds(root)).holds).sort(), ["other", item.id].sort());
      await assert.rejects(saveQualityHold(root, item, { ...record(), reviewedAt: "2099-01-01T00:00:00Z" }), /future/);
      const beforeMismatch = await readFile(join(root, "quality-holds.json"));
      for (const changed of [{ ...item, prompt: item.prompt + " " }, { ...item, source: { ...item.source, revision: "changed" } },
        { ...item, media: { ...item.media!, imageURL: `https://api.prompix.dev/media/${"c".repeat(64)}.jpg` } }])
        await assert.rejects(saveQualityHold(root, changed, record()), /does not match the inspected/);
      assert.deepEqual(await readFile(join(root, "quality-holds.json")), beforeMismatch);
      assert.deepEqual(await readFile(join(root, "moderation.json")), prior);
    } finally { await unlock(); }
    assert.deepEqual((await readdir(root)).sort(), ["moderation.json", "quality-holds.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the operator command binds its explicit ID and obeys the shared content lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-quality-command-"));
  const reviewPath = join(root, "operator-review.json"), catalogPath = join(root, "inspected-catalog.json"), content = join(root, "content");
  const run = () => execute(process.execPath, ["--import", "tsx", "ingest/quality-hold.ts", item.id, reviewPath, catalogPath],
    { cwd: process.cwd(), env: { ...process.env, PROMPIX_CONTENT_DIR: content } });
  try {
    await writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, version: "test", prompts: [item] }));
    await writeFile(reviewPath, JSON.stringify({ id: "wrong-item", ...record() }));
    await assert.rejects(run()); assert.deepEqual(await readQualityHolds(content), { schemaVersion: 1, holds: {} });
    await writeFile(reviewPath, JSON.stringify({ id: item.id, ...record() }));
    await writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, version: "test", prompts: [{ ...item, prompt: item.prompt + " " }] }));
    await assert.rejects(run(), /does not match the inspected/);
    assert.deepEqual(await readQualityHolds(content), { schemaVersion: 1, holds: {} });
    await writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, version: "test", prompts: [item] }));
    const unlock = await lockContent(content);
    try { await assert.rejects(run(), /Another content operation/); }
    finally { await unlock(); }
    const result = JSON.parse((await run()).stdout);
    assert.equal(result.published, false); assert.equal(result.removalTombstoneAdded, false);
    assert.deepEqual((await readQualityHolds(content)).holds[item.id], record());
    assert.deepEqual(await readdir(content), ["quality-holds.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("a valid addition that exceeds stored UTF-8 bytes preserves the prior readable file", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-quality-size-"));
  try {
    const largeRecord = { ...record(), reason: "界".repeat(1000) };
    const prior = { schemaVersion: 1 as const, holds: {} as Record<string, QualityHoldRecord> };
    for (let index = 0; index < 1000; index++) {
      prior.holds[`held-${index}`] = largeRecord;
      if (Buffer.byteLength(JSON.stringify(prior, null, 2) + "\n") > qualityHoldsByteLimit) {
        delete prior.holds[`held-${index}`]; break;
      }
    }
    const path = join(root, "quality-holds.json");
    await atomic(path, prior);
    const bytes = await readFile(path);
    assert.deepEqual(await readQualityHolds(root), prior);
    assert.equal(qualityHoldsSchema.safeParse({ ...prior, holds: { ...prior.holds, [item.id]: largeRecord } }).success, true);
    const unlock = await lockContent(root);
    try { await assert.rejects(saveQualityHold(root, item, largeRecord), /exceed the storage limit/); }
    finally { await unlock(); }
    assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual(await readQualityHolds(root), prior);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("registered campaign holds are live across publication recovery and missing evidence fails closed", async () => {
  const { registerQualityHoldScope } = await import("./quality-holds.ts");
  const root = await mkdtemp(join(tmpdir(), "prompix-scoped-holds-"));
  const campaign = await mkdtemp(join(tmpdir(), "prompix-campaign-holds-"));
  try {
    await atomic(join(campaign, "quality-holds.json"), { schemaVersion: 1, holds: {} });
    await registerQualityHoldScope(root, campaign); await registerQualityHoldScope(root, campaign);
    assert.deepEqual((await readQualityHolds(root)).holds, {});
    await atomic(join(campaign, "quality-holds.json"), holds());
    assert.throws(() => assertNoQualityHolds({ prompts: [item] }, holds()));
    assert.deepEqual((await readQualityHolds(root)).holds, holds().holds);
    const another = { ...item, id: "another" };
    await saveQualityHold(root, another, { ...record(), sourceIdentitySHA256: qualityHoldIdentity(another) });
    assert.deepEqual(Object.keys(JSON.parse(await readFile(join(root, "quality-holds.json"), "utf8")).holds), ["another"]);
    assert.equal(Object.keys((await readQualityHolds(root)).holds).length, 2);
    await rm(join(campaign, "quality-holds.json"));
    await assert.rejects(readQualityHolds(root), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(campaign, { recursive: true, force: true }); }
});
