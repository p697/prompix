import { join } from "node:path";
import type { Prompt } from "../packages/schema/catalog.ts";
import type { StageQueue } from "./stage-queue.ts";
import { json } from "./publication.ts";
import { checkedHistorySeeds, unresolvedHistorySeeds, readHistoryAvailability } from "./history-freshness.ts";
import { exportQueueReady, readHistoryQualityHolds } from "./history-queue.ts";
import { uniqueHistoryItems, completeHistoryItem } from "./history-cohort.ts";
import { applyQualityHolds } from "./quality-holds.ts";
import { readTranslationReviews } from "./translation-review.ts";
import { hasRequiredTranslations, requiredIngestLocales } from "./ingest-language-policy.ts";

/** Shared current eligibility calculation for the controller and a new bounded stage. */
export async function campaignInventory(queue: StageQueue, root: string, sharedRoot: string, run: string,
  baseline: Prompt[], originalSeed: Prompt[]) {
  const holds = await readHistoryQualityHolds(root, sharedRoot);
  const moderation = await json<{ removedIDs: string[] }>(join(sharedRoot, "moderation.json"), { removedIDs: [] });
  const reviews = await readTranslationReviews(join(sharedRoot, "translations", "semantic-rejections.json"));
  const seedState = await readHistoryAvailability(root, sharedRoot);
  const seed = applyQualityHolds(checkedHistorySeeds(originalSeed, seedState), holds).prompts.filter(p =>
    !moderation.removedIDs.includes(p.id) && completeHistoryItem(p, Date.now(), requiredIngestLocales) && hasRequiredTranslations(p, reviews));
  const unresolvedSeeds = unresolvedHistorySeeds(originalSeed, seed, seedState, new Set([...Object.keys(holds.holds), ...moderation.removedIDs]));
  const ready = uniqueHistoryItems(await exportQueueReady(queue, root, sharedRoot, run, { availability: seedState, requireFreshChecks: true }), [...baseline, ...seed]);
  return { seed, ready, unresolvedSeeds };
}
