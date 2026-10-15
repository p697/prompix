import { test } from "node:test";
import assert from "node:assert/strict";
import { retryConnection } from "./transient-retry.ts";
test("safe connection establishment retries bounded transient failures with backoff", async () => {
  let calls = 0; const delays: number[] = [];
  const value = await retryConnection(async () => { if (++calls < 4) throw new Error("Connection terminated unexpectedly"); return "connected"; }, async ms => { delays.push(ms); });
  assert.equal(value, "connected"); assert.deepEqual(delays, [1000, 3000, 8000]); assert.equal(calls, 4);
});
test("permanent auth, certificate, SQL errors and strings are never retried", async () => {
  for (const error of [Object.assign(new Error("password authentication failed"), { code: "28P01" }), new Error("certificate verify failed"), Object.assign(new Error("deadlock"), { code: "40P01" }), "Connection terminated unexpectedly"]) {
    let calls = 0;
    await assert.rejects(retryConnection(async () => { calls++; throw error; }, async () => assert.fail("Must not sleep")), caught => caught === error);
    assert.equal(calls, 1);
  }
});
test("exhausted retries preserve the last connection error", async () => {
  let calls = 0; const error = Object.assign(new Error("reset"), { code: "ECONNRESET" });
  await assert.rejects(retryConnection(async () => { calls++; throw error; }, async () => {}), caught => caught === error);
  assert.equal(calls, 4);
});
