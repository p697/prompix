import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewRequestLimit, appendReviewAttempt } from "./review-budget.ts";
import { editorialAttemptSchema, editorialLedgerSchema } from "./editorial-runner.ts";

const day = "2026-10-12";
const attempt = editorialAttemptSchema.parse({ day, requests: 1, model: "gpt-5.6-luna", reservedAt: `${day}T00:00:00Z`,
  candidateIDs: ["synthetic-source"], inputCharacters: 100, state: "completed" });

test("review limits accept only bounded integer counts, including explicit zero", () => {
  assert.equal(reviewRequestLimit(), 4);
  for (const value of [0, 4, 20, 32, 40, 64, "0", "4", "20", "40", "64"]) assert.equal(reviewRequestLimit(value), Number(value));
  for (const value of [null, true, -1, 1.5, 65, Infinity, NaN, "", "4.0", "4e0", " 4", "4 ", "-1", "65"])
    assert.throws(() => reviewRequestLimit(value), /request limit/);
});

test("daily journals reject damaged counts, mixed dates, extra fields, and a request after interruption", () => {
  const valid = { schemaVersion: 2, day, requests: 2, attempts: [attempt, { ...attempt, state: "reserved" }] };
  assert.equal(editorialLedgerSchema.safeParse(valid).success, true);
  for (const corrupt of [
    { ...valid, requests: 1 }, { ...valid, requests: 0, attempts: [] }, { ...valid, day: "2026-10-13" },
    { ...valid, unexpected: true }, { ...valid, attempts: [{ ...attempt, state: "failed" }, attempt] },
    { ...valid, attempts: [{ ...attempt, state: "reserved" }, attempt] },
  ]) assert.equal(editorialLedgerSchema.safeParse(corrupt).success, false);
});


test("expanding the supported budget preserves forty spent requests and never clears an unfinished attempt", () => {
  const previous = editorialLedgerSchema.parse({ schemaVersion: 2, day, requests: 40, attempts: Array.from({ length: 40 }, () => ({ ...attempt })) });
  const expanded = appendReviewAttempt(previous, { ...attempt, state: "reserved" });
  assert.equal(expanded.requests, 41); assert.equal(previous.requests, 40);
  assert.deepEqual(expanded.attempts.slice(0, 40), previous.attempts);
  assert.equal(editorialLedgerSchema.safeParse(expanded).success, true);
  assert.throws(() => appendReviewAttempt(expanded, { ...attempt, state: "reserved" }), /unfinished/);
});
