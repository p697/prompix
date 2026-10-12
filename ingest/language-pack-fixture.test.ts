import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { splitLanguagePacks, joinLanguagePacks, applyRequestedLocale } from "./language-packs.ts";
import type { LanguagePackLocale } from "../packages/schema/language-packs.ts";

test("the native test fixture uses the exact published v2 codec and preserves every language", async () => {
  const fixture = JSON.parse(await readFile(new URL("../ios/PrompixTests/Resources/language-pack-fixture.json", import.meta.url), "utf8"));
  const catalog = JSON.parse(fixture.catalog), bundle = splitLanguagePacks(catalog);
  assert.equal(bundle.manifestBytes.toString(), fixture.manifest);
  assert.equal(bundle.baseBytes.toString(), fixture.base);
  const localeBytes = Object.fromEntries(Object.entries(fixture.locales as Record<LanguagePackLocale, string>)
    .map(([locale, value]) => [locale, Buffer.from(value)]));
  for (const [locale, bytes] of Object.entries(bundle.localeBytes)) assert.deepEqual(bytes, localeBytes[locale]);
  assert.deepEqual(joinLanguagePacks(bundle.manifestBytes, bundle.baseBytes, localeBytes), catalog);
  const chinese = applyRequestedLocale(bundle.manifestBytes, bundle.baseBytes, "zh-Hans", localeBytes["zh-Hans"]);
  assert.deepEqual(chinese.prompts.map(item => Object.keys(item.localization?.translations ?? {})), [["zh-Hans"], [], []]);
  assert.deepEqual(chinese.prompts.map(item => item.prompt), catalog.prompts.map((item: { prompt: string }) => item.prompt));
});
