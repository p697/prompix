import { z } from "zod";
import { promptSchema } from "../packages/schema/catalog.ts";
import type { Candidate } from "./sources.ts";

const https = z.url().refine((url) => new URL(url).protocol === "https:", "HTTPS required");
export const editorialMetadataSchema = promptSchema.pick({
  title: true,
  summary: true,
  example: true,
  tags: true,
  previewLabel: true,
  cover: true,
}).extend({
  demoURL: https.optional(),
  imageURL: https.optional(),
  imageURLs: z.array(https).min(1).max(8).optional(),
  priority: z.number().int().min(0).max(100).optional(),
}).strict();
export const reviewsSchema = z.record(z.string(), z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  reviewedAt: z.iso.datetime(),
  metadata: editorialMetadataSchema,
}));
export type Reviews = z.infer<typeof reviewsSchema>;

/** A review applies only to the exact source text that was inspected. */
export function applyEditorialReviews(items: Candidate[], reviews: Reviews): Candidate[] {
  return items.map((item) => {
    const baseline: Candidate = item.id.startsWith("pc-") ? { ...item, reviewStatus: "draft" } : item;
    const review = reviews[item.id];
    if (!review || review.fingerprint !== item.fingerprint) return baseline;
    const { demoURL, imageURL, imageURLs, priority, ...metadata } = review.metadata;
    const updated: Candidate = {
      ...baseline,
      ...metadata,
      media: demoURL || imageURL || imageURLs ? {
        image: null, video: null, demoURL: null,
        ...item.media,
        ...(demoURL ? { demoURL } : {}),
        ...(imageURL ? { imageURL } : {}),
        ...(imageURLs ? { imageURL: imageURLs[0], imageURLs: [...new Set(imageURLs)] } : {}),
      } : item.media,
      reviewStatus: "candidate",
      editorialRank: priority ?? 0,
    };
    // Website cards need an inspectable result, not just a code-generation brief.
    if (updated.kind === "web" && (!updated.media?.demoURL || !updated.media?.imageURL)) return baseline;
    return updated;
  });
}
