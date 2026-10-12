import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { parseXSearchResponse, searchX, xSearchAuthors, xSearchFingerprint, xSearchIdentity, xSearchRequest, xSearchURL } from "./x.ts";

// Synthetic instructions and identities only. These tests never contact X.
function fixture() {
  return {
    data: [
      {
        id: "104", author_id: "9", text: "Synthetic preview https://t.co/example",
        entities: { urls: [{ url: "https://t.co/example", expanded_url: "https://example.test/source", start: 18, end: 38 }] },
        note_tweet: { text: `Image prompt:\n\n\`\`\`text\n${"Create an original paper landscape with tiny houses.\n".repeat(12)}保留原文和空格。\n\`\`\``,
          entities: { urls: [{ url: "https://t.co/image", expanded_url: "https://example.test/image", start: 700, end: 718 }], hashtags: [{ tag: "synthetic", start: 0, end: 9 }] } },
        attachments: { media_keys: ["3_a", "3_b"], poll_ids: ["77"] }, display_text_range: [0, 38],
        created_at: "2026-10-12T01:00:00Z", public_metrics: { like_count: 4 }, lang: "en",
      },
      {
        id: "103", author_id: "10", text: "Synthetic short preview",
        note_post: { text: "Prompt:\nWrite an original three-act adventure with a quiet ending.", entities: {} },
        note_tweet: { text: "Documented legacy response alias.", entities: { urls: [] } },
        attachments: { media_keys: ["3_a"] },
      },
      { id: "102", author_id: "9", text: "Prompt:\nMake a responsive website with a readable layout.", entities: {} },
      { id: "101", text: "Synthetic short post without author expansion." },
    ],
    includes: {
      users: [{ id: "9", name: "Example Creator", username: "example_creator", profile_image_url: "https://pbs.twimg.com/profile_images/synthetic.jpg" }],
      media: [
        { media_key: "3_a", type: "photo", url: "https://pbs.twimg.com/media/synthetic.jpg", width: 800, height: 600 },
        { media_key: "7_unreferenced", type: "video", preview_image_url: "https://pbs.twimg.com/media/synthetic-cover.jpg",
          variants: [{ content_type: "video/mp4", bit_rate: 1000, url: "https://video.twimg.com/synthetic.mp4" }] },
      ],
    },
    meta: { result_count: 4, newest_id: "104", oldest_id: "101", next_token: "synthetic-next-page" },
  };
}

test("curated X search is a single ten-result recent query with complete requested expansions", () => {
  const url = xSearchURL("1234"), identity = xSearchIdentity();
  assert.equal(url.origin + url.pathname, "https://api.x.com/2/tweets/search/recent");
  assert.equal(url.searchParams.get("max_results"), "10");
  assert.equal(url.searchParams.get("sort_order"), "recency");
  assert.equal(url.searchParams.get("since_id"), "1234");
  assert.equal(url.searchParams.get("query"), identity.query);
  assert.ok(identity.query.length < 512);
  for (const author of xSearchAuthors) assert.ok(identity.query.includes(`from:${author}`));
  assert.match(identity.query, /\(prompt OR 提示词 OR プロンプト\)/);
  for (const filter of ["-is:retweet", "-is:reply", "-is:quote"]) assert.ok(identity.query.includes(filter));
  assert.doesNotMatch(identity.query, /GPT|Claude|Nano Banana|has:links/);
  for (const [field, value] of Object.entries(identity.fields)) assert.equal(url.searchParams.get(field), value);
  assert.ok(url.searchParams.get("tweet.fields")?.split(",").includes("note_tweet"));
  assert.equal(url.searchParams.get("tweet.fields")?.split(",").includes("display_text_range"), false, "Avoid requesting fields not consumed by intake");
  assert.equal(url.searchParams.has("post.fields"), false, "Never combine inconsistent documentation conventions into one paid probe");
  assert.equal(url.searchParams.has("next_token"), false);
  assert.equal(xSearchURL().searchParams.has("since_id"), false);
});

test("query fingerprint covers every request parameter except the cursor and request fingerprint covers the cursor", () => {
  const { fingerprint, ...configuration } = xSearchIdentity();
  assert.equal(fingerprint, createHash("sha256").update(JSON.stringify(configuration)).digest("hex"));
  assert.equal(fingerprint, xSearchFingerprint);
  for (const cursor of [undefined, "1", "2"]) {
    const request = xSearchRequest(cursor);
    assert.equal(request.fingerprint, fingerprint);
    assert.equal(request.since, cursor);
    assert.equal(request.url, xSearchURL(cursor).toString());
    assert.equal(request.requestFingerprint, createHash("sha256").update(request.url).digest("hex"));
  }
  assert.notEqual(xSearchRequest("1").requestFingerprint, xSearchRequest("2").requestFingerprint);
  assert.throws(() => { (xSearchIdentity().fields as Record<string, string>)["tweet.fields"] = "id"; }, TypeError);
  assert.throws(() => { (xSearchAuthors as string[]).push("unknown"); }, TypeError);
  assert.equal(xSearchIdentity().fingerprint, fingerprint);
});

test("invalid cursors never silently turn an incremental search into a broad paid query", () => {
  for (const cursor of ["", " 123", "-1", "1.0", "1&query=other", "9".repeat(20)]) {
    assert.throws(() => xSearchURL(cursor), /Invalid X search cursor/);
    assert.throws(() => parseXSearchResponse({ meta: { result_count: 0 } }, cursor), /Invalid X search cursor/);
  }
});

test("search preserves exact long instructions, entity offsets, attachments and media variants", () => {
  const body = fixture(), result = parseXSearchResponse(body, "100");
  assert.deepEqual(result.posts, body.data);
  assert.deepEqual(result.media, body.includes.media);
  assert.equal(result.newest, "104");
  assert.equal(result.creators.length, 1);
  assert.equal(result.creators[0].externalID, "9");
  assert.equal(result.creators[0].username, "example_creator");
  assert.equal(result.creators[0].avatarURL, body.includes.users[0].profile_image_url);
});

test("field coverage counts post availability and matched expansions without logging source text", () => {
  const coverage = parseXSearchResponse(fixture()).coverage;
  assert.deepEqual(coverage, {
    posts: 4, longTextPosts: 2, noteTweetPosts: 2, notePostPosts: 1,
    entityPosts: 2, longTextEntityPosts: 2, selectedTextEntityPosts: 3, urlEntityPosts: 1,
    attachmentPosts: 2, mediaKeyPosts: 2, referencedMediaKeys: 2, expandedMediaKeys: 1, mediaObjects: 2,
    authorIDPosts: 3, uniqueAuthorIDs: 2, authorProfiles: 1, matchedAuthorPosts: 2, missingAuthorProfiles: 1, hasNextPage: true,
  });
  for (const value of Object.values(coverage)) assert.ok(typeof value === "number" || typeof value === "boolean");
  const missing = parseXSearchResponse({ data: [{ id: "2", author_id: "7", text: "Synthetic plain text", attachments: {} }], meta: { result_count: 1, newest_id: "2" } }).coverage;
  assert.equal(missing.longTextPosts, 0);
  assert.equal(missing.attachmentPosts, 1);
  assert.equal(missing.mediaKeyPosts, 0);
  assert.equal(missing.authorProfiles, 0);
  assert.equal(missing.matchedAuthorPosts, 0);
  assert.equal(missing.missingAuthorProfiles, 1);
});

test("only an explicit zero result count may be accepted as an empty search", () => {
  for (const body of [{ meta: { result_count: 0 } }, { data: [], meta: { result_count: 0 } }]) {
    const result = parseXSearchResponse(body, "100");
    assert.deepEqual(result.posts, []);
    assert.equal(result.newest, undefined);
    assert.equal(result.coverage.posts, 0);
    assert.equal(result.coverage.hasNextPage, false);
  }
  for (const body of [null, [], {}, { data: [] }, { meta: {} }, { meta: { result_count: "0" } },
    { data: null, meta: { result_count: 0 } }, { data: {}, meta: { result_count: 0 } }, { meta: { result_count: 1 } },
    { meta: { result_count: 0, newest_id: "101" } }, { meta: { result_count: 0, next_token: "next" } }])
    assert.throws(() => parseXSearchResponse(body), /cursor unchanged/);
});

test("malformed fields and partial errors fail closed before a caller can persist the cursor", () => {
  const body = fixture();
  const cases: unknown[] = [
    { ...body, errors: [{ detail: "Synthetic secret error details must not be logged" }] },
    { ...body, errors: "malformed" },
    { ...body, data: [...body.data, body.data[0]], meta: { ...body.meta, result_count: 5 } },
    { ...body, meta: { ...body.meta, result_count: 3 } },
    { ...body, data: [{ id: "invalid", text: "Synthetic" }], meta: { result_count: 1, newest_id: "104" } },
    { ...body, data: [{ id: "104" }], meta: { result_count: 1, newest_id: "104" } },
    { ...body, data: [{ id: "104", text: "Synthetic", note_tweet: { text: "" } }], meta: { result_count: 1, newest_id: "104" } },
    { ...body, data: [{ id: "104", text: "Synthetic", entities: { urls: "invalid" } }], meta: { result_count: 1, newest_id: "104" } },
    { ...body, data: [{ id: "104", text: "Synthetic", attachments: { media_keys: 4 } }], meta: { result_count: 1, newest_id: "104" } },
    { ...body, includes: { users: [{ id: "9", username: "bad name", name: "Example" }] } },
    { ...body, includes: { users: [...body.includes.users, ...body.includes.users] } },
    { ...body, includes: { media: [{ media_key: "3_a", type: "photo", url: 9 }] } },
    { ...body, includes: { media: [...body.includes.media, body.includes.media[0]] } },
    { ...body, includes: { media: [{ media_key: "3_a", type: "video", variants: [{ url: "https://example.test/a", content_type: 9 }] }] } },
  ];
  for (const value of cases) assert.throws(() => parseXSearchResponse(value), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /cursor unchanged/);
    assert.doesNotMatch(error.message, /secret error details/);
    return true;
  });
});

test("cursor metadata must match returned posts and cannot regress past the requested cursor", () => {
  const body = fixture();
  for (const meta of [
    { result_count: 4 }, { result_count: 4, newest_id: 104 }, { result_count: 4, newest_id: "invalid" },
    { result_count: 4, newest_id: "103" }, { result_count: 4, newest_id: "105" },
    { result_count: 4, newest_id: "104", oldest_id: "102" },
  ]) assert.throws(() => parseXSearchResponse({ ...body, meta }), /cursor unchanged/);
  for (const since of ["101", "104", "200"]) assert.throws(() => parseXSearchResponse(body, since), /inconsistent cursor/);
  const large = { data: [{ id: "1999999999999999999", text: "Synthetic" }, { id: "1999999999999999998", text: "Synthetic" }],
    meta: { result_count: 2, newest_id: "1999999999999999999", oldest_id: "1999999999999999998" } };
  assert.equal(parseXSearchResponse(large, "1999999999999999997").newest, large.meta.newest_id);
});

test("successful transport sends one bounded request and preserves its exact safe identity", async t => {
  const calls: { url: string; init?: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: url.toString(), init });
    return Response.json(fixture());
  });
  const result = await searchX("synthetic-bearer", "100");
  assert.equal(calls.length, 1, "Even a next_token never causes a second paid request");
  assert.equal(calls[0].url, result.request.url);
  assert.equal(calls[0].init?.redirect, "manual");
  assert.ok(calls[0].init?.signal instanceof AbortSignal);
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), "Bearer synthetic-bearer");
  assert.deepEqual(result.request, xSearchRequest("100"));
  assert.equal(result.coverage.hasNextPage, true);
  assert.doesNotMatch(JSON.stringify({ request: result.request, coverage: result.coverage }), /synthetic-bearer|Authorization/i);
});

test("HTTP errors and redirects never retry or expose response details", async t => {
  let calls = 0, status = 429;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("synthetic-bearer must stay private", { status, headers: { location: "https://api.x.com/2/tweets/search/recent", "retry-after": "1" } });
  });
  for (status of [429, 401, 500, 302]) {
    const before = calls;
    await assert.rejects(searchX("synthetic-bearer"), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(error.message, /synthetic-bearer/);
      return true;
    });
    assert.equal(calls, before + 1);
  }
});

test("network failures and invalid JSON cannot leak credentials or trigger a retry", async t => {
  let calls = 0;
  const mock = t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new Error("Synthetic transport error containing synthetic-bearer");
  });
  await assert.rejects(searchX("synthetic-bearer"), /X search request failed; cursor unchanged/);
  assert.equal(calls, 1);
  mock.mock.mockImplementation(async () => { calls++; return new Response("{ synthetic-bearer"); });
  await assert.rejects(searchX("synthetic-bearer"), /X search returned invalid JSON; cursor unchanged/);
  assert.equal(calls, 2);
  await assert.rejects(searchX("synthetic-bearer", "invalid"), /Invalid X search cursor/);
  assert.equal(calls, 2, "Invalid caller state is rejected before reserving any network work");
});

test("discarding an HTTP error body cannot expose transport diagnostics", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    cancel() { throw new Error("Synthetic private transport diagnostic"); },
  }), { status: 401 }));
  await assert.rejects(searchX("synthetic-bearer"), { message: "X search returned HTTP 401; cursor unchanged" });
});

test("search enforces decoded response byte limits even without a content-length header", async t => {
  let calls = 0, cancelled = false;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(250_001)); },
      cancel() { cancelled = true; },
    }));
  });
  await assert.rejects(searchX("synthetic-bearer"), /response exceeded its limit or was interrupted; cursor unchanged/);
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});
