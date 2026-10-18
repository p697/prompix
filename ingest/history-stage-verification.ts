import { join } from "node:path";
import { catalogSchema, type Prompt } from "../packages/schema/catalog.ts";
import { json } from "./publication.ts";
import { readXIntake } from "./x-intake.ts";
import { applyEditorialReviews, reviewsSchema } from "./editorial.ts";
import { selectLibrary } from "./library.ts";
import { publicationText } from "./templates.ts";
import { applyVisualPresentation, runVisualReview, visualCacheSchema } from "./visual-review.ts";
import { applyQualityHolds, readQualityHolds } from "./quality-holds.ts";
import { translationText } from "./translation.ts";
import { isDeepStrictEqual } from "node:util";
import { nativeXSourceIssue } from "./x-source.ts";

/** Recheck exact source/media approvals at the stage boundary; no network or review bypass. */
export async function verifyReviewedHistory(directory: string, sharedRoot: string, supplied?: readonly Prompt[]): Promise<Prompt[]> {
  const items = supplied ?? catalogSchema.parse(await json(join(directory, "source-catalog.json"), null)).prompts;
  const intake = await readXIntake(directory);
  const reviews = reviewsSchema.parse(await json(join(directory, "editorial.json"), {}));
  const removed = new Set((await json<{ removedIDs: string[] }>(join(sharedRoot, "moderation.json"), { removedIDs: [] })).removedIDs);
  const eligible = new Map(selectLibrary(applyEditorialReviews(intake.candidates, reviews), removed).map(item => [item.id, item]));
  const holds = await readQualityHolds(sharedRoot);
  if (applyQualityHolds([...items], holds).prompts.length !== items.length) throw new Error("Reviewed history has active hold");
  for (const item of items) {
    const source = eligible.get(item.id);
    if (!source || nativeXSourceIssue(item) || source.source.revision !== item.source.revision || !isDeepStrictEqual(translationText({ ...source, prompt: publicationText(source, reviews) }), translationText(item))) throw new Error("History editorial/source approval changed");
    for (const key of ["kind", "creator", "source", "model", "toolURL", "tags", "publishedAt"] as const)
      if (!isDeepStrictEqual(source[key], item[key])) throw new Error(`History approved ${key} changed`);
  }
  const cache = visualCacheSchema.parse(await json(join(directory, "visual-cache.json"), null));
  const forbidden = async (): Promise<never> => { throw new Error("Review evidence missing; stage cannot silently approve or recharge"); };
  const visual = await runVisualReview({ prompts: [...items], previous: [], cache, day: new Date().toISOString().slice(0, 10), maxRequests: 0,
    prepareMedia: forbidden, persistCache: forbidden, persistLedger: forbidden });
  if (visual.prompts.length !== items.length) throw new Error("History full-media approval missing");
  const labeled = new Map(applyVisualPresentation([...items], cache).map(item => [item.id, item.presentation]));
  for (const item of items) if (!["general", "suggestive"].includes(item.presentation ?? "") || labeled.get(item.id) !== item.presentation) throw new Error("History presentation approval changed");
  return [...items];
}
