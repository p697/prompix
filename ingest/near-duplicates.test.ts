import assert from "node:assert/strict";
import test from "node:test";
import type { Prompt } from "../packages/schema/catalog.ts";
import { laterDuplicates } from "./near-duplicates.ts";

const item = (id: string, prompt: string, publishedAt?: string) => ({ id, prompt, ...(publishedAt ? { publishedAt } : {}) }) as Prompt;
const base = "Ultra-realistic portrait of an elderly fisherman mending a red net on a foggy pier at dawn, soft window light, 85mm lens, shallow depth of field";

test("a repost of the same prompt is a later copy of the earliest post, whatever the images", () => {
  const later = laterDuplicates([
    item("x-post-3", `${base}, 4:5`, "2026-11-05T00:00:00.000Z"),
    item("x-post-1", base, "2026-11-01T00:00:00.000Z"),
    item("x-post-2", `${base.toUpperCase()} https://t.co/abc`, "2026-11-03T00:00:00.000Z"),
    item("x-post-9", "A glass teapot on a mossy rock in a quiet forest clearing at noon, overcast light, macro photography, muted greens", "2026-11-02T00:00:00.000Z"),
  ]);
  assert.deepEqual(Object.fromEntries(later), { "x-post-2": "x-post-1", "x-post-3": "x-post-1" });
});

test("Chinese prompts compare by characters, and short generic prompts are never matched", () => {
  const zh = "一位穿着红色雨衣的小女孩站在雨夜的霓虹街头，电影感光线，浅景深，胶片颗粒质感，画面温暖而孤独";
  assert.deepEqual([...laterDuplicates([item("a", zh, "2026-11-01T00:00:00.000Z"), item("b", `${zh}。`, "2026-11-02T00:00:00.000Z")]).keys()], ["b"]);
  assert.equal(laterDuplicates([item("c", "Act as a translator."), item("d", "Act as a translator.")]).size, 0);
});
