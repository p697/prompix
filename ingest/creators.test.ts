import { test } from "node:test";
import assert from "node:assert/strict";
import type { Prompt } from "../packages/schema/catalog.ts";
import { creatorFromURL, inferCreator, mergeCreatorCache, enrichCreators, mirrorCreatorAvatars } from "./creators.ts";
import { parseXUsers, xSearchURL, xUserLookupURL } from "./x.ts";
import { avatarDownloadURLs, publishAvatar } from "./creator-images.ts";

const item: Prompt = {
  id: "test-story", kind: "text", title: "Story", summary: "Original test.", prompt: "Create an original story.", example: "Story outline.",
  tags: ["test"], model: "Test", toolURL: null, artwork: "test", previewLabel: "Test", media: null,
  source: { name: "Community", author: "Studio Name", url: "https://x.com/Studio_one/status/123", license: "Original", method: "Test" },
};

test("creator identity uses normalized source handles and never invents an account from a display name", () => {
  const creator = inferCreator(item.source)!;
  assert.equal(creator.id, "x-studio_one");
  assert.equal(creator.username, "Studio_one");
  assert.equal(creator.displayName, "Studio Name");
  assert.equal(creator.profileURL, "https://x.com/Studio_one");
  assert.equal(creator.avatarURL, undefined);
  assert.equal(creatorFromURL("https://twitter.com/Studio_one/status/123")?.id, creator.id);
  for (const url of ["https://x.com/intent/tweet", "https://x.com/i/web/status/123", "http://x.com/studio", "https://evil.test/studio", "https://user:secret@x.com/studio"]) assert.equal(creatorFromURL(url), undefined);
  assert.equal(inferCreator({ ...item.source, url: null }), undefined);
  assert.equal(inferCreator({ ...item.source, name: "prompts.chat", author: "two people", url: null }), undefined);
});

test("X account ID survives renamed handles, and source posts share one enriched creator", () => {
  const initial = parseXUsers([{ id: "12345", username: "Studio_one", name: "Studio", profile_image_url: "https://pbs.twimg.com/profile_images/1/photo.jpg" }]);
  let cache = mergeCreatorCache({}, initial);
  cache = mergeCreatorCache(cache, parseXUsers([{ id: "12345", username: "Studio_two", name: "New Studio" }]));
  assert.equal(cache["x-studio_one"].id, "x-id-12345");
  assert.equal(cache["x-studio_one"].username, "Studio_two");
  assert.equal(cache["x-studio_two"].id, "x-id-12345");
  const enriched = enrichCreators([item, { ...item, id: "second-story" }], cache);
  assert.equal(enriched[0].creator?.profileURL, "https://x.com/Studio_two");
  assert.equal(enriched[0].creator?.id, enriched[1].creator?.id);
  assert.equal(item.creator, undefined, "Cached enrichment does not rewrite the raw source object");
});

test("X author expansions retain real structured fields and validate remote photos", () => {
  const url = xSearchURL("1234");
  assert.equal(url.searchParams.get("expansions"), "author_id");
  assert.match(url.searchParams.get("user.fields")!, /profile_image_url/);
  assert.equal(url.searchParams.get("since_id"), "1234");
  assert.equal(url.searchParams.get("max_results"), "10", "Author enrichment does not increase paid post search size");
  assert.equal(xUserLookupURL(["Studio", "studio"]).searchParams.get("usernames"), "studio");
  assert.throws(() => xUserLookupURL(Array(101).fill("studio")), /1–100/);
  assert.throws(() => xUserLookupURL(["studio,another"]), /valid usernames/);
  const users = parseXUsers([
    { id: "99", username: "studio", name: "Studio", description: "Creates art", profile_image_url: "https://evil.test/photo.jpg" },
    { id: "not-a-real-id", username: "bad", name: "Bad" },
  ]);
  assert.equal(users.length, 1);
  assert.equal(users[0].externalID, "99");
  assert.equal(users[0].bio, "Creates art");
  assert.equal(users[0].avatarURL, undefined);
});

test("avatars mirror once per URL; a missing photo preserves creator identity and all prompts", async () => {
  const creator = { ...inferCreator(item.source)!, avatarURL: "https://pbs.twimg.com/profile_images/a.jpg" };
  const inputs = [{ ...item, creator }, { ...item, id: "another", creator }, { ...item, id: "without-photo", creator: { ...creator, id: "x-missing", avatarURL: "https://pbs.twimg.com/profile_images/missing.jpg" } }];
  const calls: string[] = []; const failures: string[] = [];
  const outputs = await mirrorCreatorAvatars(inputs, async url => {
    calls.push(url);
    if (url.includes("missing")) throw new Error("HTTP 404");
    return "https://api.prompix.dev/media/avatar.jpg";
  }, id => failures.push(id));
  assert.equal(calls.length, 2);
  assert.deepEqual(failures, ["x-missing"]);
  assert.equal(outputs.length, inputs.length);
  assert.equal(outputs[0].creator?.avatarURL, "https://api.prompix.dev/media/avatar.jpg");
  assert.equal(outputs[2].creator?.avatarURL, undefined);
  assert.equal(outputs[2].creator?.id, "x-missing");
  assert.equal(inputs[0].creator.avatarURL, creator.avatarURL);
});

test("avatar rendition tries preserve the original photo and reuse only verified own-media cache entries", async () => {
  const original = "https://pbs.twimg.com/profile_images/1/photo_normal.jpg";
  assert.deepEqual(avatarDownloadURLs(original), ["https://pbs.twimg.com/profile_images/1/photo_400x400.jpg", original]);
  const other = "https://github.com/studio.png?size=160";
  assert.deepEqual(avatarDownloadURLs(other), [other]);
  const mirrored = `https://api.prompix.dev/media/${"a".repeat(64)}.jpg`;
  assert.equal(await publishAvatar(original, "/unused", { [original]: mirrored }, async () => { throw new Error("Must reuse cache"); }), mirrored);
  await assert.rejects(publishAvatar("https://evil.test/image.jpg", "/unused", { "https://evil.test/image.jpg": "https://evil.test/cached.jpg" }, async () => {}), /not allowlisted/);
});
