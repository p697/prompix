import { test } from "node:test";
import assert from "node:assert/strict";
import type { Prompt } from "../packages/schema/catalog.ts";
import { stripTrailingTags, withCleanCreator, withoutTrailingTags } from "./prompt-cleanup.ts";
import { translationFingerprint } from "./translation.ts";

const id = "2113398624151294084";
test("trailing hashtags and the post's own link are removed; inline tags, colours and other links stay", () => {
  assert.equal(stripTrailingTags(`Portrait, 8K #AIart #promptengineering https://x.com/King4Prompts/status/${id}/photo/1`, id), "Portrait, 8K");
  assert.equal(stripTrailingTags("A dancer mid-leap.\n\n#MichaelJackson #MJ #KingofPop", id), "A dancer mid-leap.");
  assert.equal(stripTrailingTags("Background colour #FF8800", id), "Background colour #FF8800");
  assert.equal(stripTrailingTags("Use #brand colours on the label, minimal", id), "Use #brand colours on the label, minimal");
  assert.equal(stripTrailingTags("Reference: https://x.com/other/status/1", id), "Reference: https://x.com/other/status/1");
  assert.equal(stripTrailingTags("中文提示词 #人工智能 #绘画", id), "中文提示词");
  assert.equal(stripTrailingTags("#only #tags", id), "#only #tags", "a body of tags alone is left for review");
});

test("cleaning keeps translations attached and matching, and only applies to X posts", () => {
  const base = { id: `x-post-${id}`, kind: "image", title: "T", summary: "S", prompt: "A red fox in snow #AIart #fox", example: "E", tags: [], model: "M",
    artwork: "a", previewLabel: "P", toolURL: null, media: { image: null, video: null, demoURL: null },
    source: { name: "X", url: `https://x.com/i/web/status/${id}`, license: "Source-author-rights", post: { id } } } as unknown as Prompt;
  const item = { ...base, localization: { sourceLanguage: "en", sourceFingerprint: translationFingerprint(base),
    translations: { "zh-Hans": { title: "标题", summary: "摘要", prompt: "雪中红狐 #AIart #狐狸", example: "示例", previewLabel: "图片" } } } } as Prompt;
  const cleaned = withoutTrailingTags(item);
  assert.equal(cleaned.prompt, "A red fox in snow");
  assert.equal(cleaned.localization?.translations["zh-Hans"]?.prompt, "雪中红狐");
  assert.equal(cleaned.localization?.sourceFingerprint, translationFingerprint(cleaned));
  assert.equal(withoutTrailingTags({ ...item, source: { ...item.source, name: "prompts.chat" } }).prompt, item.prompt);
  assert.equal(withoutTrailingTags(cleaned), cleaned, "idempotent");
});

test("display names keep the name and move a tagline into an empty bio", () => {
  const item = (displayName: string, bio?: string) => ({ creator: { id: "c", platform: "x", displayName, profileURL: "https://x.com/c", ...(bio ? { bio } : {}) } }) as Prompt;
  assert.deepEqual(withCleanCreator(item("PayForChat｜ChatGPT 与 Codex 教程")).creator, { id: "c", platform: "x", displayName: "PayForChat", profileURL: "https://x.com/c", bio: "ChatGPT 与 Codex 教程" });
  assert.equal(withCleanCreator(item("Maverick | AI", "Existing bio")).creator?.bio, "Existing bio");
  assert.equal(withCleanCreator(item("Maverick | AI", "Existing bio")).creator?.displayName, "Maverick");
  const plain = item("Plain Name");
  assert.equal(withCleanCreator(plain), plain);
});
