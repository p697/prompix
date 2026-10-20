import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomic } from "./publication.ts";
import { readXIntake } from "./x-intake.ts";
import { adoptHistoryDiscoveries } from "./history-discovery-evidence.ts";
import { readHistoryAvailability, refreshHistoryItems } from "./history-freshness.ts";

const at = "2026-10-20T08:00:00.000Z", now = Date.parse(at) + 60_000;
const snapshot = (provider: "twitterapi" | "rapidapi" | undefined = "twitterapi") => ({
  provider, capturedAt: at,
  posts: [{ id: "123", author_id: "9", created_at: "2026-08-01T00:00:00Z",
    text: "Image prompt:\nCreate an original watercolor landscape with soft morning light and a quiet mountain lake.",
    attachments: { media_keys: ["photo"] } }],
  media: [{ media_key: "photo", type: "photo", url: "https://pbs.twimg.com/media/synthetic.jpg" }],
  creators: [{ id: "x-9", externalID: "9", platform: "x", username: "fixture", displayName: "Fixture", profileURL: "https://x.com/fixture" }],
});
test("retained acquisition supersedes older mismatched recheck without renewing time or altering originals", async () => {
  const root = await mkdtemp(join(tmpdir(), "history-discovery-"));
  try {
    const batch = join(root, "batch"), shared = join(root, "shared"), input = join(batch, "x-discovery", "2026-10-20-feed-001.json");
    await atomic(input, snapshot());
    const [item] = (await readXIntake(batch)).candidates;
    const old = { [item.id]: { checkedAt: "2026-10-17T00:00:00Z", status: "ready", revision: "b".repeat(64) } };
    await atomic(join(shared, "x-availability", "state.json"), old);
    assert.throws(() => refreshHistoryItems([item], old as any, now), /stale|match/);
    const original = await readFile(input);
    const result = await adoptHistoryDiscoveries(batch, root, shared, now);
    assert.equal(result.reused, 1);
    const state = await readHistoryAvailability(root, shared);
    assert.equal(state[item.id].checkedAt, at);
    assert.equal(state[item.id].revision, item.source.revision);
    assert.equal(state[item.id].checkedBy, "twitterapi");
    assert.equal(refreshHistoryItems([item], state, now)[0].source.post!.checkedAt, at);
    assert.deepEqual(await readFile(input), original);
    assert.deepEqual(JSON.parse(await readFile(join(shared, "x-availability", "state.json"), "utf8")), old);
    assert.equal((await adoptHistoryDiscoveries(batch, root, shared, now + 60_000)).reused, 0);
    await atomic(join(shared, "x-availability", "state.json"), { [item.id]: { status: "withheld", checkedAt: "2026-10-20T08:02:00.000Z", checkedBy: "rapidapi" } });
    assert.equal((await adoptHistoryDiscoveries(batch, root, shared, now + 120_000)).reused, 0);
    assert.deepEqual(refreshHistoryItems([item], await readHistoryAvailability(root, shared), now + 120_000), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("expired, future, removed and unofficial acquisitions cannot replace authoritative evidence", async () => {
  for (const scenario of ["expired", "future", "removed", "official"] as const) {
    const root = await mkdtemp(join(tmpdir(), "history-discovery-invalid-"));
    try {
      const batch = join(root, "batch"), shared = join(root, "shared");
      const data = snapshot(); if (scenario === "official") delete (data as any).provider;
      await atomic(join(batch, "x-discovery", "2026-10-20-feed-001.json"), data);
      if (scenario === "removed") await atomic(join(shared, "x-availability", "state.json"), { "x-post-123": { checkedAt: "2026-10-19T00:00:00Z", status: "withheld", removed: true } });
      const clock = scenario === "expired" ? now + 13 * 3600_000 : scenario === "future" ? Date.parse(at) - 120_000 : now;
      assert.equal((await adoptHistoryDiscoveries(batch, root, shared, clock)).reused, 0, scenario);
      await assert.rejects(readFile(join(root, "source-discovery-evidence", "x-availability", "state.json")), { code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
