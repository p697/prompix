import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { activateCampaignStage, readCampaignStage, boundedStageTarget, type CampaignStage } from "./campaign-stage.ts";
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
