import { test } from "node:test";
import assert from "node:assert/strict";
import { promptSchema, type Prompt } from "../packages/schema/catalog.ts";
import { canonicalModelName } from "../packages/schema/enrichment.ts";
import { applyReview, reviewBlocker, validateReviewItem } from "./review-pass.ts";
import { translationFingerprint } from "./translation.ts";
import { ruleQuery, ruleQuotas, xSearchRules } from "./x-search-rules.ts";

const media = "https://api.prompix.dev/media/" + "a".repeat(64) + ".jpg";
const item = (overrides: Partial<Prompt> = {}) => promptSchema.parse({
  id: "x-post-1", kind: "image", title: "Untitled", summary: "From X", prompt: "A cinematic product shot of [a perfume bottle] on wet stone, 4:5.",
  example: "示例", tags: ["x"], model: "nano banana pro", toolURL: null, artwork: "x-post-1", previewLabel: "图片",
  source: { name: "X", url: "https://x.com/a/status/1", license: "Source-author-rights", method: "TwitterAPI.io" },
  media: { image: null, video: null, demoURL: null, imageURL: media, imageURLs: [media] }, ...overrides });
const candidate = (value = item()) => ({ item: value, images: [{ path: "/tmp/a.jpg", mediaType: "image/jpeg" as const, role: "image" as const }] });
const answer = (overrides: Record<string, unknown> = {}) => ({
  id: "x-post-1", decision: "publish", reasons: [], reasonNote: "完整、效果好。", presentation: "general", presentationReason: "A bottle on stone.",
  minors: "none", minorsReason: "No people.", realPerson: false,
  zh: { title: "湿石上的香水瓶", summary: "电影感的产品摄影。", example: "换成你的产品名。", tags: ["产品摄影", "电影感", "香水"] },
  en: { title: "Perfume on wet stone", summary: "A cinematic product shot." },
  generation: { modelFamily: "other", modelVersion: null, mode: "t2i", outputAspect: "4:5", durationSeconds: null, hasAudio: null },
  variables: [{ token: "[a perfume bottle]", name: { zh: "产品", en: "Product" }, default: null, hint: null }],
  facets: { useCase: ["product-ads"], style: ["cinematic"], subject: ["product"] }, shots: [], sourceLanguage: "en", ...overrides });

test("one review decides, labels and names the model with a single spelling", () => {
  const outcome = validateReviewItem(candidate(), answer());
  assert.ok(outcome.ok, !outcome.ok ? outcome.error : "");
  assert.equal(outcome.fields.model, "Nano Banana Pro", "the source label wins and is spelled one way");
  assert.equal(reviewBlocker(outcome.fields), undefined);
  const reviewed = applyReview(item({ inputs: { requirement: "none", kinds: [] } } as Partial<Prompt>), outcome.fields);
  assert.equal(reviewed.title, "湿石上的香水瓶");
  assert.equal(reviewed.prompt, item().prompt, "the prompt is never rewritten");
  assert.equal(reviewed.inputs, undefined);
  assert.equal(reviewed.localization?.sourceFingerprint, translationFingerprint(reviewed));
  assert.equal(canonicalModelName("other"), "Unspecified");
  assert.equal(canonicalModelName("midjourney", "v7"), "Midjourney v7");
});

test("rubric reasons, real people, minors and scale keep items out; contradictions fail", () => {
  const rejected = validateReviewItem(candidate(), answer({ decision: "reject", reasons: ["ad-or-bait"] }));
  assert.ok(rejected.ok); assert.equal(reviewBlocker(rejected.fields), "ad-or-bait");
  for (const [fields, blocker] of [[{ realPerson: true }, "real-person"], [{ minors: "uncertain" }, "minors-uncertain"],
    [{ minors: "safe", presentation: "suggestive" }, "minors-with-suggestive"], [{ presentation: "unknown" }, "presentation-unknown"]] as const) {
    const outcome = validateReviewItem(candidate(), answer(fields));
    assert.ok(outcome.ok); assert.equal(reviewBlocker(outcome.fields), blocker);
  }
  assert.equal(validateReviewItem(candidate(), answer({ decision: "publish", reasons: ["low-quality"] })).ok, false);
  assert.equal(validateReviewItem(candidate(), answer({ reasons: ["made-up"] })).ok, false);
});

test("search rules split the day's posts by lane and media, and every query is bounded", () => {
  const quotas = ruleQuotas(xSearchRules, 200);
  const total = [...quotas.values()].reduce((sum, value) => sum + value, 0);
  assert.ok(total >= 140 && total <= 200, `quotas sum to ${total}`);
  const query = ruleQuery(xSearchRules[0], 100, 200);
  assert.match(query, /has:images/); assert.match(query, /min_faves:20/); assert.match(query, /since_time:100 until_time:200/);
  assert.match(query, /-sora/);
  assert.ok(!xSearchRules.some(rule => /sora/i.test(rule.terms)));
  assert.match(ruleQuery({ id: "c", lane: "creator", kind: "video", label: "", terms: "" }, 1, 2, ["alice", "bob"]), /\(from:alice OR from:bob\) has:videos/);
});
