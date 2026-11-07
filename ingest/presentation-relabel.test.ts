import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Prompt } from "../packages/schema/catalog.ts";
import { atomic } from "./publication.ts";
import { applyPresentationOverrides, labelledContentHash, presentationOverridesPath } from "./presentation-relabel.ts";

const item = (id: string, presentation: Prompt["presentation"]) => ({ id, prompt: `prompt ${id}`, media: { image: null, video: null, demoURL: null, imageURL: `https://api.prompix.dev/media/${id}.jpg` }, presentation }) as Prompt;

test("a relabel may loosen a live label, removes explicit items, and lapses when the item changes", async t => {
  const root = await mkdtemp(join(tmpdir(), "prompix-relabel-")); t.after(() => rm(root, { recursive: true, force: true }));
  const [a, b, c] = [item("a", "suggestive"), item("b", "suggestive"), item("c", "suggestive")];
  const at = new Date().toISOString();
  await atomic(presentationOverridesPath(root), {
    a: { hash: labelledContentHash(a), presentation: "general", reason: "普通穿搭", model: "m", at },
    b: { hash: labelledContentHash(b), presentation: "explicit", reason: "露骨", model: "m", at },
    c: { hash: labelledContentHash({ ...c, prompt: "an older prompt" }), presentation: "general", reason: "旧", model: "m", at } });
  const result = await applyPresentationOverrides([a, b, c], root);
  assert.deepEqual(result.prompts.map(value => [value.id, value.presentation]), [["a", "general"], ["c", "suggestive"]]);
  assert.equal(result.relabelled, 1);
  assert.deepEqual(result.removed, ["b"]);
});
