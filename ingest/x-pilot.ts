import { createHash } from "node:crypto";
import type { Candidate } from "./sources.ts";
import { fullXText, convertXDiscovery } from "./x-intake.ts";
import { convertXThread } from "./x-thread-intake.ts";
import type { XExcerptReviews } from "./x-excerpts.ts";
import { canonicalTwitterVideoURL, type TwitterAPIResult } from "./twitterapi.ts";
import { nativeXPostIDs } from "./x-source.ts";

const body = (text: string) => text.replace(/\r\n/g, "\n").trim();
const asset = (url: string) => {
  try { const value = new URL(canonicalTwitterVideoURL(url)); value.searchParams.delete("name"); return value.toString(); }
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
/** Exercise the real extractor in memory; these provisional drafts are never published. */
export function comparePilotExtraction(candidates: readonly Candidate[], result: TwitterAPIResult, capturedAt: string, excerpts: XExcerptReviews = {}) {
  const snapshot = { capturedAt, ...result };
  const snapshots = [];
  for (let offset = 0; offset < result.posts.length; offset += 100) {
    const posts = result.posts.slice(offset, offset + 100);
    const authors = new Set(posts.map(post => post.author_id));
    const mediaKeys = new Set(posts.flatMap(post => post.attachments?.media_keys ?? []));
    snapshots.push({ name: `pilot-${offset}`, data: { capturedAt, posts,
      creators: result.creators.filter(creator => authors.has(creator.externalID ?? "")),
      media: result.media.filter(media => mediaKeys.has(media.media_key)) } });
  }
  const singles = convertXDiscovery(snapshots, {}, excerpts).candidates;
  const roots = new Set(candidates.flatMap(c => c.source.context?.[0]?.id ?? []));
  const threads = [...roots].flatMap(root => convertXThread(snapshot, root).candidates);
  const converted = new Map([...singles, ...threads].map(item => [item.id, item]));
  return candidates.map(original => {
    const next = converted.get(original.id);
    return { id: original.id, matched: !!next && next.prompt === original.prompt && next.kind === original.kind && next.model === original.model,
      missing: !next };
  });
}
export const pilotIdentity = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Audit actual results; HTTP success and a populated page are not query-fidelity evidence. */
export function auditPilotSearch(query: string, result: TwitterAPIResult) {
  const boundary = (name: string) => {
    const time = query.match(new RegExp(`(?:^|\\s)${name}_time:(\\d+)(?:\\s|$)`));
    const date = query.match(new RegExp(`(?:^|\\s)${name}:(\\d{4}-\\d{2}-\\d{2})(?:\\s|$)`));
    return time ? Number(time[1]) * 1000 : date ? Date.parse(`${date[1]}T00:00:00Z`) : undefined;
  };
  const since = boundary("since"), until = boundary("until");
  return result.posts.flatMap(post => {
    const issues: string[] = [];
    const date = Date.parse(post.created_at ?? "");
    if (since !== undefined && date < since) issues.push("before-window");
    if (until !== undefined && date >= until) issues.push("after-window");
    for (const [operator, type] of [["reply", "replied_to"], ["quote", "quoted"], ["retweet", "retweeted"]] as const) {
      if (query.includes(`-is:${operator}`) && post.referenced_tweets?.some(ref => ref.type === type)) issues.push(`excluded-${operator}`);
    }
    const media = result.media.filter(item => post.attachments?.media_keys?.includes(item.media_key));
    if (query.includes("has:images") && !media.some(item => item.type === "photo")) issues.push("missing-image");
    if (query.includes("has:videos") && !media.some(item => item.type === "video" || item.type === "animated_gif")) issues.push("missing-video");
    return issues.length ? [{ id: post.id, issues }] : [];
  });
}
