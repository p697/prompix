import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chooseHistoryLeads, historyBatchSchema, historyCatalogSchema, historyBaseline, uniqueHistoryItems, completeHistoryItem } from "./history-cohort.ts";
import { convertXDiscovery } from "./x-intake.ts";
import { translationFingerprint, translationLocales } from "./translation.ts";
import type { Prompt } from "../packages/schema/catalog.ts";
import { runHistoryBatch } from "./history-batch.ts";
import { atomic, json } from "./publication.ts";

const lead = (n: number, author = String(n)) => ({ id: String(n), authorID: author, reason: "prompt" as const, kind: "image" as const,
  visual: true, sourceDate: "2026-08-10T00:00:00.000Z", evidence: "captured-response.json" });
const now = new Date().toISOString();
function item(): Prompt {
  const [candidate] = convertXDiscovery([{ name: "synthetic", data: { capturedAt: now, provider: "twitterapi", posts: [{ id: "123", author_id: "9", created_at: now,
    text: "Image prompt:\nAn intricate pastel paper sculpture of a mountain village, warm sunrise lighting and miniature geometric houses arranged in a quiet square.", attachments: { media_keys: ["m1"] } }],
    media: [{ media_key: "m1", type: "photo", url: "https://pbs.twimg.com/media/synthetic.jpg" }],
    creators: [{ id: "x-fixture", platform: "x", externalID: "9", username: "fixture", displayName: "Fixture", profileURL: "https://x.com/fixture" }] } }]).candidates;
  assert.ok(candidate);
  return { ...candidate, presentation: "general", media: { ...candidate.media!, imageURL: `https://api.prompix.dev/media/${"a".repeat(64)}.jpg` } };
}
test("historical assignment preserves prior attempts, visual focus and creator diversity", () => {
  const input = [...Array.from({ length: 10 }, (_, i) => lead(i + 1, "7")), lead(20), lead(21), lead(20), { ...lead(22), visual: false }, { ...lead(23), reason: "reply" as const }];
  const chosen = chooseHistoryLeads(input, new Set(["1", "20"]), 50);
  assert.deepEqual(chosen.map(l => l.id), ["2", "21", "3", "4"]);
  assert.deepEqual(chooseHistoryLeads(input, new Set(chosen.map(l => l.id)), 0), []);
  assert.throws(() => chooseHistoryLeads(input, new Set(), 51));
});
test("historical batches reject duplicate IDs and oversized assignments", () => {
  const batch = { version: 1, id: "batch-0001", createdAt: now, leads: [lead(1)] };
  assert.ok(historyBatchSchema.safeParse(batch).success);
  assert.ok(!historyBatchSchema.safeParse({ ...batch, leads: [lead(1), lead(1)] }).success);
  assert.ok(!historyBatchSchema.safeParse({ ...batch, leads: Array.from({ length: 51 }, (_, i) => lead(i)) }).success);
});
test("cohort dedup covers published text and earlier batches with a different source ID", () => {
  const first = item(), duplicate = { ...first, id: "different-source", prompt: `  ${first.prompt.replace(/ /g, "  ")}  ` };
  assert.equal(uniqueHistoryItems([duplicate], [first]).length, 0);
  assert.equal(uniqueHistoryItems([first, duplicate], []).length, 1);
});
test("completion does not count incomplete translations, unclassified or stale sources", () => {
  const source = { ...item(), title: "Paper village", summary: "A beautiful paper village", example: "Use an image generator", previewLabel: "Source image" };
  assert.equal(completeHistoryItem(source), false);
  const languages = { en: "A beautiful paper village", "zh-Hans": "精致纸雕村庄", "zh-Hant": "精緻紙雕村莊", ja: "美しい紙の村", ko: "아름다운 종이 마을", es: "Un hermoso pueblo de papel", "pt-BR": "Uma bela vila de papel", fr: "Un beau village en papier", de: "Ein schönes Papierdorf" };
  const complete = { ...source, localization: { sourceLanguage: "en", sourceFingerprint: translationFingerprint(source),
    translations: Object.fromEntries(translationLocales.map(locale => [locale, { title: languages[locale], summary: languages[locale], prompt: languages[locale], example: languages[locale], previewLabel: languages[locale] }])) } };
  // Use realistic source-length fields to retain the existing anti-truncation gate.
  for (const locale of translationLocales) complete.localization.translations[locale].prompt = languages[locale].repeat(8);
  assert.equal(completeHistoryItem(complete), true);
  assert.equal(completeHistoryItem({ ...complete, presentation: "unknown" }), false);
  assert.equal(completeHistoryItem({ ...complete, presentation: "explicit" }), false);
  assert.equal(completeHistoryItem({ ...complete, source: { ...source.source, acquiredVia: undefined } }), false);
  assert.equal(completeHistoryItem(complete, Date.now() + 25 * 3600_000), false);
  assert.equal(completeHistoryItem({ ...complete, localization: { ...complete.localization, sourceFingerprint: "0".repeat(64) } }), false);
});
test("an interrupted historical acquisition stays blocked across calendar days without HTTP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prompix-history-test-"));
  const before = { ...process.env }, fetchBefore = globalThis.fetch;
  Object.assign(process.env, { PROMPIX_X_DISCOVERY_PROVIDER: "third-party", PROMPIX_X_OFFICIAL_ENABLED: "0", X_BEARER_TOKEN: "", PROMPIX_TRANSLATION_MODEL: "gpt-6-luna", PROMPIX_TRANSLATION_PROVIDER: "codex", PROMPIX_CODEX: "/synthetic/codex" });
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("unexpected HTTP"); };
  try {
    await atomic(join(directory, "x-lead-acquisitions", "2026-01-01.json"), [{ state: "reserved", ids: ["1"] }]);
    await assert.rejects(runHistoryBatch(directory, { version: 1, id: "batch-0001", createdAt: now, leads: [lead(1)] }, [], directory), /Unresolved historical acquisition/);
    assert.equal(calls, 0); assert.equal((await json<{ stage: string }>(join(directory, "report.json"), { stage: "" })).stage, "blocked");
  } finally { globalThis.fetch = fetchBefore; for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]; Object.assign(process.env, before); await rm(directory, { recursive: true, force: true }); }
});

test("a fully rejected batch remains a durable empty result, without weakening public catalog rules", () => {
  assert.deepEqual(historyCatalogSchema.parse({ schemaVersion: 1, version: "empty-batch", prompts: [] }).prompts, []);
  assert.throws(() => historyBaseline({ schemaVersion: 1, version: "empty", prompts: [] }));
});

test("an identical visible cover cannot inflate the unique acceptance sample", () => {
  const first = item(), other = { ...first, id: "different-source", prompt: "A completely different description of this same image." };
  assert.equal(uniqueHistoryItems([other], [first]).length, 0);
});

test("general chat hosts do not force explicit visual generation into the text category", async () => {
  const { extractMarkedXPrompt } = await import("./x-intake.ts");
  const post = { id: "99", author_id: "9", created_at: now, text: "", attachments: { media_keys: ["p"] } };
  const media = [{ media_key: "p", type: "photo" as const, url: "https://pbs.twimg.com/media/synthetic.jpg" }];
  assert.equal((extractMarkedXPrompt({ ...post, text: "ChatGPT\nPrompt:\nCreate a photorealistic portrait with soft studio lighting and carefully composed framing." }, media) as { kind: string }).kind, "image");
  assert.equal((extractMarkedXPrompt({ ...post, text: "ChatGPT images\nPrompt:\nTurn the original scene into an editorial artbook page with warm paper texture." }, media) as { kind: string }).kind, "image");
  assert.equal((extractMarkedXPrompt({ ...post, text: "ChatGPT\nPrompt:\nAnalyze this photograph and explain the composition in a concise paragraph." }, media) as { kind: string }).kind, "text");
  const video = [{ media_key: "p", type: "video" as const, preview_image_url: media[0].url, variants: [{ content_type: "video/mp4", url: "https://video.twimg.com/synthetic.mp4", bit_rate: 100 }] }];
  assert.equal((extractMarkedXPrompt({ ...post, text: "Create with ChatGPT\nPrompt:\nOpening shot: a paper village assembles itself from folded sheets. Use slow camera movements and a warm final shot." }, video) as { kind: string }).kind, "video");
});

test("historical translation repair retains spent requests and stops at the shared batch bound", async () => {
  const { runHistoryTranslations } = await import("./history-batch.ts");
  const { emptyTranslationCache } = await import("./translation.ts");
  const source = { ...item(), title: "Paper village", summary: "Paper village", example: "Paper village", previewLabel: "Paper village", prompt: "Paper village" };
  const options = { items: [source], cache: emptyTranslationCache(), providerName: "codex", model: "gpt-6-luna", locales: ["zh-Hans" as const], concurrency: 1,
    maxRequests: 2, maxUSD: 0, persist: async () => {} };
  let calls = 0;
  const result = await runHistoryTranslations({ ...options, provider: async (_locale, segments) => {
    calls++; if (calls === 2) assert.ok(segments[0].reviewFeedback?.some(f => f.includes("Missing translation"))); return { translations: calls === 1 ? [] : segments.map(s => ({ id: s.id, text: "精致的纸雕村庄" })) };
  } });
  assert.equal(calls, 2); assert.equal(result.attempted, 2); assert.equal(result.pendingSegments, 0); assert.ok(result.rejected > 0);
  calls = 0;
  const blocked = await runHistoryTranslations({ ...options, cache: emptyTranslationCache(), maxRequests: 1,
    provider: async () => { calls++; return { translations: [] }; } });
  assert.equal(calls, 1); assert.equal(blocked.attempted, 1); assert.ok(blocked.pendingSegments > 0);
});
