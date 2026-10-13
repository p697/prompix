import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const xExcerptSelectionSchema = z.object({
  sourceSHA256: z.string().regex(/^[a-f0-9]{64}$/),
  start: z.number().int().min(0).max(50000),
  end: z.number().int().min(1).max(50000),
  kind: z.enum(["text", "image", "video", "web"]),
  includeMedia: z.boolean(),
}).strict().refine(value => value.end > value.start, "Excerpt must have a positive length");
export const xExcerptReviewSchema = xExcerptSelectionSchema.safeExtend({ reviewedAt: z.iso.datetime() });
export const xExcerptReviewsSchema = z.record(z.string().regex(/^\d{1,19}$/), xExcerptReviewSchema);
export type XExcerptReview = z.infer<typeof xExcerptReviewSchema>;
export type XExcerptReviews = z.infer<typeof xExcerptReviewsSchema>;

/** Bind UTF-16 offsets to the complete original text and its original author. */
export function xExcerptSourceSHA256(post: { id: string; author_id: string; created_at?: string }, text: string) {
  return createHash("sha256").update(JSON.stringify([post.id, post.author_id, post.created_at ?? null, text])).digest("hex");
}

export function selectXExcerpt(post: { id: string; author_id: string; created_at?: string }, text: string, review: XExcerptReview): { body: string } | { reason: string } {
  if (review.sourceSHA256 !== xExcerptSourceSHA256(post, text)) return { reason: "excerpt-review-source-changed" };
  const splitsSurrogate = (index: number) => index > 0 && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index] ?? "");
  if (review.end > text.length || splitsSurrogate(review.start) || splitsSurrogate(review.end)) return { reason: "invalid-excerpt-range" };
  const body = text.slice(review.start, review.end);
  // Operators select the body itself; do not silently adjust a reviewed range.
  if (body !== body.trim()) return { reason: "excerpt-range-includes-whitespace" };
  return { body };
}

export async function readXExcerptReviews(root: string): Promise<XExcerptReviews> {
  try { return xExcerptReviewsSchema.parse(JSON.parse(await readFile(join(root, "x-excerpt-reviews.json"), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
