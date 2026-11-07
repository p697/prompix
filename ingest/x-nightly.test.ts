import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectNightlyX, nightlyDays } from "./x-nightly.ts";
import type { ModelProvider } from "./models/types.ts";

const at = (iso: string) => Date.parse(iso);

test("each night searches the Japan day two days back and catches up a few missed days", () => {
  // 03:00 JST on 7 November searches 5 November.
  assert.deepEqual(nightlyDays(undefined, at("2026-11-06T18:00:00Z")), ["2026-11-05"]);
  assert.deepEqual(nightlyDays("2026-11-04", at("2026-11-06T18:00:00Z")), ["2026-11-05"]);
  assert.deepEqual(nightlyDays("2026-11-05", at("2026-11-06T18:00:00Z")), []);
  assert.deepEqual(nightlyDays("2026-10-20", at("2026-11-06T18:00:00Z")), ["2026-11-03", "2026-11-04", "2026-11-05"]);
});

test("a night writes intake snapshots, locates unmarked prompts and moves the cursor", async t => {
  const root = await mkdtemp(join(tmpdir(), "prompix-nightly-")); t.after(() => rm(root, { recursive: true, force: true }));
  const queries: string[] = [];
  const posts = [
    { id: "101", author_id: "9", text: "Prompt: A glass teapot on a mossy rock, soft morning light, 4:5", attachments: { media_keys: ["m1"] } },
    { id: "102", author_id: "8", text: "Made with GPT Image\n\nA paper boat sailing across a city puddle at dusk, cinematic", attachments: { media_keys: ["m2"] } },
  ];
  const search = { search: async (query: string) => {
    queries.push(query);
    const fresh = queries.length === 1 ? posts : [];
    return { result: { posts: fresh, media: fresh.map(post => ({ media_key: post.attachments.media_keys[0], type: "photo", url: `https://pbs.twimg.com/media/${post.id}.jpg` })),
      creators: [], nextToken: undefined } };
  } } as never;
  let asked = 0;
  const provider = { id: "fixture", model: "fixture", capabilities: { images: true }, complete: async (request: { input: string }) => {
    asked++;
    const ids = (JSON.parse(request.input).posts as { id: string }[]).map(post => post.id);
    return { provider: "fixture", model: "fixture", usage: {}, output: { items: ids.map(id => ({ id, prompt: id === "102" ? "A paper boat sailing across a city puddle at dusk, cinematic" : null })) } };
  } } as unknown as ModelProvider;
  const report = await collectNightlyX(root, { enabled: true, env: {}, now: at("2026-11-06T18:00:00Z"), search, creators: [], known: new Set(), locate: { provider } });
  assert.equal(report.status, "ok");
  assert.equal(report.days[0].day, "2026-11-05");
  assert.equal(report.days[0].admitted, 2);
  assert.equal(report.days[0].located, 1);
  assert.ok(queries.every(query => query.includes("since_time:") && query.includes("until_time:")));
  assert.equal(asked, 1);
  const names = await readdir(join(root, "x-discovery"));
  assert.equal(names.length, 1);
  assert.match(names[0], /^2026-11-06-feed-001-[a-f0-9-]{36}\.json$/);
  assert.ok(JSON.parse(await readFile(join(root, "x-excerpt-reviews.json"), "utf8"))["102"]);
  assert.deepEqual(JSON.parse(await readFile(join(root, "x-nightly", "cursor.json"), "utf8")), { searchedThrough: "2026-11-05" });
  assert.equal((await collectNightlyX(root, { enabled: true, env: {}, now: at("2026-11-06T20:00:00Z"), search, creators: [], known: new Set() })).status, "up-to-date");
});
