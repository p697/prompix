import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertXDiscovery } from "./x-intake.ts";
import { maintenanceCensus, saveMaintenanceCensus } from "./x-maintenance-reserve.ts";
import { maintenanceRunway } from "./x-spend.ts";
import { json } from "./publication.ts";
const now = new Date("2026-10-17T01:00:00Z");
function candidate(id: string) {
  return convertXDiscovery([{ name: "fixture", data: { capturedAt: now.toISOString(), posts: [{ id, author_id: "42", created_at: now.toISOString(),
    text: "Image prompt:\nCreate an original watercolor garden with warm morning light, delicate green leaves and a clear focal point.",
    attachments: { media_keys: ["photo1"] } }], creators: [{ id: "x-id-42", externalID: "42", platform: "x", username: "fixture", displayName: "Fixture", profileURL: "https://x.com/fixture" }],
    media: [{ media_key: "photo1", type: "photo", url: "https://pbs.twimg.com/media/fixture.jpg" }] } }]).candidates[0];
}
test("census prices published roots in threads officially and deduplicates shared dependencies", () => {
  const root = candidate("101"), reply = candidate("102"), standalone = candidate("103"), inactive = candidate("104");
  reply.source.context = [root.source.post!]; reply.source.post!.parentID = "101";
  const ids = new Set([root.id, reply.id, standalone.id, inactive.id, "non-native-fixture"]);
  const result = maintenanceCensus([root, reply, standalone, inactive], ids, new Set([inactive.id]), now, true);
  assert.equal(result.plan.complete, true); assert.equal(result.plan.officialPosts, 2); assert.equal(result.plan.standalone, 1);
  assert.equal(result.runway.daily, 20300); assert.equal(result.runway.monthly, 304500);
  const unpublishedReply = maintenanceCensus([root, reply, standalone], new Set([root.id, standalone.id]), new Set(), now, true);
  assert.equal(unpublishedReply.plan.officialPosts, 1); assert.equal(unpublishedReply.plan.standalone, 1);
  const official = maintenanceCensus([root, reply, standalone], ids, new Set([inactive.id]), now, false);
  assert.equal(official.plan.officialPosts, 3); assert.equal(official.plan.standalone, 0);
  assert.equal(result.plan.sourceSetSHA256, maintenanceCensus([inactive, standalone, reply, root], new Set([...ids].reverse()), new Set([inactive.id]), now, true).plan.sourceSetSHA256);
});
test("missing or malformed protected sources mark census incomplete instead of silently undercounting", () => {
  const item = candidate("101"), missingPost = candidate("102"); delete missingPost.source.post;
  const result = maintenanceCensus([item, missingPost], new Set([item.id, missingPost.id, "x-post-103"]), new Set(), now, true);
  assert.equal(result.plan.complete, false); assert.deepEqual(result.missing, ["x-post-102", "x-post-103"]);
});
test("runway uses inclusive UTC month days including leap years and year rollover", () => {
  const { plan } = maintenanceCensus([candidate("101")], new Set(["x-post-101"]), new Set(), now, true);
  for (const [date, days] of [["2028-02-01T00:00:00Z", 29], ["2026-02-01T00:00:00Z", 28], ["2026-12-31T23:59:59Z", 1], ["2027-01-01T00:00:00Z", 31]] as const) {
    const result = maintenanceRunway(plan, new Date(date)); assert.equal(result.days, days); assert.equal(result.monthly, days * 300);
  }
});
for (const provider of ["twitterapi", "rapidapi"]) test(`saved ${provider} census requires publication history and preserves standalone/thread routing`, async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-maintenance-census-"));
  try {
    const item = candidate("101"), env = { PROMPIX_X_SPEND_DIR: root, PROMPIX_X_MONTHLY_USD: "20", PROMPIX_X_MAINTENANCE_RESERVE: "1", PROMPIX_X_RECHECK_PROVIDER: provider };
    assert.equal((await saveMaintenanceCensus([item], new Set([item.id]), new Set(), now, false, env))?.complete, false);
    const result = await saveMaintenanceCensus([item], new Set([item.id]), new Set(), now, true, env);
    assert.equal(result?.complete, true); assert.equal(result?.dailyHeadroomUSD, 0.0003);
    const serialized = JSON.stringify(await json(join(root, "maintenance-reserve.json"), null));
    assert.equal(serialized.includes(item.id), false); assert.equal(serialized.includes("watercolor"), false);
    const thread = candidate("102"), reply = candidate("103");
    reply.source.context = [thread.source.post!]; reply.source.post!.parentID = "102";
    const routed = await saveMaintenanceCensus([item, thread, reply], new Set([item.id, thread.id, reply.id]), new Set(), now, true, env);
    assert.equal(routed?.standalone, 1); assert.equal(routed?.officialPosts, 2);
    // Cash reserve remains conservative until separately validated activation.
    assert.equal(routed?.dailyHeadroomUSD, 0.0203);
    assert.equal(await saveMaintenanceCensus([], new Set(), new Set(), now, false, {}), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
