import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { activateCampaignStage, readCampaignStage, boundedStageTarget, type CampaignStage, reduceCampaignStage } from "./campaign-stage.ts";
const now = Date.parse("2026-10-19T10:00:00Z"), started = "2026-10-18T00:00:00Z";
const grant: CampaignStage = { version: 1, id: "next-500", run: "history", authorizedAt: "2026-10-19T09:00:00Z",
  baselineCount: 888, seedReadyAtStart: 307, newReadyAtStart: 1400, additionalQualified: 500,
  evidencePath: "/private/evidence.json", evidenceSHA256: "a".repeat(64) };
test("each bounded stage counts qualified campaign inventory, excluding independent daily growth", () => {
  assert.equal(boundedStageTarget(grant, "history", 888, started, now), 3095);
  assert.equal(boundedStageTarget({ ...grant, additionalQualified: 1000 }, "history", 888, started, now), 3595);
  for (const patch of [{ additionalQualified: 0 }, { additionalQualified: 1.5 }, { additionalQualified: 10000 },
    { baselineCount: 999 }, { run: "other" }, { authorizedAt: "2026-10-20T00:00:00Z" }, { id: "../../escape" }])
    assert.throws(() => boundedStageTarget({ ...grant, ...patch }, "history", 888, started, now));
  // Later quality exclusions decrease eligible progress; they cannot lower this frozen target.
  assert.equal(boundedStageTarget(grant, "history", 888, started, now) - (888 + 306 + 1399), 502);
});
test("stage rollover retains old grants and rejects tampered baseline or evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "campaign-stage-"));
  try {
    const evidencePath = join(root, "evidence.json"), bytes = Buffer.from('{"qualified":2595}\n');
    await writeFile(evidencePath, bytes);
    const first = { ...grant, evidencePath, evidenceSHA256: createHash("sha256").update(bytes).digest("hex") };
    assert.equal(await readCampaignStage(root), null);
    await activateCampaignStage(root, first);
    assert.deepEqual(await readCampaignStage(root), first);
    const oldBytes = await readFile(join(root, "stages", first.id + ".json"), "utf8");
    await assert.rejects(activateCampaignStage(root, { ...first, additionalQualified: 1000 }));
    await activateCampaignStage(root, { ...first, id: "next-1000", newReadyAtStart: 1900, additionalQualified: 1000 });
    assert.equal((await readCampaignStage(root))?.newReadyAtStart, 1900);
    assert.equal(await readFile(join(root, "stages", first.id + ".json"), "utf8"), oldBytes);
    await writeFile(evidencePath, '{"qualified":9999}');
    await assert.rejects(readCampaignStage(root), /evidence changed/);
    await writeFile(evidencePath, bytes);
    const path = join(root, "stages/next-1000.json");
    await writeFile(path, JSON.stringify({ ...first, id: "next-1000", newReadyAtStart: 999 }));
    await assert.rejects(readCampaignStage(root), /Frozen stage changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stage reductions preserve frozen IDs, cannot expand, and survive restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "campaign-ceiling-"));
  try {
    const evidencePath = join(root, "evidence.json"), bytes = Buffer.from('{"ids":["a","b"]}');
    await writeFile(evidencePath, bytes);
    const original = { ...grant, additionalQualified: 1000, evidencePath,
      evidenceSHA256: createHash("sha256").update(bytes).digest("hex") };
    await activateCampaignStage(root, original);
    const before = await readFile(join(root, "stages", original.id + ".json"));
    const reduced = await reduceCampaignStage(root, original.id, 500);
    assert.deepEqual(reduced, { ...original, additionalQualified: 500 });
    assert.deepEqual(await readFile(evidencePath), bytes);
    assert.deepEqual(await readFile(join(root, "stages", original.id + ".json")), before);
    assert.deepEqual(await readFile(join(root, "stage-locks", original.id + ".json")), before);
    assert.equal(boundedStageTarget((await readCampaignStage(root))!, "history", 888, started, Date.now()), 3095);
    for (const amount of [0, 1.5, 500, 600, 1000]) await assert.rejects(reduceCampaignStage(root, original.id, amount));
    await assert.rejects(reduceCampaignStage(root, "other", 250));
    await reduceCampaignStage(root, original.id, 400);
    assert.equal((await readCampaignStage(root))!.additionalQualified, 400);
    // An unrelated or altered authorization cannot be attached to this baseline.
    const path = join(root, "stage-ceilings", original.id, "400.json");
    const cap = JSON.parse(await readFile(path, "utf8"));
    for (const patch of [{ stageSHA256: "0".repeat(64) }, { run: "other" }, { additionalQualified: 1200 },
      { authorizedAt: "2099-01-01T00:00:00Z" }]) {
      await writeFile(path, JSON.stringify({ ...cap, ...patch }));
      await assert.rejects(readCampaignStage(root));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
