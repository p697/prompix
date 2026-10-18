import type { Prompt } from "../packages/schema/catalog.ts";
import { createHash } from "node:crypto";

export const nativeXSourceName = "X";
export const nativeXPublicationBlocker = "Native X drafts await complete source attribution";
export const nativeXSourceLifetime = 24 * 3600_000;
export function isNativeXDraft(item: Pick<Prompt, "source">): boolean { return item.source.name === nativeXSourceName; }

/** Freshness is deliberately excluded: a successful recheck does not rewrite editorial decisions. */
export function nativeXSourceDigest(item: Pick<Prompt, "id" | "kind" | "prompt" | "model" | "source" | "creator" | "media">): string {
  const post = item.source.post;
  const identity: unknown[] = ["prompix-x-source-2", item.id, item.kind, item.model, item.prompt,
    item.source.url, item.creator?.externalID ?? null, post?.text ?? null, post?.createdAt ?? null,
    item.media?.imageURL ?? null, item.media?.imageURLs ?? [], item.media?.videoURL ?? null, item.media?.demoURL ?? null];
  if (item.source.context) identity.push("thread-1", post?.parentID ?? null, item.source.mediaPostID,
    item.source.context.map(({ checkedAt: _checkedAt, ...source }) => source));
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

/** API display terms are recorded honestly, never presented as a Creative Commons grant. */
export function nativeXSourceIssue(item: Pick<Prompt, "id" | "source" | "creator" | "publishedAt">, now = Date.now()): string | undefined {
  if (!isNativeXDraft(item)) return;
  const post = item.source.post, creator = item.creator;
  if (!post || (item.source.acquiredVia ? item.source.license !== "Source-author-rights" : item.source.license !== "X-API-Terms") || item.id !== `x-post-${post.id}` ||
      item.source.url !== `https://x.com/i/web/status/${post.id}` || creator?.platform !== "x" ||
      creator.externalID !== post.authorID || !creator.username || !creator.displayName ||
      item.publishedAt !== post.createdAt || !post.text.trim() || !/^[a-f0-9]{64}$/.test(item.source.revision ?? ""))
    return nativeXPublicationBlocker;
  const context = item.source.context;
  if (context) {
    const chain = [...context, post];
    if (!context.length || context.length > 8 || !item.source.mediaPostID || !chain.some(value => value.id === item.source.mediaPostID) ||
        new Set(chain.map(value => value.id)).size !== chain.length || chain.some((value, index) =>
          value.authorID !== post.authorID || !value.text.trim() || (index === 0 ? value.parentID !== undefined :
            value.parentID !== chain[index - 1].id || Date.parse(value.createdAt) < Date.parse(chain[index - 1].createdAt)))) return nativeXPublicationBlocker;
  } else if (post.parentID || item.source.mediaPostID) return nativeXPublicationBlocker;
  for (const source of [...(context ?? []), post]) {
  const checked = Date.parse(source.checkedAt), created = Date.parse(source.createdAt);
  if (!Number.isFinite(checked) || !Number.isFinite(created) || created > checked + 60_000 || checked > now + 60_000 || now - checked >= nativeXSourceLifetime)
    return "X source must be rechecked before publication";
  }
}

export function nativeXPostIDs(item: Pick<Prompt, "source">): string[] {
  return [...(item.source.context ?? []), ...(item.source.post ? [item.source.post] : [])].map(post => post.id);
}
