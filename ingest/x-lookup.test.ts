import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { lookupX, parseXLookupResponse, xLookupRequest, xLookupURL, xSearchFingerprint, xSearchIdentity } from "./x.ts";
import { convertXDiscovery, nativeXPublicationBlocker } from "./x-intake.ts";

// Synthetic posts only. Every transport test replaces fetch before calling lookupX.
const ids = ["100", "101"] as const;
const imageBody = "Create an original paper landscape with tiny houses, copper rooftops, and a wide river.\r\nPreserve  the exact spacing.";
const storyBody = "Ask me for a subject, then write a short story with three scenes and a coherent ending.";
function fixture() {
  return {
    data: [
      { id: "100", author_id: "9", text: "Synthetic display preview…", truncated: true,
        entities: { urls: [{ url: "https://t.co/image", expanded_url: "https://example.test/wrong-display-link" }] },
        note_tweet: { text: `Image prompt:\r\n${imageBody}\r\nhttps://t.co/image`,
          entities: { urls: [{ url: "https://t.co/image", expanded_url: "https://x.com/fixture/status/100/photo/1", media_key: "3_image" }] } },
        attachments: { media_keys: ["3_image"] }, created_at: "2026-10-12T01:00:00Z",
        conversation_id: "100", referenced_tweets: [],
      },
      { id: "101", author_id: "9", text: "Another display preview…",
        note_post: { text: `Text prompt:\n${storyBody}`, entities: { urls: [] } },
        conversation_id: "100", in_reply_to_user_id: "9", referenced_tweets: [{ type: "replied_to", id: "100" }],
      },
    ],
    includes: {
      users: [{ id: "9", name: "Fixture Creator", username: "fixture_creator", profile_image_url: "https://pbs.twimg.com/profile_images/fixture.jpg" }],
      media: [{ media_key: "3_image", type: "photo", url: "https://pbs.twimg.com/media/fixture.jpg", width: 800, height: 600 }],
    },
  };
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("lookup targets only selected IDs with full-text fields and bounded expansions", () => {
  const before = xSearchIdentity(), request = xLookupRequest(ids), url = xLookupURL(ids);
  assert.equal(url.origin + url.pathname, "https://api.x.com/2/tweets");
  assert.deepEqual(new Set(url.searchParams.get("ids")!.split(",")), new Set(ids));
  for (const field of ["created_at", "author_id", "entities", "note_tweet", "attachments", "conversation_id", "in_reply_to_user_id", "referenced_tweets"])
    assert.ok(url.searchParams.get("tweet.fields")!.split(",").includes(field), field);
  assert.equal(url.searchParams.get("expansions"), "author_id,attachments.media_keys");
  assert.equal(url.searchParams.get("media.fields"), before.fields["media.fields"]);
  assert.equal(url.searchParams.get("user.fields"), before.fields["user.fields"]);
  for (const key of ["query", "since_id", "max_results", "next_token", "post.fields"])
    assert.equal(url.searchParams.has(key), false, key);
  assert.equal(request.url, url.toString());
  assert.equal(request.endpoint, "https://api.x.com/2/tweets");
  assert.deepEqual(new Set(request.ids), new Set(ids));
  for (const [field, value] of Object.entries(request.fields)) assert.equal(url.searchParams.get(field), value);
  assert.match(request.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(request.requestFingerprint, digest(request.url));
  assert.deepEqual(xLookupRequest(ids), request);
  assert.notEqual(xLookupRequest(["102"]).fingerprint, request.fingerprint);
  assert.notEqual(xLookupRequest(["102"]).requestFingerprint, request.requestFingerprint);
  assert.equal(xSearchFingerprint, before.fingerprint);
  assert.deepEqual(xSearchIdentity(), before, "Selecting hydration must not mutate discovery configuration or its cursor identity");
  assert.doesNotMatch(JSON.stringify(request), /bearer|authorization/i);
});

test("lookup rejects duplicate, empty, oversized and malformed ID selections before transport", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("Unexpected fetch"); });
  const invalid: readonly string[][] = [[], ["100", "100"], Array.from({ length: 11 }, (_, index) => String(index + 1)),
    [""], [" 100"], ["-1"], ["1.0"], ["1&ids=200"], ["9".repeat(20)]];
  for (const selection of invalid) {
    assert.throws(() => xLookupURL(selection));
    assert.throws(() => xLookupRequest(selection));
    assert.throws(() => parseXLookupResponse(fixture(), selection));
    await assert.rejects(lookupX("synthetic-bearer", selection));
  }
  assert.equal(calls, 0);
  const maximum = Array.from({ length: 10 }, (_, index) => String(1999999999999999999n - BigInt(index)));
  assert.equal(xLookupURL(maximum).searchParams.get("ids")!.split(",").length, 10);
});

test("lookup accepts exact IDs in any response order without search cursor metadata", () => {
  const body = fixture(), original = structuredClone(body);
  body.data.reverse();
  const result = parseXLookupResponse(body, ids);
  assert.deepEqual(result.posts, body.data);
  assert.deepEqual(result.media, body.includes.media);
  assert.equal(result.creators[0].externalID, "9");
  assert.equal(result.creators[0].username, "fixture_creator");
  assert.equal(result.coverage.posts, 2);
  assert.equal(result.coverage.longTextPosts, 2);
  assert.equal(result.coverage.noteTweetPosts, 1);
  assert.equal(result.coverage.notePostPosts, 1);
  assert.equal(result.coverage.expandedMediaKeys, 1);
  assert.equal(result.coverage.hasNextPage, false);
  body.data.reverse();
  assert.deepEqual(body, original, "Parsing must preserve source bytes and metadata");
});

test("hydrated full notes and their media can become exact native drafts while publication remains blocked", () => {
  const body = fixture(), hydrated = parseXLookupResponse(body, ids);
  const result = convertXDiscovery([{ name: "2026-10-12.json", data: hydrated }]);
  assert.equal(result.candidates.length, 2);
  const image = result.candidates.find(item => item.id === "x-post-100")!;
  assert.equal(image.prompt, imageBody);
  assert.equal(image.kind, "image");
  assert.equal(image.media?.imageURL, body.includes.media[0].url);
  assert.equal(image.creator?.externalID, "9");
  assert.equal(image.source.license, "Unspecified");
  assert.equal(image.reviewStatus, "draft");
  assert.equal(result.candidates.find(item => item.id === "x-post-101")!.prompt, storyBody);
  assert.deepEqual(result.records.map(record => record.fullTextSource), ["note_tweet", "note_post"]);
  assert.ok(result.records.every(record => record.reason === nativeXPublicationBlocker));
  assert.equal(result.report.publicationBlocked, 2);
  const unresolved = parseXLookupResponse({ data: [{ id: "100", author_id: "9", text: "Synthetic announcement without prompt instructions." }] }, ["100"]);
  assert.equal(unresolved.coverage.longTextPosts, 0);
  const blocked = convertXDiscovery([{ name: "2026-10-12.json", data: unresolved }]);
  assert.equal(blocked.candidates.length, 0);
  assert.equal(blocked.records[0].reason, "missing-prompt-boundary", "A successful lookup does not prove prompt completeness");
});

test("missing, unexpected, duplicate and partially errored results cannot replace the selected sources", () => {
  const body = fixture();
  const cases: unknown[] = [null, [], {}, { data: [] }, { data: [body.data[0]] },
    { ...body, data: [body.data[0], body.data[0]] },
    { ...body, data: [body.data[0], { ...body.data[1], id: "999" }] },
    { ...body, data: [...body.data, { ...body.data[1], id: "999" }] },
    { ...body, errors: [{ resource_id: "100", detail: "synthetic-bearer private API detail" }] },
    { ...body, errors: "invalid" }];
  for (const value of cases) assert.throws(() => parseXLookupResponse(value, ids), error => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /synthetic-bearer|private API detail/);
    return true;
  });
  assert.equal(parseXLookupResponse({ ...body, errors: [] }, ids).posts.length, 2);
});

test("malformed posts or expansions fail closed instead of silently dropping fields", () => {
  const body = fixture();
  const cases: unknown[] = [
    { ...body, data: [{ id: "100", text: "Missing author" }, body.data[1]] },
    { ...body, data: [{ ...body.data[0], author_id: "bad" }, body.data[1]] },
    { ...body, data: [{ ...body.data[0], text: 42 }, body.data[1]] },
    { ...body, data: [{ ...body.data[0], note_tweet: { text: "" } }, body.data[1]] },
    { ...body, data: [{ ...body.data[0], note_post: { text: "x".repeat(50_001) } }, body.data[1]] },
    { ...body, data: [{ ...body.data[0], entities: { urls: "invalid" } }, body.data[1]] },
    { ...body, data: [{ ...body.data[0], attachments: { media_keys: 42 } }, body.data[1]] },
    { ...body, includes: { users: [{ id: "9", name: "Fixture", username: "bad name" }] } },
    { ...body, includes: { users: [...body.includes.users, ...body.includes.users] } },
    { ...body, includes: { media: [{ media_key: "3_image", type: "photo", url: 42 }] } },
    { ...body, includes: { media: [...body.includes.media, ...body.includes.media] } },
  ];
  for (const value of cases) assert.throws(() => parseXLookupResponse(value, ids));
});

test("lookup transport sends exactly one authenticated request with a one-minute deadline", async t => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const signal = new AbortController().signal;
  const timeout = t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, 60_000); return signal;
  });
  t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: url.toString(), init }); return Response.json(fixture());
  });
  const result = await lookupX("synthetic-bearer", ids);
  assert.equal(calls.length, 1); assert.equal(timeout.mock.callCount(), 1);
  assert.equal(calls[0].url, xLookupURL(ids).toString());
  assert.equal(calls[0].init?.redirect, "manual");
  assert.equal(calls[0].init?.signal, signal);
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), "Bearer synthetic-bearer");
  assert.deepEqual(result.request, xLookupRequest(ids));
  assert.doesNotMatch(JSON.stringify({ request: result.request, coverage: result.coverage }), /synthetic-bearer|authorization/i);
});

test("HTTP errors and redirects are never retried or followed and discard private response bodies", async t => {
  let calls = 0, status = 429;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("synthetic-bearer private API detail", { status, headers: { location: "https://other.example/", "retry-after": "1" } });
  });
  for (status of [401, 429, 500, 302]) {
    const before = calls;
    await assert.rejects(lookupX("synthetic-bearer", ids), error => {
      assert.ok(error instanceof Error); assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(error.message, /synthetic-bearer|private API detail|other\.example/); return true;
    });
    assert.equal(calls, before + 1);
  }
});

test("network, JSON and body-cancellation failures keep diagnostics bounded and private", async t => {
  let calls = 0;
  const mock = t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("synthetic-bearer private transport detail"); });
  const privateFailure = (error: unknown) => {
    assert.ok(error instanceof Error); assert.match(error.message, /X lookup/);
    assert.doesNotMatch(error.message, /synthetic-bearer|private transport detail/); return true;
  };
  await assert.rejects(lookupX("synthetic-bearer", ids), privateFailure);
  assert.equal(calls, 1);
  mock.mock.mockImplementation(async () => { calls++; return new Response("{ synthetic-bearer"); });
  await assert.rejects(lookupX("synthetic-bearer", ids), privateFailure);
  assert.equal(calls, 2);
  mock.mock.mockImplementation(async () => {
    calls++;
    return new Response(new ReadableStream({ cancel() { throw new Error("synthetic-bearer private transport detail"); } }), { status: 401 });
  });
  await assert.rejects(lookupX("synthetic-bearer", ids), privateFailure);
  assert.equal(calls, 3);
});

test("lookup enforces decoded byte limits even when advertised compressed size is smaller", async t => {
  let calls = 0, cancelled = false;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(250_001)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-length": "100", "content-encoding": "gzip" } });
  });
  await assert.rejects(lookupX("synthetic-bearer", ids), /response exceeded its limit or was interrupted/);
  assert.equal(calls, 1); assert.equal(cancelled, true);
});
