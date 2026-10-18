import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomic, json } from "./publication.ts";
import { convertXDiscovery } from "./x-intake.ts";
import { convertXThread, readAllXIntake } from "./x-thread-intake.ts";
import { thirdPartySourceLookup, thirdPartyFeedSearch } from "./x-third-party.ts";
import { filterXAvailability, prepareXAvailability } from "./x-availability.ts";
import { nativeXSourceIssue } from "./x-source.ts";
import { saveXReplyPage, xReplyRequest } from "./x-replies.ts";
import { refreshedXSource, recheckXStandalone } from "./x-recheck.ts";
import { collectXDiscovery } from "./x-collection.ts";
import { checkXAvailability } from "./x.ts";
import { maintenanceCensus } from "./x-maintenance-reserve.ts";
import type { TwitterAPIResult } from "./twitterapi.ts";

const now = new Date().toISOString(), old = new Date(Date.now() - 13 * 3600_000).toISOString();
const creator = { id: "x-fixture", platform: "x" as const, externalID: "9", username: "fixture", displayName: "Fixture", profileURL: "https://x.com/fixture" };
const post = { id: "102", author_id: "9", created_at: old,
  text: "Text prompt:\nWrite an original three-scene story. Ask me about my audience and subject before you begin, and finish with a surprising but coherent ending." };
const rootPost = { id: "100", author_id: "9", conversation_id: "100", created_at: old,
  text: "My animated film. Prompt in first reply.", attachments: { media_keys: ["v1"] } };
const reply = { id: "101", author_id: "9", conversation_id: "100", in_reply_to_user_id: "9", created_at: old,
  referenced_tweets: [{ type: "replied_to" as const, id: "100" }],
  text: "Prompt:\nDirect a short animated film. Create images in ChatGPT and animate in Remotion.\nFinal output: out/promo.mp4, exactly thirty seconds. Write a script, render the film and inspect the final result." };
const media = [{ media_key: "v1", type: "video" as const, preview_image_url: "https://pbs.twimg.com/media/fixture.jpg",
  variants: [{ content_type: "video/mp4", url: "https://video.twimg.com/fixture.mp4", bit_rate: 100 }] }];
const result = (): TwitterAPIResult => ({ provider: "twitterapi", posts: [post], creators: [creator], media: [], unknownIDs: [] });
const thread = () => ({ provider: "twitterapi" as const, posts: [rootPost, reply], creators: [creator], media, unknownIDs: [] });
const environment = (directory: string) => ({ PROMPIX_X_DISCOVERY_PROVIDER: "third-party", TWITTERAPI_IO_KEY: "fixture",
  PROMPIX_X_MONTHLY_USD: "20", PROMPIX_X_SPEND_DIR: join(directory, "spend") });
const sleep = async () => {};
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "prompix-third-party-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function seedThread(directory: string, provider?: "twitterapi") {
  const lead = { post: rootPost, capturedAt: old, snapshot: "fixture", creator, media };
  const request = xReplyRequest(lead, undefined, provider ? 20 : 50);
  await saveXReplyPage(directory, lead, {}, old, { ...thread(), provider, newest: reply.id, request }, provider ? "x-replies-twitterapi" : "x-replies");
}

test("official kill switch rejects before any network or spend reservation", async () => {
  const before = process.env.PROMPIX_X_OFFICIAL_ENABLED, original = globalThis.fetch;
  let calls = 0;
  process.env.PROMPIX_X_OFFICIAL_ENABLED = "0";
  globalThis.fetch = async () => { calls++; throw new Error("Unexpected HTTP"); };
  try { await assert.rejects(checkXAvailability("fixture", ["102"]), /disabled; no request sent/); assert.equal(calls, 0); }
  finally { globalThis.fetch = original; if (before === undefined) delete process.env.PROMPIX_X_OFFICIAL_ENABLED; else process.env.PROMPIX_X_OFFICIAL_ENABLED = before; }
});

test("third-party source acquisition retains provenance and unknowns, with raw evidence", () => fixture(async directory => {
  const lookup = thirdPartySourceLookup(directory, environment(directory), async (ids, capture) => {
    await capture?.({ fixture: true }); return { raw: {}, result: { ...result(), unknownIDs: ids.filter(id => id !== post.id) } };
  }, sleep);
  const acquired = await lookup("", [post.id, "999"]);
  assert.deepEqual(acquired.unavailable, []); assert.deepEqual(acquired.unknownIDs, ["999"]);
  const item = convertXDiscovery([{ name: "fixture", data: { ...acquired, capturedAt: now } }]).candidates[0];
  assert.equal(item.source.acquiredVia, "twitterapi"); assert.equal(item.source.license, "Source-author-rights");
  assert.equal(nativeXSourceIssue(item), undefined);
  assert.equal((await readdir(join(directory, "x-acquisition-evidence"))).length, 1);
}));

test("joint third-party verification requires every dependency and complete media", () => {
  const item = convertXThread({ ...thread(), capturedAt: old }, "100").candidates[0];
  assert.ok(item); assert.equal(refreshedXSource(item, thread(), now)?.source.revision, item.source.revision);
  for (const mutation of [
    (r: ReturnType<typeof thread>) => { r.posts = [reply]; },
    (r: ReturnType<typeof thread>) => { r.media = []; },
    (r: ReturnType<typeof thread>) => { r.posts[0].author_id = "8"; },
    (r: ReturnType<typeof thread>) => { r.creators = []; },
  ]) { const changed = structuredClone(thread()); mutation(changed); assert.equal(refreshedXSource(item, changed, now), undefined); }
});

test("third-party joint refresh publishes a new source revision without minting an approval", () => fixture(async directory => {
  await seedThread(directory);
  const before = (await readAllXIntake(directory)).candidates[0];
  const changed = thread(); changed.posts[1].text += " Use warm sunset lighting.";
  let official = 0;
  const run = await prepareXAvailability(directory, { enabled: true, environment: environment(directory), now,
    lookup: async () => { official++; throw new Error("No fallback"); }, recheck: { maxRequests: 2, sleep,
      lookup: async (ids, capture) => { assert.deepEqual(ids, ["100", "101"]); await capture({ fixture: true }); return { raw: {}, result: changed }; } } });
  assert.equal(official, 0); assert.equal(run.state[before.id].checkedBy, "twitterapi");
  assert.deepEqual(run.state[before.id].scopeIDs, ["100", "101"]);
  const after = (await readAllXIntake(directory)).candidates.find(item => item.id === before.id)!;
  assert.notEqual(before.source.revision, after.source.revision); assert.equal(after.reviewStatus, "draft");
  assert.equal(filterXAvailability([before], run.state).prompts.length, 0);
  assert.equal(filterXAvailability([after], run.state).prompts.length, 1);
}));

test("unknown third-party source is withheld without deletion or official fallback", () => fixture(async directory => {
  await atomic(join(directory, "x-discovery", old.slice(0, 10) + ".json"), { ...result(), capturedAt: old });
  const item = convertXDiscovery([{ name: "fixture", data: { ...result(), capturedAt: old } }]).candidates[0];
  let official = 0;
  const run = await prepareXAvailability(directory, { enabled: true, environment: environment(directory), now,
    lookup: async () => { official++; throw new Error("No fallback"); }, recheck: { maxRequests: 1, sleep,
      lookup: async () => ({ raw: {}, result: { ...result(), posts: [], unknownIDs: [post.id] } }) } });
  assert.equal(official, 0); assert.equal(run.state[item.id].status, "withheld"); assert.equal(run.state[item.id].removed, undefined);
  assert.equal(filterXAvailability([item], run.state).prompts.length, 0);
}));

test("standalone third-party records cannot impersonate a joint dependency check", () => {
  const item = convertXThread({ ...thread(), capturedAt: now }, "100").candidates[0];
  for (const scopeIDs of [undefined, ["101"], ["100"]]) {
    assert.equal(filterXAvailability([item], { [item.id]: { checkedAt: now, status: "ready", revision: item.source.revision,
      checkedBy: "twitterapi", scopeIDs } }).prompts.length, 0);
  }
});

test("reply pages use a separate provider namespace and persist a verified root lookup", () => fixture(async directory => {
  const lead = { post: rootPost, capturedAt: now, snapshot: "fixture", creator, media };
  const request = xReplyRequest(lead, undefined, 20);
  const search = thirdPartyFeedSearch(directory, environment(directory), async (_query, _cursor, capture) => {
    await capture?.({ fixture: true }); return { raw: {}, result: { ...thread(), posts: [reply], media: [] } };
  }, async (ids, capture) => { assert.deepEqual(ids, ["100"]); await capture?.({ root: true }); return { raw: {}, result: { ...thread(), posts: [rootPost] } }; }, sleep);
  const page = await search("", request), finishedAt = new Date().toISOString();
  await saveXReplyPage(directory, lead, {}, finishedAt, page, "x-replies-twitterapi");
  // Real collection starts the window when saving its first page. The root check
  // precedes that point; its own timestamp is retained and bounded by the capture.
  const candidates = (await readAllXIntake(directory)).candidates;
  assert.equal(candidates.length, 1); assert.equal(candidates[0].source.acquiredVia, "twitterapi");
  assert.equal(await json(join(directory, "x-replies", "cursors.json"), null), null);
}));

test("full third-party census contains no official-rate dependency IDs", () => {
  const item = convertXThread({ ...thread(), capturedAt: now }, "100").candidates[0];
  const { plan } = maintenanceCensus([item], new Set([item.id]), new Set(), new Date(now), true, true);
  assert.equal(plan.officialPosts, 0); assert.equal(plan.standalone, 2); assert.equal(plan.complete, true);
});

test("third-party discovery failure never invokes official search or acquisition", () => fixture(async directory => {
  let official = 0;
  const run = await collectXDiscovery(directory, { enabled: true, environment: environment(directory), now: () => new Date(now), sleep,
    search: async () => { throw new Error("fixture outage"); }, officialSearch: async () => { official++; throw new Error("Forbidden"); } });
  assert.equal(run.status, "failed"); assert.equal(official, 0);
}));

test("joint rechecks retain uncertain requests and shared provider daily ledgers", () => fixture(async directory => {
  const item = convertXThread({ ...thread(), capturedAt: old }, "100").candidates[0];
  let calls = 0;
  const options = { joint: true, maxRequests: 2, now, excerpts: {}, sleep,
    lookup: async () => { calls++; throw new Error("Transport failed"); }, apply: async () => {} };
  assert.equal((await recheckXStandalone(directory, [item], options)).status, "failed");
  assert.equal((await recheckXStandalone(directory, [item], options)).status, "daily-limit");
  assert.equal(calls, 1);
  assert.deepEqual((await json<any[]>(join(directory, "x-rechecks", now.slice(0, 10) + ".json"), []))[0].ids, ["100", "101"]);
}));

test("a paid first acquisition batch cannot become budget-blocked when the second is unsent", () => fixture(async directory => {
  const { XBudgetExceeded } = await import("./x-spend.ts");
  let calls = 0;
  const lookup = thirdPartySourceLookup(directory, environment(directory), async (ids, capture) => {
    calls++; if (calls > 1) throw new XBudgetExceeded("Budget exhausted");
    await capture?.({ fixture: true }); return { raw: {}, result: { ...result(), posts: [], unknownIDs: [...ids] } };
  }, sleep);
  await assert.rejects(lookup("", Array.from({ length: 51 }, (_, i) => String(i + 1000))), error =>
    error instanceof Error && !(error instanceof XBudgetExceeded) && error.message.includes("Partial acquisition"));
  assert.equal(calls, 2); assert.equal((await readdir(join(directory, "x-acquisition-evidence"))).length, 1);
}));

test("standalone changed sources replay from a recognized discovery filename", () => fixture(async directory => {
  await atomic(join(directory, "x-discovery", old.slice(0, 10) + ".json"), { ...result(), capturedAt: old });
  const edited = result(); edited.posts[0].text += " End with a single question.";
  const run = await prepareXAvailability(directory, { enabled: true, environment: environment(directory), now,
    recheck: { maxRequests: 1, sleep, lookup: async () => ({ raw: {}, result: edited }) } });
  const next = (await readAllXIntake(directory)).candidates[0];
  assert.ok(next.prompt.endsWith("End with a single question."));
  assert.equal(filterXAvailability([next], run.state).prompts.length, 1);
  assert.equal(next.source.acquiredVia, "twitterapi");
}));
