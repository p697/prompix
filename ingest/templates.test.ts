import { test } from "node:test";
import assert from "node:assert/strict";
import { publicationText } from "./templates.ts";
import { fingerprint, type Candidate } from "./sources.ts";
import { applyEditorialReviews, type Reviews } from "./editorial.ts";

const metadata = { title: "A small weather station", summary: "Make a diagram.", example: "Change the subject, keeping its labels.", tags: ["Design"], previewLabel: "Community example" };
function fixture(prompt: string): { candidate: Candidate; reviews: Reviews } {
  const candidate: Candidate = { id: "sample", kind: "image", ...metadata, prompt, model: "Image model", toolURL: null, artwork: "editorial", media: null, source: { name: "Community", url: null, license: "CC0-1.0", method: "Collected" }, fingerprint: fingerprint(prompt), featured: false, reviewStatus: "candidate" };
  return { candidate, reviews: { sample: { fingerprint: candidate.fingerprint, reviewedAt: "2026-10-12T00:00:00Z", metadata } } };
}

test("publication expands exact default syntax without altering reviewed source or provenance", () => {
  const { candidate, reviews } = fixture('Draw {argument name="subject" default="a tiny weather station"} in {argument name="color" default="青绿"}.');
  const original = structuredClone(candidate);
  const approved = applyEditorialReviews([candidate], reviews)[0];
  assert.equal(publicationText(approved, reviews), "Draw a tiny weather station in 青绿.");
  assert.deepEqual(candidate, original);
  assert.equal(approved.prompt, original.prompt);
  assert.equal(approved.fingerprint, original.fingerprint);
  assert.deepEqual(approved.source, original.source);
  assert.equal(reviews.sample.fingerprint, original.fingerprint);
  assert.equal(publicationText(candidate, {}), original.prompt);
  assert.equal(publicationText({ ...candidate, fingerprint: "a".repeat(64) }, reviews), original.prompt);
});

test("JSON templates keep valid structure and transform only string values", () => {
  const key = '{argument name="key" default="unchanged"}';
  const input = { title: '{argument name="title" default="Weather & light"}', rows: ['{argument name="city" default="Osaka"}', { note: 'Keep {detail}\nand a "quote".' }], [key]: true, count: 3, missing: null };
  const { candidate, reviews } = fixture(JSON.stringify(input));
  assert.deepEqual(JSON.parse(publicationText(candidate, reviews)), { ...input, title: "Weather & light", rows: ["Osaka", { note: 'Keep {detail}\nand a "quote".' }] });
  const precise = fixture(' { "large" : 9007199254740993, "title" : "{argument name=\\"title\\" default=\\"Weather\\"}" } ');
  assert.equal(publicationText(precise.candidate, precise.reviews), ' { "large" : 9007199254740993, "title" : "Weather" } ');
});

test("unknown macros, residual placeholders and JSON without defaults stay intact", () => {
  for (const prompt of [
    'Draw {subject} and [your name].',
    '{argument name="subject"}',
    '{argument default="cloud" name="subject"}',
    '{argument name="subject" default="cloud" required="true"}',
    '{argument name="subject" default="a {cloud}"}',
    '{argument name="subject" default="cloud}',
    ' { "note" : "Keep {detail}" } ',
  ]) {
    const { candidate, reviews } = fixture(prompt);
    assert.equal(publicationText(candidate, reviews), prompt);
  }
  const { candidate, reviews } = fixture('Use {argument name="color" default="blue"} with {unfilled} and {argument name="other"}.');
  assert.equal(publicationText(candidate, reviews), 'Use blue with {unfilled} and {argument name="other"}.');
});

test("reviewed JSON defaults preserve a named input placeholder without leaking source macros", () => {
  const source = JSON.stringify({ subject: '{argument name="person" default="{{PERSON_NAME_OR_IMAGE}}"}', lighting: "Butterfly lighting" });
  const { candidate, reviews } = fixture(source);
  const published = publicationText(candidate, reviews);
  assert.deepEqual(JSON.parse(published), { subject: "{{PERSON_NAME_OR_IMAGE}}", lighting: "Butterfly lighting" });
  assert.equal(candidate.prompt, source);
  assert.equal(publicationText(candidate, {}), source);
  assert.ok(!published.includes("{argument"));
});
