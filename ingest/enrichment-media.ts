import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Prompt } from "../packages/schema/catalog.ts";
import type { Palette } from "../packages/schema/enrichment.ts";
import type { EnrichmentImage } from "./enrichment-review.ts";
import { prepareJPEG } from "./images.ts";
import { computePalette } from "./palette.ts";
import { prepareVisualMedia, VisualMediaPreparationError } from "./visual-media.ts";

export type PreparedEnrichmentMedia = { images: (EnrichmentImage & { sourceRole: string })[]; video?: { durationSeconds: number; hasAudio: boolean }; palette?: Palette; error?: string };

/** Verified mirrored media only, prepared once per directory. `full` sends every image and all
 * six frames, the visual review's standard, which minors judgments need; otherwise the cover
 * (and two frames for video). */
export async function prepareEnrichmentMedia(item: Prompt, directory: string, full: boolean): Promise<PreparedEnrichmentMedia> {
  const record = join(directory, "prepared.json");
  const cached = await readFile(record, "utf8").then(text => JSON.parse(text) as PreparedEnrichmentMedia, () => undefined);
  if (cached) return cached;
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  let prepared: PreparedEnrichmentMedia;
  if (!item.media?.imageURL) prepared = { images: [] };
  else try {
    // Text and web items can carry a preview image; they are prepared like a still image.
    const media = await prepareVisualMedia(item.kind === "video" ? item : { ...item, kind: "image" }, directory);
    const posters = media.attachments.filter(attachment => attachment.role !== "video-frame");
    const frames = media.attachments.filter(attachment => attachment.role === "video-frame");
    const chosen = [...(full ? posters : posters.slice(0, 1)), ...(full ? frames : frames.filter((_, index) => index === 1 || index === 4))];
    const images: PreparedEnrichmentMedia["images"] = [];
    for (const [index, attachment] of chosen.entries()) {
      const path = join(directory, `model-${index}.jpg`);
      await prepareJPEG(attachment.path, path, 768);
      images.push({ path, mediaType: "image/jpeg", role: attachment.role, sourceRole: attachment.id,
        ...(attachment.timeSeconds !== undefined ? { timeSeconds: attachment.timeSeconds } : {}) });
    }
    prepared = {
      images, palette: await computePalette(posters[0].path),
      ...(media.coverage.mode === "sampled-frames" ? { video: { durationSeconds: media.coverage.durationSeconds, hasAudio: media.coverage.hasAudio } } : {}),
    };
  } catch (error) {
    prepared = { images: [], error: error instanceof VisualMediaPreparationError ? error.code : (error as Error).message.slice(0, 200) };
  }
  // Keep only the downscaled model images; the verified originals and videos are not needed again.
  for (const name of await readdir(directory)) if (name.startsWith("visual-")) await rm(join(directory, name), { recursive: true, force: true });
  await writeFile(record, JSON.stringify(prepared, null, 2));
  return prepared;
}
