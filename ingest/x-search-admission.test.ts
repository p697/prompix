import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runXSearchPlan, type XSearchPlan } from "./x-search-plan.ts";
import { selectXSearchLeads, admitXSearchLeads } from "./x-search-admission.ts";
import { parseTwitterAPI, type TwitterAPIClient } from "./twitterapi.ts";
import { readXIntake } from "./x-intake.ts";
import { json } from "./publication.ts";
const at = "2026-10-17T08:00:00.000Z";
const plan: XSearchPlan = { version: 1, maxPagesPerQuery: 2, queries: [{ id: "visual", query: "prompt", lane: "recall",
  start: Date.parse("2026-10-17T00:00:00Z") / 1000, end: Date.parse(at) / 1000 }] };
const tweet = (id: string, text: string, extra = {}) => ({ id, text, createdAt: "Sat Oct 17 07:00:00 +0000 2026", isReply: false,
  author: { id: "42", userName: "fixture", name: "Fixture" }, ...extra });
const photo = { extendedEntities: { media: [{ id_str: "501", type: "photo", media_url_https: "https://pbs.twimg.com/media/fixture.jpg" }] } };
const posts = [tweet("101", "Image prompt: Paint an original watercolor garden with warm morning light.", photo),
  tweet("102", "Text prompt: Write a thoughtful short story about a summer garden."),
  tweet("103", "My prompt is in the first reply", photo),
  tweet("104", "Creative image skill", { entities: { urls: [{ url: "https://t.co/a", expanded_url: "https://github.com/fixture/art-skill" }] } }),
  tweet("105", "DM me for the prompt", photo), tweet("106", "No complete instructions", photo)];
async function fixture(fn: (root: string, directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "prompix-admission-")), directory = join(root, "leads");
  try {
    const raw = { tweets: posts, has_next_page: false, next_cursor: null };
    const search: TwitterAPIClient["search"] = async (_query, _cursor, capture) => { await capture?.(raw); return { raw, result: parseTwitterAPI(raw, { search: true }) }; };
    await runXSearchPlan(directory, plan, { maxRequests: 1, search, now: () => new Date(at), sleep: async () => {} });
    await fn(root, directory);
  } finally { await rm(root, { recursive: true, force: true }); }
}
test("lead gate keeps complete prompts, public replies and Skill links, while withholding teasers", async () => fixture(async (_root, directory) => {
  const selected = await selectXSearchLeads(directory, plan);
  assert.deepEqual(new Set(selected.leads.map(l => l.id)), new Set(["101", "102", "103", "104"]));
  assert.equal(selected.report.replyLeads, 1); assert.equal(selected.report.skillLeads, 1);
  assert.equal(selected.leads[0].visual, true);
}));
test("official hydration supplies the actual source body and preserves existing quality gates", async () => fixture(async (root, directory) => {
  let calls = 0;
  const result = await admitXSearchLeads(root, directory, plan, { enabled: true, bearer: "fixture", maxPosts: 1, now: at,
    lookup: async (_bearer, ids) => { calls++; assert.deepEqual(ids, ["101"]);
      const result = parseTwitterAPI({ tweets: [{ ...posts[0], text: "Image prompt: Paint a completely different original forest in soft evening light." }] });
      return { posts: result.posts.map(p => ({ ...p, created_at: p.created_at! })), creators: result.creators, media: result.media, unavailable: [] }; } });
  assert.equal(result.acquired, 1);
  const intake = await readXIntake(root);
  assert.equal(intake.candidates.length, 1); assert.match(intake.candidates[0].prompt, /different original forest/);
  assert.equal(intake.candidates[0].source.name, "X");
  assert.equal(intake.report.reviewedDrafts, 0);
  const second = await admitXSearchLeads(root, directory, plan, { enabled: true, bearer: "fixture", maxPosts: 1, now: at,
    lookup: async () => { calls++; throw new Error("must not call"); } });
  assert.equal(second.status, "daily-limit"); assert.equal(calls, 1);
}));
test("failed or changed identity cannot publish third-party evidence or reset a daily acquisition allowance", async () => fixture(async (root, directory) => {
  let calls = 0;
  const options = { enabled: true, bearer: "fixture-secret", maxPosts: 4, now: at,
    lookup: async () => { calls++; const result = parseTwitterAPI({ tweets: [{ ...posts[0], author: { ...posts[0].author, id: "999" } }] });
      return { ...result, posts: result.posts.map(p => ({ ...p, created_at: p.created_at! })), unavailable: ["102", "103", "104"] }; } };
  assert.equal((await admitXSearchLeads(root, directory, plan, options)).status, "failed");
  assert.equal((await admitXSearchLeads(root, directory, plan, options)).status, "unresolved");
  assert.equal(calls, 1); assert.equal((await readdir(root)).includes("x-discovery"), false);
  const ledger = await json<any>(join(root, "x-lead-acquisitions", "2026-10-17.json"), null);
  assert.equal(JSON.stringify(ledger).includes("fixture-secret"), false);
}));
test("explicit official unavailability is accounted without deleting any existing catalog item", async () => fixture(async (root, directory) => {
  const result = await admitXSearchLeads(root, directory, plan, { enabled: true, bearer: "fixture", maxPosts: 4, now: at,
    lookup: async (_bearer, ids) => ({ posts: [], creators: [], media: [], unavailable: [...ids] }) });
  assert.equal(result.unavailable, 2); assert.equal(result.acquired, 0);
  assert.equal((await readdir(root)).includes("moderation.json"), false);
}));
