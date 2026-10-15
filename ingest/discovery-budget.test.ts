import { test } from "node:test";
import assert from "node:assert/strict";
import { windowBudget } from "./discovery-budget.ts";
test("daily quota is released cumulatively in four windows, preserving carryover and rounding down", () => {
  for (const [hour, expected] of [[0, 3], [5, 3], [6, 6], [11, 6], [12, 9], [17, 9], [18, 12], [23, 12]])
    assert.equal(windowBudget(12, new Date(`2026-10-15T${String(hour).padStart(2, "0")}:00:00Z`)), expected);
  assert.equal(windowBudget(1, new Date("2026-10-15T00:00:00Z")), 0);
  assert.equal(windowBudget(1, new Date("2026-10-15T18:00:00Z")), 1);
  assert.throws(() => windowBudget(-1, new Date()), /Invalid/);
  assert.throws(() => windowBudget(12, new Date("invalid")), /Invalid/);
});
