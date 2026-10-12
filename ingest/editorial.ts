import { isPublisherSkill, publisherSkillIssue } from "./publisher-skills.ts";
import { z } from "zod";
import { promptSchema } from "../packages/schema/catalog.ts";
import type { Candidate } from "./sources.ts";
import { isNativeXDraft, nativeXSourceIssue, nativeXSourceDigest } from "./x-source.ts";
import { isClawHubItem } from "./clawhub.ts";

const https = z.url().refine((url) => new URL(url).protocol === "https:", "HTTPS required");
// Picking from a refined object is rejected by Zod. Reuse the exact field
// schemas without importing catalog-level Skill consistency checks here.
export const editorialMetadataSchema = z.object({
  title: promptSchema.shape.title,
  summary: promptSchema.shape.summary,
  example: promptSchema.shape.example,
  tags: promptSchema.shape.tags,
  previewLabel: promptSchema.shape.previewLabel,
  cover: promptSchema.shape.cover,
  demoURL: https.optional(),
  imageURL: https.optional(),
  imageURLs: z.array(https).min(1).max(8).optional(),
  priority: z.number().int().min(0).max(100).optional(),
}).strict();
export const reviewsSchema = z.record(z.string(), z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRevision: z.string().min(1).max(200).optional(),
  reviewedAt: z.iso.datetime(),
  metadata: editorialMetadataSchema,
}));
export type Reviews = z.infer<typeof reviewsSchema>;

/** A review applies only to the exact source text that was inspected. */
export function applyEditorialReviews(items: Candidate[], reviews: Reviews): Candidate[] {
  return items.map((item) => {
    // Collection establishes provenance and available media, not editorial
    // quality. Every community item needs a review of its current source text.
    const baseline: Candidate = { ...item, reviewStatus: "draft" };
    const review = reviews[item.id];
    if (!review || review.fingerprint !== item.fingerprint || ((isPublisherSkill(item) || isClawHubItem(item) || isNativeXDraft(item)) && review.sourceRevision !== item.source.revision)) return baseline;
    const { demoURL, imageURL, imageURLs, priority, ...metadata } = review.metadata;
    const updated: Candidate = {
      ...baseline,
      ...metadata,
      media: !isNativeXDraft(item) && (demoURL || imageURL || imageURLs) ? {
        image: null, video: null, demoURL: null,
        ...item.media,
        ...(demoURL ? { demoURL } : {}),
        ...(imageURL ? { imageURL } : {}),
        ...(imageURLs ? { imageURL: imageURLs[0], imageURLs: [...new Set(imageURLs)] } : {}),
      } : item.media,
      reviewStatus: "candidate",
      editorialRank: priority ?? 0,
    };
    // Preserve source attachments; editorial metadata cannot substitute an X post.
    if ((isPublisherSkill(item) && publisherSkillIssue(item)) || nativeXSourceIssue(item) || (isNativeXDraft(item) && nativeXSourceDigest(item) !== item.source.revision)) return { ...updated, reviewStatus: "draft" };
    // Website cards need an inspectable result, not just a code-generation brief.
    if (updated.kind === "web" && (!updated.media?.demoURL || !updated.media?.imageURL)) return baseline;
    return updated;
  });
}
