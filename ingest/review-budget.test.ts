import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewRequestLimit } from "./review-budget.ts";
import { editorialAttemptSchema, editorialLedgerSchema } from "./editorial-runner.ts";

const day = "2026-10-12";
const attempt = editorialAttemptSchema.parse({ day, requests: 1, model: "gpt-5.6-luna", reservedAt: `${day}T00:00:00Z`,
  candidateIDs: ["synthetic-source"], inputCharacters: 100, state: "completed" });

test("review limits accept only bounded integer counts, including explicit zero", () => {
  assert.equal(reviewRequestLimit(), 4);
  for (const value of [0, 4, 20, "0", "4", "20"]) assert.equal(reviewRequestLimit(value), Number(value));
  for (const value of [null, true, -1, 1.5, 21, Infinity, NaN, "", "4.0", "4e0", " 4", "4 ", "-1", "21"])
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
