import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRapidAPISources } from "./rapidapi-sources.ts";
import { convertXDiscovery, fullXText } from "./x-intake.ts";
import { unchangedXStandalone } from "./x-recheck.ts";

const text = "Image prompt:\nCreate an original watercolor garden with warm morning light, delicate green leaves and a clear focal point.";
const at = "2026-10-17T14:00:00.000Z";
const photo = (key: string) => ({ media_key: key, type: "photo", media_url_https: `https://pbs.twimg.com/media/${key}.jpg`,
  ext_media_availability: { status: "Available" } });
function tweet(id = "101"): any {
  return { __typename: "Tweet", rest_id: id,
    core: { user_results: { result: { __typename: "User", rest_id: "9", core: { name: "Fixture", screen_name: "fixture" },
      privacy: { protected: false }, legacy: {} } } },
    legacy: { id_str: id, user_id_str: "9", full_text: text, created_at: at, conversation_id_str: id,
      is_quote_status: false, entities: { urls: [] }, extended_entities: { media: [photo("first"), photo("second")] } } };
}
const envelope = (...tweets: unknown[]) => ({ result: { tweetResult: tweets.map(result => ({ result })) } });

test("captured GraphQL source retains complete notes, entities, gallery, video and reply identity", () => {
  const t = tweet(); t.legacy.full_text = "Display text…";
  const urls = [{ url: "https://t.co/fixture", expanded_url: "https://example.com/art" }];
  t.note_tweet = { note_tweet_results: { result: { text, entity_set: { urls } } } };
  t.legacy.in_reply_to_status_id_str = "100"; t.legacy.in_reply_to_user_id_str = "8";
  t.legacy.extended_entities.media.push({ ...photo("video"), type: "video", video_info: { variants: [
    { content_type: "video/mp4", bitrate: 128, url: "https://video-s.twimg.com/fixture.mp4?tag=1" },
    { content_type: "application/x-mpegURL", url: "https://video.twimg.com/fixture.m3u8" },
  ] } });
  const r = parseRapidAPISources(envelope(t), ["101"]);
  assert.equal(r.provider, "rapidapi"); assert.equal(fullXText(r.posts[0]).text, text);
  assert.deepEqual(r.posts[0].note_tweet?.entities?.urls, urls);
  assert.deepEqual(r.posts[0].referenced_tweets, [{ type: "replied_to", id: "100" }]);
  assert.equal(r.posts[0].in_reply_to_user_id, "8"); assert.equal(r.media.length, 3);
  assert.deepEqual(r.media[2].variants, [{ content_type: "video/mp4", bit_rate: 128, url: "https://video.twimg.com/fixture.mp4" }]);
});

test("unavailable, protected, withheld and unavailable-media responses remain unknown", () => {
  for (const mutate of [
    (t: any) => { t.core.user_results.result = { __typename: "UserUnavailable" }; },
    (t: any) => { t.core.user_results.result.privacy.protected = true; },
    (t: any) => { t.core.user_results.result.legacy.withheld_in_countries = ["XX"]; },
    (t: any) => { t.legacy.withheld_in_countries = ["XX"]; },
    (t: any) => { t.legacy.extended_entities.media[0].ext_media_availability.status = "Unavailable"; },
  ]) {
    const t = tweet(); mutate(t); const r = parseRapidAPISources(envelope(t), ["101"]);
    assert.deepEqual(r.posts, []); assert.deepEqual(r.unknownIDs, ["101"]);
  }
  assert.deepEqual(parseRapidAPISources(envelope({ __typename: "TweetUnavailable" }), ["101"]).unknownIDs, ["101"]);
});

test("missing privacy, contradictory IDs, incomplete notes and references fail closed", () => {
  for (const mutate of [
    (t: any) => { delete t.core.user_results.result.privacy; },
    (t: any) => { t.legacy.id_str = "102"; },
    (t: any) => { t.legacy.user_id_str = "8"; },
    (t: any) => { t.legacy.in_reply_to_status_id_str = "100"; },
    (t: any) => { t.legacy.is_quote_status = true; },
    (t: any) => { t.note_tweet = { note_tweet_results: { result: { text } } }; },
    (t: any) => { t.legacy.created_at = "bad-date"; },
    (t: any) => { t.legacy.extended_entities.media.push({ ...photo("first"), media_url_https: "https://pbs.twimg.com/other.jpg" }); },
    (t: any) => { t.legacy.entities.media = [{ id_str: "99" }]; },
  ]) { const t = tweet(); mutate(t); assert.throws(() => parseRapidAPISources(envelope(t), ["101"])); }
});

test("200 captured sources are normalized without truncating to the reused validator's fifty-row limit", () => {
  const tweets = Array.from({ length: 200 }, (_, i) => tweet(String(1000 + i)));
  const r = parseRapidAPISources(envelope(...tweets), tweets.map(t => t.rest_id));
  assert.equal(r.posts.length, 200); assert.equal(r.creators.length, 1); assert.equal(r.media.length, 2);
  const t = tweet(); delete t.__typename;
  assert.equal(parseRapidAPISources(envelope({ __typename: "TweetWithVisibilityResults", tweet: t }), ["101"]).posts.length, 1);
  tweets[50].core.user_results.result.core.name = "Conflicting";
  assert.throws(() => parseRapidAPISources(envelope(...tweets), tweets.map(t => t.rest_id)), /attribution/);
  const restricted = tweet("102"); restricted.core.user_results.result.privacy.protected = true;
  assert.throws(() => parseRapidAPISources(envelope(tweet(), restricted), ["101", "102"]), /attribution/);
});

test("real extraction and strict revision checks reject added or removed media, edits and changed attribution", () => {
  const r = parseRapidAPISources(envelope(tweet()), ["101"]);
  const candidate = convertXDiscovery([{ name: "synthetic-official-baseline", data: { ...r, capturedAt: at } }]).candidates[0];
  assert.ok(candidate); assert.equal(unchangedXStandalone(candidate, r, at), true);
  for (const mutate of [
    (t: any) => { t.legacy.extended_entities.media.pop(); },
    (t: any) => { t.legacy.extended_entities.media.push(photo("third")); },
    (t: any) => { t.legacy.full_text += " Change to evening."; },
    (t: any) => { t.core.user_results.result.core.name = "Renamed"; },
  ]) {
    const t = tweet(); mutate(t);
    assert.equal(unchangedXStandalone(candidate, parseRapidAPISources(envelope(t), ["101"]), at), false);
  }
});
