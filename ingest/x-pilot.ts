import { createHash } from "node:crypto";
import type { Candidate } from "./sources.ts";
import { fullXText } from "./x-intake.ts";
import type { TwitterAPIResult } from "./twitterapi.ts";
import { nativeXPostIDs } from "./x-source.ts";

const body = (text: string) => text.replace(/\r\n/g, "\n").trim();
const asset = (url: string) => {
  try { const value = new URL(url); value.searchParams.delete("name"); return value.toString(); }
  catch { return url; }
};
/** Sample distinct visual, long-text and reply cases; never choose only easy standalone text. */
export function pilotSample(candidates: readonly Candidate[], maximum = 45) {
  const selected = new Map<string, Candidate>(), ids = new Set<string>();
  const groups = [candidates.filter(c => c.kind === "video"), candidates.filter(c => c.kind === "web"),
    candidates.filter(c => c.source.context?.length), candidates.filter(c => (c.source.post?.text.length ?? 0) > 280),
    candidates.filter(c => (c.media?.imageURLs?.length ?? 0) > 1), candidates.filter(c => c.kind === "image"),
    candidates.filter(c => c.kind === "text")];
  for (let index = 0; index < maximum; index++) for (const group of groups) {
    const item = group[index];
    if (!item || selected.has(item.id)) continue;
    const dependencies = nativeXPostIDs(item);
    if (!dependencies.length || new Set([...ids, ...dependencies]).size > maximum) continue;
    dependencies.forEach(id => ids.add(id)); selected.set(item.id, item);
  }
  return { candidates: [...selected.values()], ids: [...ids] };
}
/** Compare actual source bodies and media, not generated metadata. Different is unresolved, never automatically approved. */
export function comparePilotSources(candidates: readonly Candidate[], result: TwitterAPIResult) {
  return candidates.map(candidate => {
    const issues: string[] = [];
    for (const original of [...(candidate.source.context ?? []), ...(candidate.source.post ? [candidate.source.post] : [])]) {
      const post = result.posts.find(p => p.id === original.id);
      if (!post) { issues.push(`missing:${original.id}`); continue; }
      const complete = fullXText(post);
      if (complete.truncated) issues.push(`truncated:${original.id}`);
      if (body(complete.text) !== body(original.text)) issues.push(`text:${original.id}`);
      if (post.author_id !== original.authorID) issues.push(`author:${original.id}`);
      if (Date.parse(post.created_at ?? "") !== Date.parse(original.createdAt)) issues.push(`time:${original.id}`);
      if ((post.referenced_tweets?.find(r => r.type === "replied_to")?.id) !== original.parentID) issues.push(`parent:${original.id}`);
    }
    const owner = result.posts.find(p => p.id === (candidate.source.mediaPostID ?? candidate.source.post?.id));
    const media = result.media.filter(m => owner?.attachments?.media_keys?.includes(m.media_key));
    const images = new Set(media.flatMap(m => m.type === "photo" && m.url ? [asset(m.url)] : m.preview_image_url ? [asset(m.preview_image_url)] : []));
    const expectedImages = candidate.media?.imageURLs ?? (candidate.media?.imageURL ? [candidate.media.imageURL] : []);
    if (expectedImages.some(url => !images.has(asset(url)))) issues.push("media:image");
    const videos = new Set(media.flatMap(m => m.variants?.map(v => asset(v.url)) ?? []));
    if (candidate.media?.videoURL && !videos.has(asset(candidate.media.videoURL))) issues.push("media:video");
    return { id: candidate.id, kind: candidate.kind, longText: (candidate.source.post?.text.length ?? 0) > 280,
      thread: !!candidate.source.context, gallery: (candidate.media?.imageURLs?.length ?? 0) > 1, issues, matched: !issues.length };
  });
}
export const pilotIdentity = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
