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
