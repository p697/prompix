import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomic } from "./publication.ts";
import { convertXDiscovery, readXIntake } from "./x-intake.ts";
import { historyPublicationSources } from "./history-publication-sources.ts";
import { adoptFreshXDiscoveries, filterXAvailability } from "./x-availability.ts";

test("historical mirrored media uses exact raw intake and persists only selected maintenance sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-history-sources-")), shared = join(root, "shared");
  try {
    const now = new Date().toISOString();
    const raw = { provider: "twitterapi", capturedAt: now,
      posts: ["123", "124"].map(id => ({ id, author_id: "456", created_at: now,
        text: `Image prompt: Create an intricate paper village ${id} with warm window lights, layered rooftops, delicate trees and a beautiful cinematic composition.`, attachments: { media_keys: ["m"] } })),
      media: [{ media_key: "m", type: "photo", url: "https://pbs.twimg.com/media/test.jpg" }],
      creators: [{ id: "x-456", externalID: "456", platform: "x", username: "fixture", displayName: "Fixture", profileURL: "https://x.com/fixture" }],
    };
    const path = join(root, "run", "batch-0001", "x-discovery", `${now.slice(0, 10)}.json`);
    await atomic(path, raw); const original = await readFile(path);
    const intake = convertXDiscovery([{ name: "fixture", data: raw }]); assert.equal(intake.candidates.length, 2);
    const mirrored = intake.candidates.map(p => ({ ...p, media: { ...p.media!, imageURL: `https://api.prompix.dev/media/${"a".repeat(64)}.jpg` } }));
    assert.equal((await adoptFreshXDiscoveries(shared, mirrored, {})).reused, 0, "Display mirror is not the source revision");
    const loaded = await historyPublicationSources(root, "run", mirrored);
    const adopted = await adoptFreshXDiscoveries(shared, loaded.candidates, {});
    assert.equal(adopted.reused, 2); assert.equal(filterXAvailability(mirrored, adopted.state).prompts.length, 2);
    await loaded.persist(shared, [mirrored[0]]); await loaded.persist(shared, [mirrored[0]]);
    assert.equal((await readdir(join(shared, "x-discovery"))).length, 1);
    const retained = (await readXIntake(shared)).candidates;
    assert.deepEqual(retained.map(p => p.id), [mirrored[0].id]);
    assert.equal(retained[0].source.post!.checkedAt, now); assert.equal(retained[0].source.post!.text, raw.posts[0].text);
    assert.deepEqual(await readFile(path), original);
    await assert.rejects(historyPublicationSources(root, "run", [{ ...mirrored[0], source: { ...mirrored[0].source, revision: "f".repeat(64) } }]), /Missing exact/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
