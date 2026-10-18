import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { catalogSchema } from "../packages/schema/catalog.ts";
import { emptyTranslationCache, translationLocales } from "./translation.ts";
import { runTranslations } from "./translation-runner.ts";
import { TranslationProviderError } from "./translation-provider.ts";

const fixture = catalogSchema.parse(JSON.parse(await readFile(new URL("../ios/Prompix/Resources/catalog.json", import.meta.url), "utf8"))).prompts[0];
const item = { ...fixture, title: "Study", summary: "Study", prompt: "Sketch", example: "Study", previewLabel: "Image",
  cover: { text: "Study", eyebrow: "Art", tone: "sage" as const } };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("six subscription workers persist reservations serially and drain all nine locale jobs", async () => {
  let active = 0, peak = 0, calls = 0, persisted = 0, writes = 0;
  let release!: () => void;
  const firstWave = new Promise<void>(resolve => { release = resolve; });
  const cache = emptyTranslationCache();
  const report = await runTranslations({ items: [item], cache, locales: translationLocales, providerName: "codex", concurrency: 6,
    maxRequests: 9, maxUSD: 0, persist: async (_cache, report) => {
      assert.equal(++writes, 1); await tick(); persisted = report.attempted; writes--;
    }, provider: async (_locale, segments) => {
      calls++; assert.ok(persisted >= calls); peak = Math.max(peak, ++active);
      if (calls === 6) release();
      await firstWave; await tick(); active--;
      return { translations: segments.map(segment => ({ id: segment.id, text: segment.text })) };
    } });
  assert.equal(peak, 6); assert.equal(active, 0); assert.equal(calls, 9);
  assert.equal(report.attempted, 9); assert.equal(report.pendingSegments, 0);
  assert.equal(Object.keys(cache.segments).length, 9);
});

test("six subscription workers cannot overshoot a retained request allowance", async () => {
  let calls = 0;
  const snapshots: number[] = [];
  const report = await runTranslations({ items: [item], cache: emptyTranslationCache(), locales: translationLocales,
    providerName: "codex", concurrency: 6, maxRequests: 5, prior: { attempted: 3 }, maxUSD: 0,
    persist: async (_cache, value) => { snapshots.push(value.attempted); await tick(); },
    provider: async (_locale, segments) => { calls++; await tick(); return { translations: segments.map(segment => ({ id: segment.id, text: segment.text })) }; } });
  assert.equal(calls, 2); assert.equal(report.attempted, 5); assert.ok(report.pendingSegments > 0);
  assert.ok(snapshots.every(attempted => attempted >= 3 && attempted <= 5));
});

test("a permanent subscription failure drains the first wave without launching queued jobs", async () => {
  let calls = 0, completed = 0, release!: () => void;
  const firstWave = new Promise<void>(resolve => { release = resolve; });
  await assert.rejects(runTranslations({ items: [item], cache: emptyTranslationCache(), locales: translationLocales,
    providerName: "codex", concurrency: 6, maxRequests: 9, persist: async () => {},
    provider: async (_locale, segments) => {
      const index = ++calls; if (calls === 6) release(); await firstWave;
      if (index === 1) { completed++; throw new TranslationProviderError("Subscription unavailable", true); }
      await tick(); completed++;
      return { translations: segments.map(segment => ({ id: segment.id, text: segment.text })) };
    } }), /Subscription unavailable/);
  assert.equal(calls, 6); assert.equal(completed, 6);
});

test("subscription concurrency does not increase API concurrency or the default worker count", async () => {
  for (const [providerName, concurrency] of [["codex", 7], ["openai", 4]] as const) {
    await assert.rejects(runTranslations({ items: [item], cache: emptyTranslationCache(), providerName, concurrency,
      persist: async () => {}, provider: async () => { throw new Error("Must not call"); } }), /Invalid translation budget or concurrency/);
  }
  let active = 0, peak = 0;
  await runTranslations({ items: [item], cache: emptyTranslationCache(), locales: translationLocales, providerName: "codex",
    persist: async () => {}, provider: async (_locale, segments) => {
      peak = Math.max(peak, ++active); await tick(); active--;
      return { translations: segments.map(segment => ({ id: segment.id, text: segment.text })) };
    } });
  assert.equal(peak, 2);
});
