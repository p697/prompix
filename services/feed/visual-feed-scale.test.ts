import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { Prompt } from "../../packages/schema/catalog.ts";
import { createTestDatabase } from "./test-database.ts";
import { activatePublication, stagePublication } from "./publication.ts";
import { getFeed } from "./queries.ts";

test("10000-item visual feed traverses every item once with bounded, release-pinned keyset pages", {
  skip: process.env.PROMPIX_FEED_SCALE !== "1" ? "Explicit 10000-item SQL acceptance" : false,
}, async t => {
  const { pg, writer, reader } = await createTestDatabase(); t.after(() => pg.close());
  const prompts: Prompt[] = Array.from({ length: 10000 }, (_, n) => ({
    id: `visual-scale-${n}`, kind: n < 3000 ? "text" : "image", title: `Original fixture ${n}`, summary: "Original scale acceptance fixture",
    prompt: "Create an original still life of a ceramic cup.", example: "A green cup", tags: ["fixture"], model: "Fixture",
    toolURL: null, artwork: "test", previewLabel: "Preview", source: { name: "Prompix", url: null, license: "Original", method: "Scale acceptance" },
    media: n < 3000 ? null : { image: "lake", video: null, demoURL: null },
  }));
  const release = await stagePublication(writer, { schemaVersion: 1, version: "scale", prompts });
  await activatePublication(writer, release, "0");
  const seen = new Set<string>(), elapsed: number[] = [];
  let cursor: string | undefined, plainRun = 0;
  do {
    const start = performance.now();
    const page = await getFeed(reader, { filters: { locale: "original", sort: "discovery", q: "" }, limit: 30, cursor }, "visual-scale-secret-00000000000000000000000000000");
    elapsed.push(performance.now() - start);
    assert.equal(page.release, release); assert.ok(page.items.length <= 30);
    for (const card of page.items) {
      assert.ok(!seen.has(card.id)); seen.add(card.id);
      plainRun = card.media?.image ? 0 : plainRun + 1;
      assert.ok(plainRun <= 2, "The historical tail must retain visual anchors");
    }
    if (seen.size <= 7500) {
      assert.equal(page.items.filter(card => card.media?.image).length, 24);
      assert.ok(page.items.slice(0, 4).every(card => card.media?.image));
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(seen.size, 10000);
  elapsed.sort((a, b) => a - b);
  console.log(JSON.stringify({ workload: "10000-item-visual-feed", pages: elapsed.length,
    medianMs: elapsed[Math.floor(elapsed.length / 2)], p95Ms: elapsed[Math.floor(elapsed.length * 0.95)] }));
});
