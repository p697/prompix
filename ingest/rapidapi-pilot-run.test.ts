import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomic, json } from "./publication.ts";
import { pilotIdentity } from "./x-pilot.ts";
import { XSpendBudget } from "./x-spend.ts";
import { RapidAPIPilotClient } from "./rapidapi-pilot.ts";
import { rapidAPICapturePlanSchema, replayRapidAPIRequest, runRapidAPIRequest } from "./rapidapi-pilot-run.ts";

const at = "2026-10-17T13:00:00.000Z";
const plan = rapidAPICapturePlanSchema.parse({ version: 1, provider: "rapidapi-twitter241", baselineSHA256: "a".repeat(64),
  baselineDigest: "b".repeat(64), negativeIDs: ["9"], requests: [
    { name: "controls", ids: ["1", "9"], afterHours: 0 }, { name: "batch", ids: ["1", "2", "9"], afterHours: 0 },
    { name: "repeat", ids: ["1", "2", "9"], afterHours: 12 }] });
const response = (ids: string[], remaining = "999") => Response.json({ result: { tweetResult:
  ids.map(rest_id => ({ result: { __typename: "Tweet", rest_id } })) } }, { headers: { "x-ratelimit-requests-remaining": remaining } });
async function fixture(run: (root: string, budget: XSpendBudget) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "prompix-rapidapi-run-"));
  try {
    const budget = new XSpendBudget(join(root, "ledger"), 20, 20, () => new Date(at));
    const fee = await budget.reserve("rapidapi", "subscription", "test-fee", 1);
    await budget.confirmRapidAPIPilotFee(fee.id);
    await run(root, budget);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("resume reuses raw captures; batch expansion and later repeats follow the frozen plan", () => fixture(async (root, budget) => {
  let calls = 0;
  const client = new RapidAPIPilotClient("secret", budget, (async url => {
    calls++; return response(new URL(String(url)).searchParams.get("tweetIds")!.split(",").filter(id => id !== "9"));
  }) as typeof fetch);
  await assert.rejects(runRapidAPIRequest(root, plan, "batch", client, at, new Date(at))); assert.equal(calls, 0);
  const control = await runRapidAPIRequest(root, plan, "controls", client, at, new Date(at));
  assert.equal(control.identityControlsPassed, true); assert.equal(control.productionSwitchAllowed, false);
  await runRapidAPIRequest(root, plan, "controls", client, at, new Date(at)); assert.equal(calls, 1);
  await runRapidAPIRequest(root, plan, "batch", client, at, new Date(at));
  await assert.rejects(runRapidAPIRequest(root, plan, "repeat", client, at, new Date(at)), /time window/);
  assert.equal(await json(join(root, "repeat.attempt.json"), null), null);
  await runRapidAPIRequest(root, plan, "repeat", client, at, new Date("2026-10-18T01:00:00Z")); assert.equal(calls, 3);
  assert.equal((await replayRapidAPIRequest(root, plan, "repeat")).returnedIDs.length, 2);
}));

test("missing positives, returned negative controls and depleted quota prevent larger paid batches", async () => {
  for (const scenario of ["missing", "negative", "quota"] as const) await fixture(async (root, budget) => {
    let calls = 0;
    const client = new RapidAPIPilotClient("secret", budget, (async () => {
      calls++; return response(scenario === "missing" ? [] : scenario === "negative" ? ["1", "9"] : ["1"], scenario === "quota" ? "0" : "999");
    }) as typeof fetch);
    const result = await runRapidAPIRequest(root, plan, "controls", client, at, new Date(at));
    assert.equal(result.identityControlsPassed, scenario === "quota");
    await assert.rejects(runRapidAPIRequest(root, plan, "batch", client, at, new Date(at)), /no expansion/);
    assert.equal(calls, 1); assert.equal(await json(join(root, "batch.attempt.json"), null), null);
  });
});

test("transport failures and interrupted attempts are durable and cannot silently retry", () => fixture(async (root, budget) => {
  let calls = 0;
  const client = new RapidAPIPilotClient("secret", budget, (async () => { calls++; throw new Error("secret"); }) as typeof fetch);
  await assert.rejects(runRapidAPIRequest(root, plan, "controls", client, at, new Date(at)), /transport failed/);
  await assert.rejects(runRapidAPIRequest(root, plan, "controls", client, at, new Date(at)), /no paid retry/);
  assert.equal(calls, 1);
  const ledger = await json<any>(join(root, "ledger/2026-10.json"), null);
  assert.equal(ledger.entries.at(-1).state, "uncertain");
}));

test("malformed HTTP captures are retained for offline repair without triggering another request", () => fixture(async (root, budget) => {
  let calls = 0;
  const client = new RapidAPIPilotClient("secret", budget, (async () => { calls++; return new Response("upstream failure", { status: 502 }); }) as typeof fetch);
  await assert.rejects(runRapidAPIRequest(root, plan, "controls", client, at, new Date(at)), /HTTP 502/);
  await assert.rejects(runRapidAPIRequest(root, plan, "controls", client, at, new Date(at)), /captured HTTP 502/);
  assert.equal(calls, 1); assert.equal((await json<any>(join(root, "controls.raw.json"), null)).capture.body, "upstream failure");
}));

test("modified evidence, mismatched attempts and unsafe plan names fail closed", () => fixture(async (root, budget) => {
  const client = new RapidAPIPilotClient("secret", budget, (async () => response(["1"])) as typeof fetch);
  await runRapidAPIRequest(root, plan, "controls", client, at, new Date(at));
  const path = join(root, "controls.raw.json"), original = await json<any>(path, null);
  await atomic(path, { ...original, capture: { ...original.capture, body: "{}" } });
  await assert.rejects(replayRapidAPIRequest(root, plan, "controls"), /evidence changed/);
  await atomic(path, original); await atomic(join(root, "controls.attempt.json"), { planDigest: "wrong" });
  await assert.rejects(replayRapidAPIRequest(root, plan, "controls"), /evidence changed/);
  await atomic(join(root, "controls.attempt.json"), { planDigest: pilotIdentity(plan) });
  assert.equal((await replayRapidAPIRequest(root, plan, "controls")).identityControlsPassed, true);
  for (const invalid of ["../outside", "controls/next", "a".repeat(32)])
    assert.equal(rapidAPICapturePlanSchema.safeParse({ ...plan, requests: [{ ...plan.requests[0], name: invalid }] }).success, false);
}));
