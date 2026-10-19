import { dirname, join } from "node:path";
import type { Prompt } from "../packages/schema/catalog.ts";
import { json } from "./publication.ts";
import { readXAvailability, filterXAvailability } from "./x-availability.ts";
import { exportQueueReady, readHistoryQualityHolds } from "./history-queue.ts";
import { StageQueue } from "./stage-queue.ts";
import { queueDatabase } from "./queue-database.ts";
import { readXIntake } from "./x-intake.ts";
import { verifyReviewedHistory } from "./history-stage-verification.ts";
import { applyQualityHolds } from "./quality-holds.ts";
import { completeHistoryItem, uniqueHistoryItems } from "./history-cohort.ts";
import { hasRequiredTranslations, requiredIngestLocales } from "./ingest-language-policy.ts";
import { readTranslationReviews } from "./translation-review.ts";

/** Reread immutable queue evidence and original seed approvals, with live source checks.
 * The source overlay changes only checkedAt in memory; no original file is rewritten. */
export async function publicationHistoryInventory(campaign: string, shared: string, run: string) {
  const availability = await readXAvailability(shared);
  const queued = await exportQueueReady(new StageQueue(queueDatabase()), campaign, shared, run,
    { publicationFreshOnly: true, availability });
  const originals = await json<Prompt[]>(join(campaign, "seed-ready.json"), []);
  if (!originals.length) return queued;
  const holds = await readHistoryQualityHolds(campaign, shared);
  const removed = new Set((await json<{ removedIDs: string[] }>(join(shared, "moderation.json"), { removedIDs: [] })).removedIDs);
  const seeds = filterXAvailability(applyQualityHolds(originals, holds).prompts.filter(p => !removed.has(p.id)), availability).prompts;
  const mapping = new Map<string, string>();
  const files = await json<string[]>(join(campaign, "seed-source-files.json"), []);
  for (const directory of new Set(files.map(file => dirname(dirname(file))))) {
    for (const item of (await readXIntake(directory)).candidates) if (seeds.some(p => p.id === item.id && p.source.revision === item.source.revision)) mapping.set(item.id, directory);
  }
  if (seeds.some(p => !mapping.has(p.id))) throw new Error("Seed publication approval provenance missing");
  const rejected = await readTranslationReviews(join(shared, "translations", "semantic-rejections.json"));
  for (const directory of new Set(mapping.values())) await verifyReviewedHistory(directory, shared, seeds.filter(p => mapping.get(p.id) === directory), availability);
  if (seeds.some(p => !completeHistoryItem(p, Date.now(), requiredIngestLocales) || !hasRequiredTranslations(p, rejected))) throw new Error("Seed publication quality invalid");
  return [...seeds, ...uniqueHistoryItems(queued, seeds)];
}
