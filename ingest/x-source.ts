import type { Prompt } from "../packages/schema/catalog.ts";
import { createHash } from "node:crypto";

export const nativeXSourceName = "X";
export const nativeXPublicationBlocker = "Native X drafts await complete source attribution";
export const nativeXSourceLifetime = 24 * 3600_000;
export function isNativeXDraft(item: Pick<Prompt, "source">): boolean { return item.source.name === nativeXSourceName; }

/** Freshness is deliberately excluded: a successful recheck does not rewrite editorial decisions. */
export function nativeXSourceDigest(item: Pick<Prompt, "id" | "kind" | "prompt" | "model" | "source" | "creator" | "media">): string {
  const post = item.source.post;
  return createHash("sha256").update(JSON.stringify(["prompix-x-source-2", item.id, item.kind, item.model, item.prompt,
    item.source.url, item.creator?.externalID ?? null, post?.text ?? null, post?.createdAt ?? null,
    item.media?.imageURL ?? null, item.media?.imageURLs ?? [], item.media?.videoURL ?? null, item.media?.demoURL ?? null])).digest("hex");
}

/** API display terms are recorded honestly, never presented as a Creative Commons grant. */
export function nativeXSourceIssue(item: Pick<Prompt, "id" | "source" | "creator" | "publishedAt">, now = Date.now()): string | undefined {
  if (!isNativeXDraft(item)) return;
  const post = item.source.post, creator = item.creator;
  if (!post || item.source.license !== "X-API-Terms" || item.id !== `x-post-${post.id}` ||
      item.source.url !== `https://x.com/i/web/status/${post.id}` || creator?.platform !== "x" ||
      creator.externalID !== post.authorID || !creator.username || !creator.displayName ||
      item.publishedAt !== post.createdAt || !post.text.trim() || !/^[a-f0-9]{64}$/.test(item.source.revision ?? ""))
    return nativeXPublicationBlocker;
  const checked = Date.parse(post.checkedAt), created = Date.parse(post.createdAt);
  if (!Number.isFinite(checked) || !Number.isFinite(created) || created > checked + 60_000 || checked > now + 60_000 || now - checked >= nativeXSourceLifetime)
    return "X source must be rechecked before publication";
}
