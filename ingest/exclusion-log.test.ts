import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readExclusions, recordExclusion, refusedIDs } from "./exclusion-log.ts";

test("exclusions are auditable lines and refusals are remembered", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "prompix-exclusions-")), "nested", "exclusions.jsonl");
  assert.deepEqual(await readExclusions(path), []);
  await recordExclusion(path, { id: "x-post-1", stage: "translate", reason: "The model declined", refused: true, provider: "anthropic-api", model: "claude-sonnet-5-5" });
  await recordExclusion(path, { id: "x-post-2", stage: "source", reason: "Source post is gone", provider: "twitterapi" });
  const entries = await readExclusions(path);
  assert.deepEqual(entries.map(entry => [entry.id, entry.stage]), [["x-post-1", "translate"], ["x-post-2", "source"]]);
  assert.ok(entries.every(entry => Date.parse(entry.at) > 0));
  assert.deepEqual([...await refusedIDs(path)], ["x-post-1"], "only refusals are final");
  await assert.rejects(recordExclusion(path, { id: "x", stage: "elsewhere" as "media", reason: "?" }));
});
