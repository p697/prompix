import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "../services/feed/test-database.ts";
import { catalogSchema } from "../packages/schema/catalog.ts";
import { StageQueue } from "./stage-queue.ts";
import { requestLocaleTranslation, processLocaleStage } from "./locale-queue.ts";
const fixture = catalogSchema.parse(JSON.parse(await readFile(new URL("../ios/Prompix/Resources/catalog.json", import.meta.url), "utf8"))).prompts[0];
const source = { ...fixture, title: "图画", summary: "画一朵花。", prompt: "请画一朵花。", example: "使用建议：画一朵花。", previewLabel: "图片", cover: undefined, localization: undefined };
test("locale requests share one immutable job across callers and reject stale content before model spend", async () => {
  const { pg, writer } = await createTestDatabase(), root = await mkdtemp(join(tmpdir(), "prompix-locale-test-"));
  try {
    const queue = new StageQueue(writer);
    const a = await requestLocaleTranslation(queue, root, source, "zh-Hans"), b = await requestLocaleTranslation(queue, root, source, "zh-Hans");
    assert.equal(a, b);
    const job = (await queue.claim("locales", ["locale"]))!;
    let calls = 0;
    const result = await processLocaleStage(root, root, job, async () => source, {
      translate: async (_, segments) => { calls++; return { translations: segments.map(s => ({ id: s.id, text: s.text })) }; },
      review: async items => ({ reviews: items.map(p => ({ id: p.id, verdict: "pass", issues: [] })) }),
    });
    assert.equal(result.ready, true); assert.ok(calls <= 1);
    await queue.finish(job, "succeeded", result);
    await requestLocaleTranslation(queue, root, source, "zh-Hans");
    assert.equal(await queue.claim("locales", ["locale"]), undefined);
    const key = await requestLocaleTranslation(queue, root, { ...source, prompt: "请画一只猫。" }, "zh-Hans");
    assert.notEqual(a, key);
    const stale = await processLocaleStage(root, root, (await queue.claim("locales", ["locale"]))!, async () => undefined,
      { translate: async () => { throw new Error("Must not call provider for deleted source"); } });
    assert.deepEqual(stale, { ready: false, state: "superseded" });
  } finally { await pg.close(); await rm(root, { recursive: true, force: true }); }
});
