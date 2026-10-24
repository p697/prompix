import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSubscriptionSnapshot } from "./backfill-campaign.ts";
import { campaignQuotaReader, quotaObservation } from "./codex-quota.ts";
const now = Date.parse("2026-10-20T10:00:00Z");
const bucket = { primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: now / 1000 + 86400 }, secondary: null,
  spendControlReached: false, rateLimitReachedType: null, individualLimit: null, planType: "pro" };
const raw = { accountId: "fixture-account", rateLimits: bucket, rateLimitsByLimitId: { codex: bucket } };

test("quota reader validates account, actual weekly window, and all ordinary-use restrictions", () => {
  const value = quotaObservation(raw, "fixture-account", now);
  assert.equal(value.weeklyUsedPercent, 5); assert.equal(value.ordinaryUsageAllowed, true);
  assert.throws(() => quotaObservation(raw, "different-account", now));
  for (const patch of [{ primary: null }, { spendControlReached: undefined }, { individualLimit: {} }, { primary: { ...bucket.primary, resetsAt: now / 1000 - 1 } }])
    assert.throws(() => quotaObservation({ ...raw, rateLimitsByLimitId: { codex: { ...bucket, ...patch } } }, "fixture-account", now));
  for (const patch of [{ spendControlReached: true }, { rateLimitReachedType: "weekly" }, { secondary: { ...bucket.primary, windowDurationMins: 300, usedPercent: 100 } }])
    assert.equal(quotaObservation({ ...raw, rateLimitsByLimitId: { codex: { ...bucket, ...patch } } }, "fixture-account", now).ordinaryUsageAllowed, false);
  assert.throws(() => quotaObservation({ ...raw, rateLimitsByLimitId: {} }, "fixture-account", now), "must not fall back from a missing codex bucket");
});

test("concurrent workers share a measurement; failed refresh never renews its timestamp", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-quota-"));
  try {
    let clock = now, calls = 0, fail = false;
    const refresh = campaignQuotaReader(root, "fixture-account", async () => { calls++; if (fail) throw new Error("offline"); return raw; }, () => clock);
    await Promise.all([refresh(), refresh(), refresh()]);
    assert.equal(calls, 1);
    const original = await readFile(join(root, "subscription-quota.json"), "utf8");
    assert.doesNotThrow(() => assertSubscriptionSnapshot(JSON.parse(original), clock));
    assert.throws(() => assertSubscriptionSnapshot({ ...JSON.parse(original), weeklyUsedPercent: 95 }, clock));
    await refresh(); assert.equal(calls, 1);
    fail = true; clock += 21 * 60_000; await refresh();
    assert.equal(calls, 2); assert.equal(await readFile(join(root, "subscription-quota.json"), "utf8"), original);
    assert.equal((await readFile(join(root, "subscription-quota-history.jsonl"), "utf8")).trim().split("\n").length, 1);
    await refresh(); assert.equal(calls, 2);
    clock += 61_000; fail = false; await refresh(); assert.equal(calls, 3);
    const wrongAccount = campaignQuotaReader(root, "wrong-account", async () => raw, () => clock);
    await assert.rejects(wrongAccount(), /Quota account mismatch/);
    assert.equal(JSON.parse(await readFile(join(root, "subscription-quota.json"), "utf8")).observedAt, new Date(clock).toISOString());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("near-limit quota observations refresh after one minute instead of twenty", async () => {
  const root=await mkdtemp(join(tmpdir(),"quota-near-limit-"));
  try {let clock=now,calls=0;const refresh=campaignQuotaReader(root,"fixture-account",async()=>{calls++;return {...raw,rateLimitsByLimitId:{codex:{...bucket,primary:{...bucket.primary,usedPercent:86}}}};},()=>clock);
    await refresh();clock+=59000;await refresh();assert.equal(calls,1);clock+=1001;await refresh();assert.equal(calls,2);
  }finally{await rm(root,{recursive:true,force:true});}
});
