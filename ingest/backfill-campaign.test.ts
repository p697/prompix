import { test } from "node:test";
import assert from "node:assert/strict";
import { campaignTarget, assertSubscriptionSnapshot } from "./backfill-campaign.ts";
const now = Date.parse("2026-10-18T15:00:00Z");
test("campaign cannot expand on a count alone or duplicate, stale or overbudget audit", () => {
  assert.equal(campaignTarget(null, "2026-10-18T00:00:00Z", now), 2000);
  const good = { version: 1, target: 10000, reviewedAt: "2026-10-18T14:00:00Z", qualifiedTotal: 2000,
    reviewedIDs: Array.from({ length: 50 }, (_, i) => `item-${i}`), unresolvedBlockingIssues: 0,
    sharedAccountedUSD: 20, projectedTotalUSD: 60, ordinaryQuotaVerified: true, evidencePath: "/retained/audit.json" };
  assert.equal(campaignTarget(good, "2026-10-18T00:00:00Z", now), 10000);
  for (const bad of [{ ...good, reviewedIDs: Array(50).fill("same") }, { ...good, projectedTotalUSD: 101 }, { ...good, qualifiedTotal: 1999 }, { ...good, unresolvedBlockingIssues: 1 }, { ...good, ordinaryQuotaVerified: false }, { ...good, reviewedAt: "2026-10-17T00:00:00Z" }])
    assert.throws(() => campaignTarget(bad, "2026-10-18T00:00:00Z", now));
});
test("subscription guard requires recent ordinary allowance and conservative headroom", () => {
  const good = { observedAt: "2026-10-18T14:30:00Z", weeklyUsedPercent: 49, ordinaryUsageAllowed: true, source: "codex-account-rate-limits" };
  assert.doesNotThrow(() => assertSubscriptionSnapshot(good, now));
  for (const bad of [null, { ...good, ordinaryUsageAllowed: false }, { ...good, weeklyUsedPercent: 90 }, { ...good, observedAt: "2026-10-18T13:00:00Z" }, { ...good, observedAt: "2026-10-18T16:00:00Z" }]) assert.throws(() => assertSubscriptionSnapshot(bad, now));
});
