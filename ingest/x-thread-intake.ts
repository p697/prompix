import { readFile, stat } from "node:fs/promises";
import { json } from "./publication.ts";
import { join } from "node:path";
import { z } from "zod";
import { creatorSchema } from "../packages/schema/catalog.ts";
import { type CreatorCache } from "./creators.ts";
import { readXIntake, xPostSchema, xMediaSchema, fullXText, extractMarkedXPrompt, buildXCandidate, attachedMedia, type XPost, type XMedia } from "./x-intake.ts";
import { analyzeXReplyThread, readXReplyCursors, recordedXReplyRequests } from "./x-replies.ts";
import { nativeXSourceDigest, nativeXSourceIssue } from "./x-source.ts";
import type { Candidate } from "./sources.ts";

const threadSnapshotSchema = z.object({ capturedAt: z.iso.datetime(), posts: z.array(xPostSchema).max(2000),
  creators: z.array(creatorSchema).max(2000), media: z.array(xMediaSchema).max(8000) });
export type XThreadSnapshot = z.infer<typeof threadSnapshotSchema>;

/** Root/ancestor media and prompt reply remain distinct, exact source records. */
export function convertXThread(snapshot: XThreadSnapshot, rootID: string) {
  const data = threadSnapshotSchema.parse(snapshot), root = data.posts.find(post => post.id === rootID);
  const candidates: Candidate[] = [], records: { postID: string; reason: string }[] = [];
  if (!root || root.conversation_id !== root.id) return { candidates, records: [{ postID: rootID, reason: "missing-verified-root" }] };
  const analysis = analyzeXReplyThread(root, data.posts, true);
  records.push(...analysis.blocked);
  for (const linked of analysis.linked) {
    const chain = linked.chain.map(id => data.posts.find(post => post.id === id)!);
    const post = chain.at(-1)!, ancestors = chain.slice(0, -1);
    // A truncated ancestor cannot provide honest source context even if a later body is complete.
    if (chain.some(value => fullXText(value).truncated || !value.created_at)) {
      records.push({ postID: post.id, reason: "incomplete-original-context" }); continue;
    }
    const profile = data.creators.find(value => value.platform === "x" && value.externalID === post.author_id);
    const extracted = extractMarkedXPrompt(post, data.media, { post: root, media: data.media });
    if ("reason" in extracted) { records.push({ postID: post.id, reason: extracted.reason }); continue; }
    const candidate = buildXCandidate(post, extracted, data.media, profile, data.capturedAt);
    if (!candidate.source.post) { records.push({ postID: post.id, reason: "missing-reply-attribution" }); continue; }
    candidate.source.post.parentID = ancestors.at(-1)!.id;
    candidate.source.context = ancestors.map((source, index) => ({ id: source.id, authorID: source.author_id,
      text: fullXText(source).text, createdAt: source.created_at!, checkedAt: data.capturedAt,
      ...(index ? { parentID: ancestors[index - 1].id } : {}) }));
    const ownMedia = attachedMedia(post, data.media);
    candidate.media = ownMedia ?? attachedMedia(root, data.media);
    candidate.source.mediaPostID = ownMedia ? post.id : root.id;
    candidate.source.method = "X API — original prompt reply with separately attributed source context";
    candidate.source.revision = nativeXSourceDigest(candidate);
    records.push({ postID: post.id, reason: nativeXSourceIssue(candidate) ?? "awaiting-editorial-and-preview-review" });
    candidates.push(candidate);
  }
  return { candidates, records };
}

const pageSchema = threadSnapshotSchema.extend({ posts: z.array(xPostSchema).max(100),
  root: z.object({ post: xPostSchema, capturedAt: z.iso.datetime(), snapshot: z.string(), creator: creatorSchema, media: z.array(xMediaSchema).max(400) }),
  request: z.object({ requestFingerprint: z.string(), fingerprint: z.string(), limit: z.number().int().min(10).max(100), nextToken: z.string().optional() }),
  nextToken: z.string().optional(),
});
/** Replay checked API pages, not the derived analysis.json; partial windows never publish. */
export async function readXThreads(root: string) {
  const cursors = await readXReplyCursors(root), candidates: Candidate[] = [];
  const records: { postID: string; reason: string }[] = [];
  for (const [rootID, cursor] of Object.entries(cursors)) {
    if (!cursor.completedAt || cursor.nextToken || cursor.exhausted || !cursor.pages) {
      records.push({ postID: rootID, reason: "incomplete-pagination" }); continue;
    }
    try {
      const directory = join(root, "x-replies", rootID, cursor.startedAt.replace(/[:.]/g, "-"));
      const posts = new Map<string, XPost>(), media = new Map<string, XMedia>(), profiles = new Map<string, z.infer<typeof creatorSchema>>();
      let nextToken: string | undefined, checkedAt = cursor.completedAt;
      for (let index = 1; index <= cursor.pages; index++) {
        const path = join(directory, `${String(index).padStart(3, "0")}.json`);
        if ((await stat(path)).size > 9_000_000) throw new Error("Oversized reply snapshot");
        const page = pageSchema.parse(JSON.parse(await readFile(path, "utf8")));
        const expected = recordedXReplyRequests(page.root, nextToken, page.request.limit)
          .find(request => request.fingerprint === cursor.requestIdentity && request.requestFingerprint === page.request.requestFingerprint);
        if (!expected || page.root.post.id !== rootID || page.request.fingerprint !== cursor.requestIdentity ||
            Date.parse(page.capturedAt) < Date.parse(cursor.startedAt) || Date.parse(page.capturedAt) > Date.parse(cursor.completedAt) ||
            (index < cursor.pages && !page.nextToken) || (index === cursor.pages && page.nextToken)) throw new Error("Reply window identity mismatch");
        checkedAt = Date.parse(page.capturedAt) < Date.parse(checkedAt) ? page.capturedAt : checkedAt;
        for (const post of page.posts) {
          const previous = posts.get(post.id);
          if (previous && JSON.stringify(previous) !== JSON.stringify(post)) throw new Error("Reply source changed within a page window");
          posts.set(post.id, post);
        }
        for (const value of page.media) {
          const previous = media.get(value.media_key);
          if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error("Reply media changed within a page window");
          media.set(value.media_key, value);
        }
        for (const profile of page.creators) profiles.set(profile.externalID ?? profile.id, profile);
        nextToken = page.nextToken;
      }
      // Require the API-returned root; the older lead is not a fresh availability check.
      const converted = convertXThread({ capturedAt: checkedAt, posts: [...posts.values()], media: [...media.values()], creators: [...profiles.values()] }, rootID);
      candidates.push(...converted.candidates); records.push(...converted.records);
    } catch { records.push({ postID: rootID, reason: "invalid-or-incomplete-thread-snapshot" }); }
  }
  return { candidates, records };
}
export async function readAllXIntake(root: string, creators: CreatorCache = {}) {
  const intake = await readXIntake(root, creators), threads = await readXThreads(root);
  const byID = new Map(intake.candidates.map(item => [item.id, item]));
  for (let item of threads.candidates) {
    const check = await json<{ rootID: string; snapshot: XThreadSnapshot } | undefined>(join(root, "x-replies", "checks", `${item.id}.json`), undefined);
    if (check && Date.parse(check.snapshot.capturedAt) >= Date.parse(item.source.post!.checkedAt)) {
      const current = check.rootID === item.source.context?.[0].id
        ? convertXThread(check.snapshot, check.rootID).candidates.find(value => value.id === item.id) : undefined;
      if (!current) { byID.delete(item.id); continue; }
      item = current;
    }
    byID.set(item.id, item);
  }
  return { ...intake, candidates: [...byID.values()], threads: { candidates: [...byID.values()].filter(item => item.source.context).length, records: threads.records } };
}
