import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { atomic, contentRoot, lockContent, repo } from "./publication.ts";
import { collectSkill, skillRepositoryRevision, skillSources } from "./skills.ts";

await mkdir(contentRoot, { recursive: true });
const location = relative(await realpath(repo), await realpath(contentRoot));
if (!location || (!location.startsWith("..") && !isAbsolute(location))) throw new Error("Community content must stay outside the repository");
const unlock = await lockContent(contentRoot);
try {
  const revisions = new Map<string, string>();
  const results: { id: string; status: string; files?: number; reason?: string }[] = [];
  for (const source of skillSources) {
    try {
      if (!revisions.has(source.repo)) revisions.set(source.repo, await skillRepositoryRevision(source.repo));
      const candidate = await collectSkill(source, revisions.get(source.repo)!);
      await atomic(join(contentRoot, "candidates", `${candidate.id}.json`), [candidate]);
      results.push({ id: candidate.id, status: "collected", files: candidate.skill?.files?.length });
    } catch (error) {
      results.push({ id: `skill-${source.id}`, status: "failed", reason: error instanceof Error ? error.message : "Collection failed" });
    }
  }
  await atomic(join(contentRoot, "skill-intake-status.json"), { updatedAt: new Date().toISOString(), results });
  console.log(JSON.stringify({ collected: results.filter(item => item.status === "collected").length, results, published: false }));
} finally { await unlock(); }
