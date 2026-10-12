import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { creatorSchema, type Prompt } from "../packages/schema/catalog.ts";
import { fingerprint, type Candidate } from "./sources.ts";
import type { CreatorCache } from "./creators.ts";

export const nativeXSourceName = "X";
export const nativeXPublicationBlocker = "Native X drafts await source and publication review";
const entitiesSchema = z.object({ urls: z.array(z.object({ url: z.string(), expanded_url: z.string().optional(), unwound_url: z.string().optional() })).max(100).optional() });
const noteSchema = z.object({ text: z.string().min(1).max(50000), entities: entitiesSchema.optional() });
const postSchema = z.object({
  id: z.string().regex(/^\d+$/), author_id: z.string().regex(/^\d+$/), text: z.string().max(50000),
  created_at: z.iso.datetime().optional(), truncated: z.boolean().optional(), entities: entitiesSchema.optional(),
  note_tweet: noteSchema.optional(), note_post: noteSchema.optional(),
  attachments: z.object({ media_keys: z.array(z.string()).max(20).optional() }).optional(),
});
const mediaSchema = z.object({ media_key: z.string(), type: z.enum(["photo", "video", "animated_gif"]),
  url: z.string().optional(), preview_image_url: z.string().optional(),
  variants: z.array(z.object({ content_type: z.string(), url: z.string(), bit_rate: z.number().optional() })).max(30).optional() });
const snapshotSchema = z.object({ posts: z.array(z.unknown()).max(100),
  creators: z.array(creatorSchema).max(100).optional(), media: z.array(z.unknown()).max(100).optional() });
type XPost = z.infer<typeof postSchema>;
type XMedia = z.infer<typeof mediaSchema>;
type Snapshot = { name: string; data: unknown };
export type XIntakeRecord = { postID: string; authorID?: string; sourceURL?: string; snapshot: string; candidateID?: string;
  fingerprint?: string; state: "draft" | "blocked"; reason: string; fullTextSource?: "note_tweet" | "note_post" | "text";
  expandedLinks?: string[]; hasCreatorProfile?: boolean; mediaItems?: number };
export type XIntakeReport = { snapshots: number; discovered: number; duplicatePosts: number; drafted: number; blocked: number;
  publicationBlocked: number; reviewedDrafts: number; reasons: Record<string, number>; snapshotErrors: { snapshot: string; reason: string }[] };

/** These are reviewable native drafts, never an implicit grant to republish X text. */
export function isNativeXDraft(item: Pick<Prompt, "source">): boolean { return item.source.name === nativeXSourceName; }

function safeURL(value: string | undefined, hosts?: readonly string[]) {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && (!hosts || hosts.includes(url.hostname))) return url.toString();
  } catch { /* A malformed source link remains unavailable. */ }
}
function sourceLinks(post: XPost): string[] {
  return [...new Set([...(post.entities?.urls ?? []), ...(post.note_tweet?.entities?.urls ?? []), ...(post.note_post?.entities?.urls ?? [])]
    .flatMap(item => { const link = safeURL(item.unwound_url) ?? safeURL(item.expanded_url); return link ? [link] : []; }))];
}

/** Only explicit instruction boundaries qualify. No fetch, continuation guessing or prose generation. */
export function extractMarkedXPrompt(post: XPost): { body: string; kind: Prompt["kind"] } | { reason: string } {
  const note = post.note_post ?? post.note_tweet;
  const text = (note?.text ?? post.text).trim();
  if (post.truncated && !note) return { reason: "api-truncated" };
  if (/(?:…|\.\.\.)\s*(?:https:\/\/\S+\s*)?$/u.test(text)) return { reason: "truncated-ending" };
  const markers = [...text.matchAll(/^(?:(full|text|image|video|web|website)\s+prompt|prompt|完整提示词|文本提示词|图片提示词|视频提示词|网页提示词|提示词)\s*[:：]\s*/gim)];
  if (!markers.length) return { reason: "missing-prompt-boundary" };
  if (markers.length !== 1) return { reason: "multiple-prompt-boundaries" };
  const marker = markers[0];
  const label = marker[0].toLowerCase();
  const kind = /image|图片/.test(label) ? "image" : /video|视频/.test(label) ? "video" : /website|web|网页/.test(label) ? "web" : "text";
  let body = text.slice(marker.index! + marker[0].length).trim();
  if (/^(?:`{3,}|~{3,})/.test(body)) {
    const opening = body.match(/^(`{3,}|~{3,})[^\r\n]*\r?\n/);
    if (!opening) return { reason: "incomplete-code-fence" };
    const lines = body.slice(opening[0].length).split(/\r?\n/);
    const close = lines.findIndex(line => new RegExp(`^${opening[1][0]}{${opening[1].length},}\\s*$`).test(line));
    if (close < 0) return { reason: "incomplete-code-fence" };
    body = lines.slice(0, close).join("\n").trim();
  }
  if (/(?:…|\.\.\.)\s*$/u.test(body)) return { reason: "truncated-ending" };
  // Keep the exact source instructions. A short link is not an expanded body;
  // it stays in intake for source review instead of becoming a copied snippet.
  if (/https?:\/\/(?:www\.)?t\.co\//i.test(body)) return { reason: "unresolved-short-link" };
  if (body.replace(/https?:\/\/\S+/g, "").trim().length < 20) return { reason: "insufficient-instructions" };
  if (body.length > 30000) return { reason: "instructions-too-long" };
  return { body, kind };
}

function attachedMedia(post: XPost, media: readonly XMedia[], kind: Prompt["kind"]): Prompt["media"] {
  if (kind === "text") return null;
  const attached = media.filter(item => post.attachments?.media_keys?.includes(item.media_key));
  const photos = attached.filter(item => item.type === "photo").flatMap(item => {
    const url = safeURL(item.url, ["pbs.twimg.com"]); return url ? [url] : [];
  }).slice(0, 8);
  const movie = attached.find(item => item.type !== "photo");
  const imageURL = photos[0] ?? safeURL(movie?.preview_image_url, ["pbs.twimg.com"]);
  const videoURL = movie?.variants?.filter(item => item.content_type === "video/mp4")
    .sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0)).map(item => safeURL(item.url, ["video.twimg.com"])).find(Boolean);
  if (!imageURL && !videoURL) return null;
  return { image: null, video: null, demoURL: null, ...(imageURL ? { imageURL } : {}),
    ...(photos.length > 1 ? { imageURLs: photos } : {}), ...(videoURL ? { videoURL } : {}) };
}

export function convertXDiscovery(snapshots: readonly Snapshot[], creators: CreatorCache = {}) {
  const records: XIntakeRecord[] = [], candidates: Candidate[] = [];
  const report: XIntakeReport = { snapshots: snapshots.length, discovered: 0, duplicatePosts: 0, drafted: 0, blocked: 0,
    publicationBlocked: 0, reviewedDrafts: 0, reasons: {}, snapshotErrors: [] };
  const posts = new Map<string, { post?: XPost; snapshot: string; creators: z.infer<typeof creatorSchema>[]; media: XMedia[] }>();
  for (const snapshot of [...snapshots].sort((a, b) => a.name.localeCompare(b.name))) {
    const parsed = snapshotSchema.safeParse(snapshot.data);
    if (!parsed.success) { report.snapshotErrors.push({ snapshot: snapshot.name, reason: "invalid-snapshot" }); continue; }
    const media = (parsed.data.media ?? []).flatMap(item => { const value = mediaSchema.safeParse(item); return value.success ? [value.data] : []; });
    for (const [index, value] of parsed.data.posts.entries()) {
      const parsedPost = postSchema.safeParse(value);
      const sourceID = value && typeof value === "object" && "id" in value && typeof value.id === "string" && /^\d+$/.test(value.id) ? value.id : undefined;
      if (!sourceID) {
        records.push({ postID: `invalid-${snapshot.name}-${index}`,
          snapshot: snapshot.name, state: "blocked", reason: "invalid-post" }); continue;
      }
      // Deduplicate identity before validation, so a later corrected snapshot
      // replaces a stale failure and a later invalid snapshot remains visible.
      if (posts.has(sourceID)) report.duplicatePosts++;
      posts.set(sourceID, { post: parsedPost.success ? parsedPost.data : undefined, snapshot: snapshot.name, creators: parsed.data.creators ?? [], media });
    }
  }
  for (const [postID, { post, snapshot, creators: profiles, media }] of posts) {
    const sourceURL = `https://x.com/i/web/status/${postID}`;
    if (!post) {
      records.push({ postID, sourceURL, snapshot, state: "blocked", reason: "invalid-post" });
      continue;
    }
    const profile = [...Object.values(creators), ...profiles].find(value => value.platform === "x" && value.externalID === post.author_id);
    const extracted = extractMarkedXPrompt(post);
    const record: XIntakeRecord = { postID: post.id, authorID: post.author_id, sourceURL, snapshot,
      state: "blocked", reason: "", fullTextSource: post.note_post ? "note_post" : post.note_tweet ? "note_tweet" : "text", expandedLinks: sourceLinks(post),
      hasCreatorProfile: !!profile, mediaItems: media.filter(item => post.attachments?.media_keys?.includes(item.media_key)).length };
    if ("reason" in extracted) { records.push({ ...record, reason: extracted.reason }); continue; }
    const id = `x-post-${post.id}`, hash = fingerprint(extracted.body);
    const author = profile?.displayName ?? `X account ${post.author_id}`;
    candidates.push({ id, kind: extracted.kind, title: `X prompt ${post.id}`,
      summary: "Source instructions captured for editorial review; not approved for publication.",
      prompt: extracted.body, example: "This source draft still needs completeness, attribution and publication review.",
      tags: ["X discovery"], model: "Unspecified", toolURL: null, artwork: "text-editorial", previewLabel: "Unreviewed source draft",
      creator: profile ? { ...profile, id: `x-id-${post.author_id}` } : {
        id: `x-id-${post.author_id}`, externalID: post.author_id, platform: "x", displayName: author,
        profileURL: `https://x.com/i/user/${post.author_id}`,
      },
      source: { name: nativeXSourceName, url: sourceURL, author, license: "Unspecified", method: "X API discovery" },
      media: attachedMedia(post, media, extracted.kind), ...(post.created_at ? { publishedAt: post.created_at } : {}),
      fingerprint: hash, featured: false, reviewStatus: "draft" });
    records.push({ ...record, state: "draft", reason: nativeXPublicationBlocker, candidateID: id, fingerprint: hash });
  }
  report.discovered = records.length;
  report.drafted = candidates.length;
  report.blocked = records.filter(item => item.state === "blocked").length;
  report.publicationBlocked = candidates.length;
  for (const record of records) report.reasons[record.reason] = (report.reasons[record.reason] ?? 0) + 1;
  return { candidates, records, report };
}

/** Read cached API results only. No source links, media or paid endpoints are fetched. */
export async function readXIntake(root: string, creators: CreatorCache = {}) {
  const directory = join(root, "x-discovery");
  let names: string[];
  try { names = (await readdir(directory)).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return convertXDiscovery([], creators); throw error; }
  const snapshots: Snapshot[] = [], errors: XIntakeReport["snapshotErrors"] = [];
  for (const name of names.sort()) {
    try {
      if ((await stat(join(directory, name))).size > 1_000_000) throw new Error("oversize-snapshot");
      snapshots.push({ name, data: JSON.parse(await readFile(join(directory, name), "utf8")) });
    } catch { errors.push({ snapshot: name, reason: "unreadable-or-oversize-snapshot" }); }
  }
  const result = convertXDiscovery(snapshots, creators);
  result.report.snapshots = names.length;
  result.report.snapshotErrors.push(...errors);
  return result;
}
