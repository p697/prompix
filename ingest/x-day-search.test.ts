import assert from "node:assert/strict";
import test from "node:test";
import { searchXDay } from "./x-day-search.ts";
import { ruleQuotas, xSearchRules } from "./x-search-rules.ts";

test("quota a thin rule cannot fill goes to rules that still have posts, without reading a page twice", async () => {
  const craft = xSearchRules.find(rule => rule.lane === "craft" && rule.kind === "image")!;
  let next = 1;
  const pages = new Map<string, number>();
  const client = { search: async (query: string, cursor?: string) => {
    // Only the first craft rule has posts: ten per page, each from its own author, without end.
    const rich = query.includes(craft.terms);
    if (rich) pages.set(cursor ?? "first", (pages.get(cursor ?? "first") ?? 0) + 1);
    const posts = rich ? Array.from({ length: 10 }, () => { const id = String(next++); return { id, author_id: `a${id}`, text: "Prompt: x", attachments: { media_keys: [`m${id}`] } }; }) : [];
    return { result: { posts, media: posts.map(post => ({ media_key: post.attachments.media_keys[0], type: "photo" })), creators: [], nextToken: rich ? `c${next}` : undefined } };
  } } as never;
  const dailyPosts = 60, quota = ruleQuotas(xSearchRules, dailyPosts).get(craft.id)!;
  const search = await searchXDay(client, { since: 0, until: 1, dailyPosts, creators: [], known: new Set() });
  const entry = search.stats.find(stats => stats.rule === craft.id)!;
  assert.ok(entry.admitted > quota, "the rich rule took over unused quota");
  assert.equal(entry.reused, entry.admitted - quota);
  assert.equal(entry.quota, entry.admitted);
  assert.ok([...pages.values()].every(count => count === 1), "no page is requested twice");
  assert.equal(new Set([...search.admitted.keys()]).size, search.admitted.size);
  assert.ok(search.admitted.size <= dailyPosts);
});
