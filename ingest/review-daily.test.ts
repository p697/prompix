import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promptSchema } from "../packages/schema/catalog.ts";
import { reviewDailyX, reviewedCreators, reviewPassRejections } from "./review-daily.ts";
import type { ModelProvider } from "./models/types.ts";
import type { Candidate } from "./sources.ts";

const media = "https://api.prompix.dev/media/" + "a".repeat(64) + ".jpg";
const candidate = (id: string, post: string): Candidate => ({ ...promptSchema.parse({
  id, kind: "image", title: "Untitled", summary: "From X", prompt: `A cinematic product shot of [a perfume bottle] on wet stone, 4:5 (${id}).`,
  example: "示例", tags: ["x"], model: "nano banana pro", toolURL: null, artwork: id, previewLabel: "图片",
  source: { name: "X", url: `https://x.com/i/web/status/${post}`, license: "Source-author-rights", method: "TwitterAPI.io", revision: "f".repeat(64),
    post: { id: post, authorID: "9", text: "post", createdAt: "2026-11-05T00:00:00.000Z", checkedAt: "2026-11-07T00:00:00.000Z" } },
  media: { image: null, video: null, demoURL: null, imageURL: media, imageURLs: [media] } }), fingerprint: id.padEnd(64, "0").slice(0, 64), featured: false, reviewStatus: "draft" });
const answer = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, decision: "publish", reasons: [], reasonNote: "完整、效果好。", presentation: "general", presentationReason: "A bottle on stone.",
  minors: "none", minorsReason: "No people.", realPerson: false,
  zh: { title: "湿石上的香水瓶", summary: "电影感的产品摄影。", example: "换成你的产品名。", tags: ["产品摄影", "电影感", "香水"] },
  en: { title: "Perfume on wet stone", summary: "A cinematic product shot." },
  generation: { modelFamily: "other", modelVersion: null, mode: "t2i", outputAspect: "4:5", durationSeconds: null, hasAudio: null },
  variables: [{ token: "[a perfume bottle]", name: { zh: "产品", en: "Product" }, default: null, hint: null }],
  facets: { useCase: ["product-ads"], style: ["cinematic"], subject: ["product"] }, shots: [], sourceLanguage: "en", ...overrides });

test("one review a night approves, rejects, caps portraits and reuses stored outcomes", async t => {
  const root = await mkdtemp(join(tmpdir(), "prompix-review-daily-")); t.after(() => rm(root, { recursive: true, force: true }));
  const items = [candidate("x-post-1", "1"), candidate("x-post-2", "2"), candidate("x-post-3", "3"), candidate("x-post-4", "4"), candidate("x-post-5", "5")];
  const verdicts: Record<string, Record<string, unknown>> = {
    "x-post-2": { decision: "reject", reasons: ["ad-or-bait"] },
    "x-post-3": { facets: { useCase: ["portraits"], style: [], subject: ["person"] }, presentation: "suggestive" },
    "x-post-4": { facets: { useCase: ["portraits"], style: [], subject: ["person"] } },
    "x-post-5": { facets: { useCase: ["portraits"], style: [], subject: ["person"] } },
  };
  let calls = 0;
  const provider = { id: "fixture", model: "fixture", capabilities: { images: true }, complete: async (request: { input: string }) => {
    calls++;
    const ids = (JSON.parse(request.input).candidates as { id: string }[]).map(item => item.id);
    return { provider: "fixture", model: "fixture", usage: {}, output: { items: ids.map(id => answer(id, verdicts[id])) } };
  } } as unknown as ModelProvider;
  const dependencies = { mirror: async (prompts: readonly Candidate[]) => ({ prompts: [...prompts], errors: [] }),
    prepare: async () => ({ images: [{ path: "/tmp/a.jpg", mediaType: "image/jpeg" as const, role: "image" as const, sourceRole: "image" }] }) } as never;
  const first = await reviewDailyX(items, root, { provider, ...dependencies as object });
  assert.equal(calls, 1);
  // Four approvals, three of them portraits: at most half are portraits, and the newest stay.
  assert.deepEqual(first.approved.map(item => item.id), ["x-post-5", "x-post-4", "x-post-1"]);
  assert.equal(first.report.deferredPortraits, 1);
  assert.equal(first.report.rejected, 1);
  const approved = first.approved.find(item => item.id === "x-post-1")!;
  assert.equal(approved.title, "湿石上的香水瓶");
  assert.equal(approved.reviewStatus, "candidate");
  assert.equal(approved.model, "Nano Banana Pro");
  assert.equal(approved.prompt, items[0].prompt, "the prompt is never rewritten");
  assert.ok((await reviewPassRejections(root))["x-post-2"]);
  const again = await reviewDailyX(items, root, { provider, ...dependencies as object });
  assert.equal(calls, 1, "stored outcomes are reused");
  assert.equal(again.report.pending, 0);
  const dry = await reviewDailyX(items, root);
  assert.equal(dry.approved.length, 3);
});

test("creators the review approves twice, mostly not portraits, join the creator search", async t => {
  const root = await mkdtemp(join(tmpdir(), "prompix-reviewed-creators-")); t.after(() => rm(root, { recursive: true, force: true }));
  const by = (item: Candidate, username: string): Candidate => ({ ...item, creator: { id: `x-${username}`, platform: "x", externalID: "9", username, displayName: username, profileURL: `https://x.com/${username}` } });
  const items = [by(candidate("x-post-11", "11"), "maker"), by(candidate("x-post-12", "12"), "maker"), by(candidate("x-post-13", "13"), "once")];
  const provider = { id: "fixture", model: "fixture", capabilities: { images: true }, complete: async (request: { input: string }) => ({ provider: "fixture", model: "fixture", usage: {},
    output: { items: (JSON.parse(request.input).candidates as { id: string }[]).map(item => answer(item.id)) } }) } as unknown as ModelProvider;
  const dependencies = { mirror: async (prompts: readonly Candidate[]) => ({ prompts: [...prompts], errors: [] }),
    prepare: async () => ({ images: [{ path: "/tmp/a.jpg", mediaType: "image/jpeg" as const, role: "image" as const, sourceRole: "image" }] }) } as never;
  await reviewDailyX(items, root, { provider, ...dependencies as object });
  assert.deepEqual(await reviewedCreators(root), ["maker"]);
  assert.deepEqual(await reviewedCreators(root, Date.now() + 15 * 86400_000), [], "only the last two weeks count");
});

test("prompts.chat prompts are reviewed after visual work, a few a night, and survive repository revisions", async t => {
  const root = await mkdtemp(join(tmpdir(), "prompix-review-text-")); t.after(() => rm(root, { recursive: true, force: true }));
  const text = (id: string, revision: string): Candidate => ({ ...candidate(id, "0"), kind: "text", media: null,
    source: { name: "prompts.chat", url: "https://github.com/f/prompts.chat", license: "CC0-1.0", method: "社区收录", revision } } as unknown as Candidate);
  const seen: string[][] = [];
  const provider = { id: "fixture", model: "fixture", capabilities: { images: true }, complete: async (request: { input: string }) => {
    const ids = (JSON.parse(request.input).candidates as { id: string }[]).map(item => item.id); seen.push(ids);
    return { provider: "fixture", model: "fixture", usage: {}, output: { items: ids.map(id => answer(id, id.startsWith("pc-") ? { generation: { ...answer(id).generation, mode: "text" } } : {})) } };
  } } as unknown as ModelProvider;
  const dependencies = { mirror: async (prompts: readonly Candidate[]) => ({ prompts: [...prompts], errors: [] }),
    prepare: async (item: Candidate) => ({ images: item.kind === "text" ? [] : [{ path: "/tmp/a.jpg", mediaType: "image/jpeg" as const, role: "image" as const, sourceRole: "image" }] }) } as never;
  const items = [text("pc-1", "rev-a"), text("pc-2", "rev-a"), text("pc-3", "rev-a"), candidate("x-post-21", "21")];
  const first = await reviewDailyX(items, root, { provider, maxText: 2, ...dependencies as object });
  assert.equal(first.report.pending, 3, "the visual post and two of the three text prompts");
  assert.equal(seen.flat()[0], "x-post-21", "visual work first");
  const moved = [text("pc-1", "rev-b"), text("pc-2", "rev-b")];
  const again = await reviewDailyX(moved, root, { provider, ...dependencies as object });
  assert.equal(again.report.pending, 0, "a new repository commit does not re-review unchanged prompts");
});
