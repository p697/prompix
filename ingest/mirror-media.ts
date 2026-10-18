import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Prompt } from "../packages/schema/catalog.ts";
import { aspectRatio, prepareJPEG } from "./images.ts";
import { download } from "./network.ts";
import { atomic, base, json, upload } from "./publication.ts";
import { websiteMediaNeedsMirroring } from "./website-review.ts";

export const mediaHosts = ["api.prompix.dev", "pbs.twimg.com", "video.twimg.com", "cms-assets.youmind.com", "cdn.youmind.com",
  "customer-qs6wnyfuv0gcybzj.cloudflarestream.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"];
export type MediaMirrorDependencies = { download: typeof download; upload: typeof upload; prepareJPEG: typeof prepareJPEG; aspectRatio: typeof aspectRatio };
const defaults: MediaMirrorDependencies = { download, upload, prepareJPEG, aspectRatio };
/** One session owns the maps; writes are serialized even when downloads overlap. */
async function mirrorSession(root: string, dependencies: MediaMirrorDependencies) {
  const mappings = await json<Record<string, string>>(join(root, "media-map.json"), {});
  const aspects = await json<Record<string, number>>(join(root, "media-aspects.json"), {});
  let writes = Promise.resolve(), persistenceError: Error | undefined;
  const persist = () => {
    writes = writes.then(async () => {
      await atomic(join(root, "media-map.json"), mappings);
      await atomic(join(root, "media-aspects.json"), aspects);
    }).catch(error => { persistenceError ??= error instanceof Error ? error : new Error("Media state write failed"); throw persistenceError; });
    return writes;
  };
  const pending = new Map<string, Promise<{ url: string; aspect?: number }>>();
  const target = (url: string, video: boolean) => {
    const identity = `${video ? "video" : "image"}:${url}`;
    const existing = pending.get(identity); if (existing) return existing;
    const request = (async () => {
      if (persistenceError) throw persistenceError;
      if (mappings[url] && !/^https:\/\/api\.prompix\.dev\/media\/[a-f0-9]{64}\.(jpg|mp4)$/.test(mappings[url])) throw new Error("Invalid cached media identity");
      if (mappings[url] && (video || aspects[url])) return { url: mappings[url], aspect: aspects[url] };
      await mkdir(join(root, "tmp"), { recursive: true });
      const temporary = await mkdtemp(join(root, "tmp", "media-"));
      try {
        if (mappings[url]) {
          const cached = await dependencies.download(mappings[url], ["api.prompix.dev"], 8_000_000);
          const file = join(temporary, "aspect.jpg"); await writeFile(file, cached.bytes);
          aspects[url] = await dependencies.aspectRatio(file); await persist();
          return { url: mappings[url], aspect: aspects[url] };
        }
        const data = await dependencies.download(url, mediaHosts, video ? 60_000_000 : 20_000_000);
        if (video && data.bytes.subarray(4, 8).toString() !== "ftyp") throw new Error("Invalid MP4 signature");
        if (video ? !["video/mp4", "application/octet-stream"].includes(data.type) : !["image/jpeg", "image/png", "image/webp"].includes(data.type)) throw new Error("Unexpected media type");
        const input = join(temporary, `source.${video ? "mp4" : data.type.split("/")[1]}`), output = video ? input : join(temporary, "preview.jpg");
        await writeFile(input, data.bytes);
        if (!video) { await dependencies.prepareJPEG(input, output); aspects[url] = await dependencies.aspectRatio(output); }
        const hash = createHash("sha256").update(await readFile(output)).digest("hex"), key = `media/${hash}.${video ? "mp4" : "jpg"}`;
        if (persistenceError) throw persistenceError;
        await dependencies.upload(key, output, video ? "video/mp4" : "image/jpeg");
        mappings[url] = `${base}/${key}`; await persist();
        return { url: mappings[url], aspect: aspects[url] };
      } finally { await rm(temporary, { recursive: true, force: true }); }
    })();
    // Retain a rejected promise too: a shared failed URL is tried once per run.
    pending.set(identity, request); return request;
  };
  return {
    async mirror(prompt: Prompt): Promise<Prompt> {
      if (persistenceError) throw persistenceError;
      if (!prompt.media || !websiteMediaNeedsMirroring(prompt)) return prompt;
      const media = { ...prompt.media, ...(prompt.media.imageURLs ? { imageURLs: [...prompt.media.imageURLs] } : {}) };
      if (media.imageURL) { const result = await target(media.imageURL, false); media.imageURL = result.url; media.aspectRatio = result.aspect; }
      if (media.videoURL) media.videoURL = (await target(media.videoURL, true)).url;
      for (let index = 0; index < (media.imageURLs?.length ?? 0); index++) media.imageURLs![index] = (await target(media.imageURLs![index], false)).url;
      return { ...prompt, media };
    },
    async drain() { await writes; },
  };
}
/** Caller owns root. Each immutable mapping survives a later item failure. */
export async function mirrorPromptMedia(prompt: Prompt, root: string, dependencies = defaults): Promise<Prompt> {
  if (!prompt.media || !websiteMediaNeedsMirroring(prompt)) return prompt;
  const session = await mirrorSession(root, dependencies);
  return session.mirror(prompt);
}
/** Bounded historical work shares in-flight URLs and keeps source order stable. */
export async function mirrorPromptMediaBatch(prompts: readonly Prompt[], root: string, concurrency = 3, dependencies = defaults) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error("Invalid media concurrency");
  const session = await mirrorSession(root, dependencies);
  const results: (Prompt | undefined)[] = new Array(prompts.length), failures: ({ id: string; error: string } | undefined)[] = new Array(prompts.length);
  let next = 0;
  await Promise.allSettled(Array.from({ length: Math.min(concurrency, prompts.length) }, async () => {
    while (next < prompts.length) {
      const index = next++;
      try { results[index] = await session.mirror(prompts[index]); }
      catch (error) { failures[index] = { id: prompts[index].id, error: (error instanceof Error ? error.message : "Media failure").slice(0, 300) }; }
    }
  }));
  // A filesystem failure blocks the batch; it cannot be treated as a bad image.
  await session.drain();
  return { prompts: results.filter((p): p is Prompt => p !== undefined), errors: failures.filter((e): e is { id: string; error: string } => e !== undefined) };
}
