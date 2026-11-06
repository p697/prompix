import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptSchema, type Prompt } from "../packages/schema/catalog.ts";
import { enrichedPromptIssues } from "../packages/schema/enrichment.ts";
import { enrichNewItems } from "./enrichment-daily.ts";
import type { PreparedEnrichmentMedia } from "./enrichment-media.ts";
import { readExclusions } from "./exclusion-log.ts";
import { ModelProviderError, type ModelProvider, type ModelRequest } from "./models/types.ts";

const media = "https://api.prompix.dev/media/" + "a".repeat(64) + ".jpg";
const item = (id: string, overrides: Partial<Prompt> = {}): Prompt => promptSchema.parse({
  id, kind: "image", title: "雨夜霓虹人像", summary: "用上传的照片生成雨夜街头的电影感人像。",
  prompt: "Use my uploaded photo and keep my face. A cinematic portrait of [a feeling] in a rainy neon street, 9:16.",
  example: "示例", tags: ["电影感", "人像"], model: "GPT Image 2", toolURL: null, artwork: id, previewLabel: "图片",
  source: { name: "X", url: `https://x.com/a/status/${id}`, license: "Source-author-rights", method: "TwitterAPI.io" },
  media: { image: null, video: null, demoURL: null, imageURL: media, imageURLs: [media], aspectRatio: 0.5625 },
  presentation: "general", ...overrides });
const output = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, sourceLanguage: "en", presentation: "general", presentationReason: "An ordinary clothed portrait at night.",
  inputs: { requirement: "required", count: 1, kinds: ["face"], ownLikenessOnly: true },
  generation: { modelFamily: "other", modelVersion: null, mode: "i2i", outputAspect: "9:16", durationSeconds: null, hasAudio: null },
  variables: [{ token: "[a feeling]", name: { zh: "情绪", en: "Feeling" }, default: null, hint: { zh: "想表达的情绪", en: "The mood to convey" } }],
  facets: { useCase: ["portraits"], style: ["cinematic"], subject: ["person", "city"] },
  en: { title: "Rainy neon portrait", summary: "A cinematic portrait from your own photo on a rainy neon street." },
  shots: [], vocabularyGaps: [], minors: "none", minorsReason: "Only an adult is depicted.", ...overrides });
function provider(respond: (ids: string[]) => unknown, calls: string[][] = []): ModelProvider {
  return { id: "anthropic-api", kind: "api", model: "test-model", capabilities: { images: true, structuredOutput: "native" },
    async complete(request: ModelRequest) {
      const ids = (JSON.parse(request.input) as { candidates: { id: string }[] }).candidates.map(candidate => candidate.id);
      calls.push(ids);
      const value = respond(ids);
      return { output: value, text: JSON.stringify(value), provider: "anthropic-api", model: "test-model", usage: {},
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    } };
}
/** Stands in for verified media preparation, writing the same record the real one keeps. */
const prepare = async (_item: Prompt, directory: string): Promise<PreparedEnrichmentMedia> => {
  const prepared: PreparedEnrichmentMedia = { images: [{ path: "/tmp/model-0.jpg", mediaType: "image/jpeg", role: "image", sourceRole: "image-0" }],
    palette: [{ hex: "#101010", weight: 0.6 }, { hex: "#C80000", weight: 0.3 }, { hex: "#FFFFFF", weight: 0.1 }] };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "prepared.json"), JSON.stringify(prepared));
  return prepared;
};
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "prompix-enrichment-daily-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("new items publish only with a valid review and a publishable label; live items pass unchanged", async t => {
  const root = await fixture(t), live = item("x-post-1"), calls: string[][] = [];
  const items = [live, item("x-post-2"), item("x-post-3"), item("x-post-4")];
  const result = await enrichNewItems(items, new Map([[live.id, live]]), root, { prepare, provider: provider(ids => ({ items: ids.map(id =>
    id === "x-post-3" ? output(id, { minors: "unsafe", minorsReason: "A child in revealing clothing." })
      : id === "x-post-4" ? output(id, { facets: { useCase: ["portraits"], style: ["vaporwave"], subject: [] } }) : output(id)) }), calls) });
  assert.deepEqual(calls, [["x-post-2", "x-post-3", "x-post-4"]], "only new items are sent");
  assert.deepEqual(result.prompts.map(value => value.id), ["x-post-1", "x-post-2"]);
  assert.deepEqual(result.prompts[0], live);
  assert.deepEqual(enrichedPromptIssues(result.prompts[1]), []);
  assert.deepEqual((await readExclusions(join(root, "enrichment", "exclusions.jsonl"))).map(entry => [entry.id, entry.reason.split(":")[0]]),
    [["x-post-3", "minors-unsafe"], ["x-post-4", "2.0 review invalid"]]);
  assert.deepEqual({ enriched: result.report.enriched, excluded: result.report.excluded, deferred: result.report.deferred }, { enriched: 1, excluded: 2, deferred: 0 });

  // A later run reuses the stored judgments without calls; the invalid one is retried once.
  const again = await enrichNewItems(items, new Map([[live.id, live]]), root, { prepare, provider: provider(ids => ({ items: ids.map(id => output(id)) }), calls) });
  assert.deepEqual(calls.slice(1), [["x-post-4"]]);
  assert.deepEqual(again.prompts.map(value => value.id), ["x-post-1", "x-post-2", "x-post-4"]);
  assert.equal((await readExclusions(join(root, "enrichment", "exclusions.jsonl"))).length, 2, "stored exclusions are not logged twice");
});

test("a refusal excludes for good, a dry run never calls a model, and edited content is judged again", async t => {
  const root = await fixture(t), calls: string[][] = [];
  const refusing: ModelProvider = { ...provider(() => ({})), async complete() { calls.push(["refused"]); throw new ModelProviderError("declined", "refused", false); } };
  const refused = await enrichNewItems([item("x-post-5")], new Map(), root, { prepare, provider: refusing });
  assert.deepEqual(refused.prompts, []);
  await enrichNewItems([item("x-post-5")], new Map(), root, { prepare, provider: refusing });
  assert.equal(calls.length, 1, "refused content is never sent again");

  const dry = await enrichNewItems([item("x-post-6")], new Map(), root);
  assert.deepEqual(dry.prompts, []);
  assert.equal(dry.report.deferred, 1);

  await enrichNewItems([item("x-post-7")], new Map(), root, { prepare, provider: provider(ids => ({ items: ids.map(id => output(id)) })) });
  const edited = item("x-post-7", { prompt: "Use my uploaded photo and keep my face. A quiet portrait of [a feeling] by a window, 9:16." });
  const pending = await enrichNewItems([edited], new Map(), root);
  assert.equal(pending.report.deferred, 1, "a stored review does not cover edited content");
});

test("a live item rebuilt from its source takes its 2.0 fields back, and edited live content keeps the live version until reviewed", async t => {
  const root = await fixture(t);
  const [reviewed] = (await enrichNewItems([item("x-post-9")], new Map(), root, { prepare, provider: provider(ids => ({ items: ids.map(id => output(id)) })) })).prompts;
  const { facets: _f, generation: _g, inputs: _i, variables: _v, rights: _r, palette: _p, localization: _l, ...rebuilt } = reviewed;
  const live = new Map([[reviewed.id, reviewed]]), calls: string[][] = [];
  const kept = await enrichNewItems([rebuilt as Prompt], live, root);
  assert.deepEqual(kept.prompts[0], reviewed);
  const edited = { ...rebuilt, prompt: "Use my uploaded photo and keep my face. A quiet portrait of [a feeling] by a window, 9:16." } as Prompt;
  const unreviewed = await enrichNewItems([edited], live, root);
  assert.equal(unreviewed.prompts[0], reviewed, "the live version stays while the edit waits");
  const unsafe = await enrichNewItems([edited], live, root, { prepare, provider: provider(ids => ({ items: ids.map(id => output(id, { minors: "uncertain", minorsReason: "Age unclear." })) }), calls) });
  assert.equal(unsafe.prompts[0], reviewed, "a blocked edit never replaces the live version");
  assert.equal(calls.length, 1);
});

test("a rebuild never loosens or unsettles the scale label the 2.0 review gave live content", async t => {
  const root = await fixture(t);
  const live = (label: Prompt["presentation"]) => ({ ...item("x-post-10"), presentation: label, facets: { useCase: ["portraits"], style: [], subject: [] } }) as Prompt;
  const label = async (rebuilt: Prompt["presentation"], current: Prompt["presentation"]) =>
    (await enrichNewItems([{ ...live(current), presentation: rebuilt } as Prompt], new Map([["x-post-10", live(current)]]), root)).prompts[0].presentation;
  assert.equal(await label("general", "suggestive"), "suggestive");
  assert.equal(await label("unknown", "general"), "general");
  assert.equal(await label("suggestive", "general"), "suggestive");
});

test("rate limits stop the run and defer the rest instead of publishing unreviewed items", async t => {
  const root = await fixture(t);
  const limited: ModelProvider = { ...provider(() => ({})), async complete() { throw new ModelProviderError("slow down", "rate_limited", true); } };
  const result = await enrichNewItems([item("x-post-8")], new Map(), root, { prepare, provider: limited });
  assert.deepEqual(result.prompts, []);
  assert.equal(result.report.status, "stopped");
  assert.equal(result.report.deferred, 1);
});
