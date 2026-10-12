import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { creatorSchema, type Prompt } from "../packages/schema/catalog.ts";
import { fingerprint, type Candidate } from "./sources.ts";
import type { CreatorCache } from "./creators.ts";

export const nativeXSourceName = "X";
export const nativeXPublicationBlocker = "Native X drafts await source and publication review";
const entitiesSchema = z.object({ urls: z.array(z.object({ url: z.string(), expanded_url: z.string().optional(), unwound_url: z.string().optional(),
  media_key: z.string().optional() })).max(100).optional() });
const noteSchema = z.object({ text: z.string().min(1).max(50000), truncated: z.boolean().optional(), entities: entitiesSchema.optional() });
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
type XURLEntity = NonNullable<z.infer<typeof entitiesSchema>["urls"]>[number];
type Snapshot = { name: string; data: unknown };
export type XIntakeRecord = { postID: string; authorID?: string; sourceURL?: string; snapshot: string; candidateID?: string;
  fingerprint?: string; sourceDigest?: string; state: "draft" | "blocked"; reason: string; fullTextSource?: "note_tweet" | "note_post" | "text";
  expandedLinks?: string[]; hasCreatorProfile?: boolean; mediaItems?: number; attachedMediaKeys?: string[] };
export type XIntakeReport = { snapshots: number; discovered: number; duplicatePosts: number; drafted: number; blocked: number;
  publicationBlocked: number; reviewedDrafts: number; reasons: Record<string, number>; snapshotErrors: { snapshot: string; reason: string }[] };

/** These are reviewable native drafts, never an implicit grant to republish X text. */
export function isNativeXDraft(item: Pick<Prompt, "source">): boolean { return item.source.name === nativeXSourceName; }

/** Exact source identity for publication review; profile enrichment and editorial metadata are deliberately excluded. */
export function nativeXSourceDigest(item: Pick<Prompt, "id" | "kind" | "prompt" | "model" | "source" | "creator" | "media">): string {
  return createHash("sha256").update(JSON.stringify(["prompix-x-source-1", item.id, item.kind, item.model, item.prompt,
    item.source.url, item.creator?.externalID ?? null,
    item.media?.imageURL ?? null, item.media?.imageURLs ?? [], item.media?.videoURL ?? null, item.media?.demoURL ?? null])).digest("hex");
}

function safeURL(value: string | undefined, hosts?: readonly string[]) {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port && (!hosts || hosts.includes(url.hostname))) return url.toString();
  } catch { /* A malformed source link remains unavailable. */ }
}
function sourceLinks(post: XPost): string[] {
  return [...new Set([...(post.entities?.urls ?? []), ...(post.note_tweet?.entities?.urls ?? []), ...(post.note_post?.entities?.urls ?? [])]
    .flatMap(item => { const link = safeURL(item.unwound_url) ?? safeURL(item.expanded_url); return link ? [link] : []; }))];
}

const truncatedEnding = /(?:…|\.\.\.)\s*(?:https?:\/\/\S+\s*)*$/u;
function fullText(post: XPost) {
  const notes = (["note_post", "note_tweet"] as const).flatMap(source => post[source] ? [{ ...post[source], source }] : []);
  // A complete long-form field takes precedence over the display text and an incomplete alias.
  return notes.find(note => !note.truncated && !truncatedEnding.test(note.text.trim())) ?? notes[0] ?? { text: post.text, entities: post.entities, truncated: post.truncated, source: "text" as const };
}

function verifiedMedia(post: XPost, media: readonly XMedia[]): XMedia[] {
  return media.filter(item => post.attachments?.media_keys?.includes(item.media_key) && (item.type === "photo"
    ? !!safeURL(item.url, ["pbs.twimg.com"])
    : item.variants?.some(variant => variant.content_type === "video/mp4" && safeURL(variant.url, ["video.twimg.com"]))));
}

function expandedEntityLink(entity: XURLEntity) {
  const target = safeURL(entity.unwound_url) ?? safeURL(entity.expanded_url);
  return target && new URL(target).hostname !== "t.co" && new URL(target).hostname !== "www.t.co" ? target : undefined;
}

function urlTokenPattern(url: string) {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(?<![\\w/])" + escaped + "(?=$|[\\s<>\"'`)}\\]]|[.,;!?](?=$|\\s))", "g");
}

function conflictingPostLink(entity: XURLEntity, postID: string): boolean {
  return [entity.expanded_url, entity.unwound_url].some(value => {
    const safe = safeURL(value);
    if (!safe) return false;
    const url = new URL(safe);
    if (!["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)) return false;
    const linkedID = url.pathname.match(/^\/(?:[^/]+|i\/web)\/status\/(\d+)(?:\/|$)/)?.[1];
    return !!linkedID && linkedID !== postID;
  });
}

function resolveBodyLinks(body: string, post: XPost, media: readonly XMedia[], entities: z.infer<typeof entitiesSchema> | undefined): { body: string } | { reason: string } {
  const urls = entities?.urls ?? [], attached = verifiedMedia(post, media);
  const attachmentLink = (url: string) => {
    const matches = urls.filter(entity => entity.url === url);
    return matches.length > 0 && matches.every(entity => entity.media_key && !conflictingPostLink(entity, post.id)
      && attached.some(item => item.media_key === entity.media_key));
  };
  for (const entity of urls) {
    if (!urlTokenPattern(entity.url).test(body)) continue;
    const target = expandedEntityLink(entity), url = target ? new URL(target) : undefined;
    const ownMediaLink = url && ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)
      && new RegExp(`^/[^/]+/status/${post.id}/(?:photo|video)/[0-9]+/?$`).test(url.pathname);
    if (entity.media_key && conflictingPostLink(entity, post.id)) return { reason: "conflicting-media-reference" };
    if ((entity.media_key || ownMediaLink) && !attachmentLink(entity.url)) return { reason: "unverified-media-reference" };
  }
  // Only URL-only trailing lines are placeholders. An inline reference remains part of the instructions.
  while (body) {
    const start = body.lastIndexOf("\n") + 1, line = body.slice(start).trim();
    const links = line.split(/\s+/);
    if (!links.every(link => /^https:\/\/t\.co\/[a-z0-9]+$/i.test(link) && attachmentLink(link))) break;
    body = body.slice(0, start).trimEnd();
  }
  for (const url of new Set(urls.map(entity => entity.url))) {
    if (!/^https:\/\/t\.co\/[a-z0-9]+$/i.test(url)) continue;
    const targets = urls.filter(entity => entity.url === url).map(expandedEntityLink);
    if (!targets.length || !targets[0] || targets.some(target => target !== targets[0])) continue;
    body = body.replace(urlTokenPattern(url), () => targets[0]!);
  }
  return { body };
}

function inferModality(label: string, context: string, body: string, post: XPost, media: readonly XMedia[]): { kind: Prompt["kind"]; model?: string } | { reason: string } {
  const explicit = /image|图片|画像/.test(label) ? "image" : /video|视频|動画/.test(label) ? "video" : /website|web|网页|ウェブ/.test(label) ? "web" : /text|文本|テキスト/.test(label) ? "text" : undefined;
  const models: { pattern: RegExp; kind: Prompt["kind"] }[] = [
    { pattern: /\b(?:Nano Banana(?: Pro)?|GPT[- ]Image(?:[- ]\d+(?:\.\d+)*)?|Midjourney|FLUX(?:\.\d+)?|Stable Diffusion)\b/i, kind: "image" },
    { pattern: /\b(?:Seedance(?:\s+\d+(?:\.\d+)*)?|Sora(?:\s+\d+)?|Veo(?:\s+\d+(?:\.\d+)*)?|Kling(?:\s+\d+(?:\.\d+)*)?|Runway Gen[- ]\d+)\b/i, kind: "video" },
    { pattern: /\b(?:Claude(?:\s+(?:Opus|Sonnet|Haiku))?(?:\s+\d+(?:\.\d+)*)?|ChatGPT|GPT[- ]\d+(?:\.\d+)*)\b/i, kind: "text" },
  ];
  const matched = models.flatMap(model => { const match = context.match(model.pattern); return match ? [{ kind: model.kind, model: match[0] }] : []; });
  if (explicit) return { kind: explicit, ...(matched.find(model => model.kind === explicit) ?? {}) };
  const evidence = new Set(matched.map(model => model.kind));
  if (/\b(?:write|draft|rewrite)\b[^\n.!?]{0,80}\b(?:story|stories|essay|email|letter|article|poem|response|reply|summary|outline|report|paragraph|blog post)\b|\b(?:summari[sz]e|translate|proofread)\b|\b(?:answer|respond to)\s+(?:my|the|these|each)\s+questions?\b|(?:撰写|改写|翻译|总结|概括|润色|回答)[^\n。！？]{0,40}(?:文本|文章|故事|邮件|问题|内容|段落)/iu.test(body)) evidence.add("text");
  if (/\b(?:build|create|implement|design|code)\b[^\n.!?]{0,80}\b(?:website|web page|landing page|web app)\b|(?:创建|搭建|开发|设计)[^\n。！？]{0,40}(?:网页|网站)/iu.test(body)) evidence.add("web");
  if (evidence.size > 1) return { reason: "conflicting-modality-evidence" };
  if (evidence.size === 1) { const kind = [...evidence][0]; return { kind, ...(matched.find(model => model.kind === kind) ?? {}) }; }
  const attachedKinds = new Set(verifiedMedia(post, media).map(item => item.type === "photo" ? "image" as const : "video" as const));
  return attachedKinds.size === 1 ? { kind: [...attachedKinds][0] } : { reason: "ambiguous-modality" };
}

/** Only explicit instruction boundaries qualify. No fetch, continuation guessing or prose generation. */
export function extractMarkedXPrompt(post: XPost, media: readonly XMedia[] = []): { body: string; kind: Prompt["kind"]; model?: string } | { reason: string } {
  const source = fullText(post), text = source.text.trim();
  if (source.truncated) return { reason: "api-truncated" };
  if (truncatedEnding.test(text)) return { reason: "truncated-ending" };
  const markers = [...text.matchAll(/^[\t ]*(?:(?:#{1,6}|>|[-+*•▪◦]|\d{1,2}[.)])[\t ]+|(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})[\uFE0F\u200D\p{Emoji_Modifier}]*[\t ]*)*(?:\*\*|__)?((?:(?:full|text|image|video|web|website)[\t ]+)?prompt|完整提示词|文本提示词|图片提示词|视频提示词|网页提示词|提示词|(?:(?:画像|動画|テキスト|ウェブサイト|ウェブ|web)[\t ]*)?プロンプト)(?:\*\*|__)?[\t ]*[:：](?:\*\*|__)?[\t ]*/gimu)];
  if (!markers.length) return { reason: "missing-prompt-boundary" };
  if (markers.length !== 1) return { reason: "multiple-prompt-boundaries" };
  const marker = markers[0];
  const label = marker[1].toLowerCase();
  let body = text.slice(marker.index! + marker[0].length).trim();
  if (/^(?:`{3,}|~{3,})/.test(body)) {
    const opening = body.match(/^(`{3,}|~{3,})[^\r\n]*\r?\n/);
    if (!opening) return { reason: "incomplete-code-fence" };
    const lines = body.slice(opening[0].length).split(/\r?\n/);
    const close = lines.findIndex(line => new RegExp(`^${opening[1][0]}{${opening[1].length},}\\s*$`).test(line));
    if (close < 0) return { reason: "incomplete-code-fence" };
    body = lines.slice(0, close).join("\n").trim();
  }
  const links = resolveBodyLinks(body, post, media, source.entities);
  if ("reason" in links) return links;
  body = links.body;
  if (truncatedEnding.test(body)) return { reason: "truncated-ending" };
  // Keep the exact source instructions. A short link is not an expanded body;
  // it stays in intake for source review instead of becoming a copied snippet.
  if (/https?:\/\/(?:www\.)?t\.co\//i.test(body)) return { reason: "unresolved-short-link" };
  if (body.replace(/https?:\/\/\S+/g, "").trim().length < 20) return { reason: "insufficient-instructions" };
  if (body.length > 30000) return { reason: "instructions-too-long" };
  const modality = inferModality(label, text, body, post, media);
  return "reason" in modality ? modality : { body, ...modality };
}

function attachedMedia(post: XPost, media: readonly XMedia[]): Prompt["media"] {
  const attached = verifiedMedia(post, media);
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
    const extracted = extractMarkedXPrompt(post, media);
    const record: XIntakeRecord = { postID: post.id, authorID: post.author_id, sourceURL, snapshot,
      state: "blocked", reason: "", fullTextSource: fullText(post).source, expandedLinks: sourceLinks(post),
      hasCreatorProfile: !!profile, mediaItems: verifiedMedia(post, media).length, attachedMediaKeys: post.attachments?.media_keys ?? [] };
    if ("reason" in extracted) { records.push({ ...record, reason: extracted.reason }); continue; }
    const id = `x-post-${post.id}`, hash = fingerprint(extracted.body);
    const author = profile?.displayName ?? `X account ${post.author_id}`;
    candidates.push({ id, kind: extracted.kind, title: `X prompt ${post.id}`,
      summary: "Source instructions captured for editorial review; not approved for publication.",
      prompt: extracted.body, example: "This source draft still needs completeness, attribution and publication review.",
      tags: ["X discovery"], model: extracted.model ?? "Unspecified", toolURL: null, artwork: "text-editorial", previewLabel: "Unreviewed source draft",
      creator: profile ? { ...profile, id: `x-id-${post.author_id}` } : {
        id: `x-id-${post.author_id}`, externalID: post.author_id, platform: "x", displayName: author,
        profileURL: `https://x.com/i/user/${post.author_id}`,
      },
      source: { name: nativeXSourceName, url: sourceURL, author, license: "Unspecified", method: "X API discovery" },
      media: attachedMedia(post, media), ...(post.created_at ? { publishedAt: post.created_at } : {}),
      fingerprint: hash, featured: false, reviewStatus: "draft" });
    records.push({ ...record, state: "draft", reason: nativeXPublicationBlocker, candidateID: id, fingerprint: hash, sourceDigest: nativeXSourceDigest(candidates.at(-1)!) });
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
