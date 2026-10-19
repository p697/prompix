import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Prompt } from "../packages/schema/catalog.ts";
import type { Candidate } from "./sources.ts";
import { convertXDiscovery, readXIntake } from "./x-intake.ts";
import { nativeXSourceIssue } from "./x-source.ts";
import { writeImmutableBytes } from "./publication.ts";

type RetainedSnapshot = { capturedAt: string; posts: { id: string }[]; [key: string]: unknown };
/** Recover exact original intake, not the mirrored display media, for source checks.
 * Only selected posts are copied into the ordinary maintenance intake, without changing
 * capture time, author text or the private originals. This makes future rechecks possible. */
export async function historyPublicationSources(campaign: string, run: string, items: readonly Prompt[]) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(run)) throw new Error("Invalid history run");
  const wanted = new Map(items.map(p => [p.id, p])), found = new Map<string, Candidate>();
  const snapshots: { raw: RetainedSnapshot; ids: string[] }[] = [];
  const batches = (await readdir(join(campaign, run))).filter(name => /^batch-\d{4}$/.test(name)).sort();
  for (const batch of batches) {
    if (found.size === wanted.size) break;
    const directory = join(campaign, run, batch, "x-discovery");
    const names = await readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    for (const name of names.filter(n => n.endsWith(".json")).sort()) {
      const path = join(directory, name);
      if ((await stat(path)).size > 8_000_000) throw new Error("Historical source snapshot exceeds size bound");
      const raw = JSON.parse(await readFile(path, "utf8")) as RetainedSnapshot;
      const intake = convertXDiscovery([{ name, data: raw }]);
      const selected = intake.candidates.filter(candidate => {
        const expected = wanted.get(candidate.id);
        return expected && !found.has(candidate.id) && !nativeXSourceIssue(candidate) &&
          candidate.source.revision === expected.source.revision && candidate.source.post?.checkedAt === expected.source.post?.checkedAt;
      });
      if (!selected.length) continue;
      for (const candidate of selected) found.set(candidate.id, candidate);
      snapshots.push({ raw, ids: selected.map(p => p.id) });
    }
  }
  if (found.size !== wanted.size) throw new Error(`Missing exact historical source intake for ${wanted.size - found.size} items`);
  return {
    candidates: items.map(p => found.get(p.id)!),
    async persist(shared: string, selected: readonly Prompt[]) {
      const ids = new Set(selected.map(p => p.id));
      for (const snapshot of snapshots) {
        const selectedIDs = new Set(snapshot.ids.filter(id => ids.has(id)));
        if (!selectedIDs.size) continue;
        const raw = { ...snapshot.raw, posts: snapshot.raw.posts.filter(p => selectedIDs.has(`x-post-${p.id}`)) };
        const replay = convertXDiscovery([{ name: "history-publication", data: raw }]);
        for (const id of selectedIDs) if (replay.candidates.find(p => p.id === id)?.source.revision !== found.get(id)!.source.revision)
          throw new Error("Selected historical intake cannot be reproduced");
        const bytes = Buffer.from(JSON.stringify(raw) + "\n"), hash = createHash("sha256").update(bytes).digest("hex");
        const identity = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
        await writeImmutableBytes(join(shared, "x-discovery", `${raw.capturedAt.slice(0, 10)}-check-000-${identity}.json`), bytes);
      }
      const current = new Map((await readXIntake(shared)).candidates.map(p => [p.id, p]));
      for (const item of selected) if (current.get(item.id)?.source.revision !== item.source.revision)
        throw new Error("Shared maintenance has a different source revision; historical publication deferred");
    },
  };
}
