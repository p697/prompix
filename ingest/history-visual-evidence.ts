import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Prompt } from "../packages/schema/catalog.ts";
import { atomic, json } from "./publication.ts";
import { validateAttachments, visualCacheSchema, visualReviewIdentity, visualReviewVersion, type VisualCache } from "./visual-review.ts";

/** Copy exact, complete media evidence under the shared publisher lock. Presentation
 * alone is never an approval. Prefer newer decisions; ambiguous same-time conflicts fail closed. */
export function mergeHistoryVisualEvidence(current: VisualCache, incoming: VisualCache, items: readonly Prompt[]): VisualCache {
  const result = visualCacheSchema.parse(current), source = visualCacheSchema.parse(incoming);
  for (const item of items) {
    const identity = visualReviewIdentity(item), decision = source.decisions[identity];
    if (!decision || decision.id !== item.id || !decision.presentation) continue;
    try { validateAttachments(item, decision.attachments, decision.coverage); }
    catch { continue; }
    const existing = result.decisions[identity];
    if (existing && Date.parse(existing.reviewedAt) > Date.parse(decision.reviewedAt)) continue;
    if (existing && existing.reviewedAt === decision.reviewedAt && JSON.stringify(existing) !== JSON.stringify(decision))
      throw new Error(`Conflicting visual evidence for ${item.id}`);
    result.decisions[identity] = decision;
  }
  return result;
}

/** Batch caches remain immutable. Copy selected identities so daily runs don't depend
 * on campaign folders after publication. No provider, media download or quota changes. */
export async function adoptHistoryVisualEvidence(campaign: string, shared: string, run: string, items: readonly Prompt[]) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(run)) throw new Error("Invalid history run");
  const path = join(shared, "visual-review", "decisions.json");
  const original = visualCacheSchema.parse(await json(path, { version: visualReviewVersion, decisions: {} }));
  let merged = original;
  const files = await json<string[]>(join(campaign, "seed-source-files.json"), []);
  const directories = new Set(files.map(file => dirname(dirname(file))));
  let entries: Dirent[];
  try { entries = await readdir(join(campaign, run), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; entries = []; }
  for (const entry of entries) if (entry.isDirectory()) directories.add(join(campaign, run, entry.name));
  if (directories.size > 10000) throw new Error("Too many history evidence directories");
  for (const directory of [...directories].sort()) {
    const cache = await json<unknown | null>(join(directory, "visual-cache.json"), null);
    if (cache !== null) merged = mergeHistoryVisualEvidence(merged, visualCacheSchema.parse(cache), items);
  }
  if (JSON.stringify(merged) !== JSON.stringify(original)) await atomic(path, merged);
  return merged;
}
