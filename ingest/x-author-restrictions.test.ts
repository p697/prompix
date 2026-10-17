import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomic } from "./publication.ts";
import { checkXAvailability, parseXAvailability, parseXLookupResponse, parseXSearchResponse, parseXUsers, xLookupURL, xSearchURL, xUserLookupURL } from "./x.ts";
import { convertXDiscovery } from "./x-intake.ts";
import { filterXAvailability, prepareXAvailability } from "./x-availability.ts";

const at = "2026-10-17T00:00:00.000Z";
const post = { id: "101", author_id: "9", created_at: at, text: "Text prompt:\nWrite an original three-scene story with a quiet ending. Ask me about my audience, setting and main character before drafting." };
const user = { id: "9", name: "Fixture", username: "fixture", protected: false };
const body = (flags: Record<string, unknown> = {}) => ({ data: [post], includes: { users: [{ ...user, ...flags }] } });

test("all official read paths request author restriction fields, including actual maintenance transport", async t => {
  for (const url of [xSearchURL(), xLookupURL(["101"]), xUserLookupURL(["fixture"])]) {
    const fields = url.searchParams.get("user.fields")!.split(",");
    assert.ok(fields.includes("protected")); assert.ok(fields.includes("withheld"));
  }
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string) => {
    calls++; const url = new URL(input);
    assert.ok(url.searchParams.get("user.fields")!.split(",").includes("withheld"));
    return Response.json(body({ withheld: { country_codes: ["XX"] } }));
  });
  const result = await checkXAvailability("synthetic-token", ["101"]);
  assert.equal(calls, 1); assert.deepEqual(result.posts, []); assert.deepEqual(result.unavailable, []);
  assert.deepEqual(result.restricted, ["101"]);
});

test("regional and protected authors cannot enter discovery, hydration or creator cache", () => {
  for (const flags of [{ protected: true }, { withheld: { country_codes: ["XX"] } }]) {
    const response = body(flags);
    const search = parseXSearchResponse({ ...response, meta: { result_count: 1, newest_id: "101", next_token: "next-page" } });
    assert.deepEqual(search.posts, []); assert.deepEqual(search.creators, []);
    assert.equal(search.newest, "101"); assert.equal(search.nextToken, "next-page");
    assert.equal(search.coverage.posts, 1, "Cursor/count validation uses actual response before filtering");
    assert.throws(() => parseXLookupResponse(response, ["101"]), /restricted/);
    assert.deepEqual(parseXUsers(response.includes.users), []);
  }
  assert.equal(parseXAvailability(body(), ["101"]).posts.length, 1);
  assert.equal(parseXLookupResponse(body(), ["101"]).posts.length, 1);
  assert.throws(() => parseXAvailability(body({ protected: "false" }), ["101"]));
  assert.throws(() => parseXAvailability(body({ withheld: {} }), ["102"]), /identities/);
});

test("only explicit not-found creates persistent removal, while reversible restrictions remain distinct", () => {
  const restricted = parseXAvailability({ data: [{ ...post, withheld: { country_codes: ["XX"] } }] }, ["101"]);
  assert.deepEqual(restricted.unavailable, []); assert.deepEqual(restricted.restricted, ["101"]);
  const result = parseXAvailability({ errors: [
    { resource_id: "101", type: "https://api.x.com/2/problems/not-authorized-for-resource" },
    { resource_id: "102", type: "https://api.x.com/2/problems/resource-not-found" },
  ] }, ["101", "102"]);
  assert.deepEqual(result.restricted, ["101"]); assert.deepEqual(result.unavailable, ["102"]);
  assert.throws(() => parseXAvailability({ errors: [{ resource_id: "101", type: "unauthorized" }] }, ["101"]), /unresolved/);
});

test("hybrid fallback cannot revive a restricted author; fresh public evidence can later restore availability", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-author-restrictions-"));
  try {
    const initial = { ...parseXAvailability(body(), ["101"]), capturedAt: at };
    await atomic(join(root, "x-discovery", "2026-10-17.json"), initial);
    const candidate = convertXDiscovery([{ name: "fixture", data: initial }]).candidates[0];
    assert.ok(candidate);
    const next = "2026-10-17T13:00:00.000Z";
    let fallbackCalls = 0;
    const result = await prepareXAvailability(root, { enabled: true, bearer: "synthetic-token", now: next,
      recheck: { maxRequests: 1, sleep: async () => {}, lookup: async () => ({ raw: {}, result: {
        provider: "twitterapi", posts: [], creators: [], media: [], unknownIDs: ["101"],
      } }) }, lookup: async () => { fallbackCalls++; return parseXAvailability(body({ withheld: { country_codes: ["XX"] } }), ["101"]); } });
    assert.equal(fallbackCalls, 1); assert.equal(result.state[candidate.id].status, "withheld");
    assert.equal(result.state[candidate.id].removed, undefined);
    assert.deepEqual(filterXAvailability([candidate], result.state, Date.parse(next)).prompts, []);
    const restored = await prepareXAvailability(root, { enabled: true, bearer: "synthetic-token", now: "2026-10-18T02:00:00.000Z",
      lookup: async () => parseXAvailability(body(), ["101"]) });
    assert.equal(restored.report.requests, 1); assert.equal(restored.state[candidate.id].status, "ready");
    assert.equal(restored.state[candidate.id].removed, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
