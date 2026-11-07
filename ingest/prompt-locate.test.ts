import assert from "node:assert/strict";
import test from "node:test";
import { locateExcerpt, locatePrompts } from "./prompt-locate.ts";
import { selectXExcerpt } from "./x-excerpts.ts";
import type { ModelProvider } from "./models/types.ts";

const text = "Made with Gpt image 2 \n\nUsing the uploaded photo, create a 3:4 vertical poster split into two halves.\n\n#AIart";

test("an exact copy maps to the author's own range", () => {
  const range = locateExcerpt(text, "  Using the uploaded photo, create a 3:4 vertical poster split into two halves. ");
  assert.equal(text.slice(range!.start, range!.end), "Using the uploaded photo, create a 3:4 vertical poster split into two halves.");
});

test("a copy with a slip inside keeps the author's text, and an invented one is refused", () => {
  const range = locateExcerpt(text, "Using the uploaded photo, make a 3:4 vertical poster split into two halves.");
  assert.equal(text.slice(range!.start, range!.end), "Using the uploaded photo, create a 3:4 vertical poster split into two halves.");
  assert.equal(locateExcerpt(text, "A completely different prompt that the author never wrote at all."), undefined);
  assert.equal(locateExcerpt(text, "too short"), undefined);
});

test("located prompts become excerpts that intake accepts, and a post without one is skipped", async () => {
  const posts = [{ id: "1", author_id: "9", text, created_at: "2026-11-07T00:00:00.000Z" }, { id: "2", author_id: "9", text: "Look at this one!" }];
  const provider = { id: "fixture", model: "fixture", capabilities: { images: true },
    complete: async () => ({ provider: "fixture", model: "fixture", usage: {}, output: { items: [
      { id: "1", prompt: "Using the uploaded photo, create a 3:4 vertical poster split into two halves." }, { id: "2", prompt: null }] } }) } as unknown as ModelProvider;
  const result = await locatePrompts(provider, posts.map(post => ({ post, kind: "image" as const })));
  assert.deepEqual([result.located, result.none, result.unmatched, result.failed], [1, 1, 0, 0]);
  assert.deepEqual(selectXExcerpt(posts[0], text, result.excerpts["1"]), { body: "Using the uploaded photo, create a 3:4 vertical poster split into two halves." });
});

test("a prompt written as an image's ALT text becomes a candidate with the author's ALT text as its body", async () => {
  const { convertXDiscovery } = await import("./x-intake.ts");
  const { unmarkedPosts } = await import("./prompt-locate.ts");
  const alt = "Studio portrait of a ceramic fox figurine on a linen backdrop, soft window light, 4:5";
  const data = { provider: "twitterapi", capturedAt: "2026-11-07T00:00:00.000Z",
    posts: [{ id: "7", author_id: "9", text: "New one from this week ✨", created_at: "2026-11-05T00:00:00.000Z", conversation_id: "7", attachments: { media_keys: ["m7"] } }],
    media: [{ media_key: "m7", type: "photo", url: "https://pbs.twimg.com/media/7.jpg", alt_text: alt }],
    creators: [{ id: "x-9", platform: "x", externalID: "9", username: "maker", displayName: "Maker", profileURL: "https://x.com/maker" }] };
  const pending = unmarkedPosts([{ name: "2026-11-07-feed-001.json", data }]);
  assert.deepEqual(pending[0].alts, [{ key: "m7", text: alt }]);
  const provider = { id: "fixture", model: "fixture", capabilities: { images: true },
    complete: async () => ({ provider: "fixture", model: "fixture", usage: {}, output: { items: [{ id: "7", prompt: alt }] } }) } as unknown as ModelProvider;
  const located = await locatePrompts(provider, pending);
  assert.equal(located.excerpts["7"].mediaKey, "m7");
  const intake = convertXDiscovery([{ name: "2026-11-07-feed-001.json", data }], {}, located.excerpts);
  assert.equal(intake.candidates[0]?.prompt, alt, intake.records.map(record => record.reason).join());
});
