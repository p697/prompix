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
/** Caller serializes access to root. Each immutable object and mapping survives a later item failure. */
export async function mirrorPromptMedia(prompt: Prompt, root: string, dependencies = defaults): Promise<Prompt> {
  if (!prompt.media || !websiteMediaNeedsMirroring(prompt)) return prompt;
  const media = { ...prompt.media, ...(prompt.media.imageURLs ? { imageURLs: [...prompt.media.imageURLs] } : {}) };
  const mappings = await json<Record<string, string>>(join(root, "media-map.json"), {});
  const aspects = await json<Record<string, number>>(join(root, "media-aspects.json"), {});
  const targets = [
    ...(["imageURL", "videoURL"] as const).flatMap(field => media[field] ? [{ url: media[field]!, video: field === "videoURL", cover: field === "imageURL", assign: (url: string) => { media[field] = url; } }] : []),
    ...(media.imageURLs ?? []).map((url, index) => ({ url, video: false, cover: false, assign: (value: string) => { media.imageURLs![index] = value; } })),
  ];
  await mkdir(join(root, "tmp"), { recursive: true });
  const temporary = await mkdtemp(join(root, "tmp", "media-"));
  try {
    for (const { url, video, cover, assign } of targets) {
      if (mappings[url]) {
        if (!/^https:\/\/api\.prompix\.dev\/media\/[a-f0-9]{64}\.(jpg|mp4)$/.test(mappings[url])) throw new Error("Invalid cached media identity");
        assign(mappings[url]);
        if (cover) {
          if (!aspects[url]) {
            const cached = await dependencies.download(mappings[url], ["api.prompix.dev"], 8_000_000);
            const file = join(temporary, "aspect.jpg"); await writeFile(file, cached.bytes);
            aspects[url] = await dependencies.aspectRatio(file); await atomic(join(root, "media-aspects.json"), aspects);
          }
          media.aspectRatio = aspects[url];
        }
        continue;
      }
      const data = await dependencies.download(url, mediaHosts, video ? 60_000_000 : 20_000_000);
      if (video && data.bytes.subarray(4, 8).toString() !== "ftyp") throw new Error("Invalid MP4 signature");
      if (video ? !["video/mp4", "application/octet-stream"].includes(data.type) : !["image/jpeg", "image/png", "image/webp"].includes(data.type)) throw new Error("Unexpected media type");
      const input = join(temporary, `source.${video ? "mp4" : data.type.split("/")[1]}`), output = video ? input : join(temporary, "preview.jpg");
      await writeFile(input, data.bytes);
      if (!video) {
        await dependencies.prepareJPEG(input, output); aspects[url] = await dependencies.aspectRatio(output);
        if (cover) media.aspectRatio = aspects[url];
        await atomic(join(root, "media-aspects.json"), aspects);
      }
      const hash = createHash("sha256").update(await readFile(output)).digest("hex"), key = `media/${hash}.${video ? "mp4" : "jpg"}`;
      await dependencies.upload(key, output, video ? "video/mp4" : "image/jpeg");
      mappings[url] = `${base}/${key}`; assign(mappings[url]); await atomic(join(root, "media-map.json"), mappings);
    }
    return { ...prompt, media };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
