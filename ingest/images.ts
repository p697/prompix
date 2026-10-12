import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import type { Prompt } from "../packages/schema/catalog.ts";

const exec = promisify(execFile);
export async function aspectRatio(path: string): Promise<number> {
  const result = await exec("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { timeout: 30000 });
  const width = Number(result.stdout.match(/pixelWidth: (\d+)/)?.[1]);
  const height = Number(result.stdout.match(/pixelHeight: (\d+)/)?.[1]);
  if (!width || !height) throw new Error("Invalid image dimensions");
  return width / height;
}

export async function prepareJPEG(input: string, output: string, maximumDimension = 1200) {
  await exec("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "82", "-Z", String(maximumDimension), input, "--out", output], { timeout: 30000 });
}

/** Original bundled images are mirrored too, so older installs can display new art. */
export async function publishStudioImages(
  prompts: Prompt[], assets: string, cache: Record<string, string>,
  publish: (input: string) => Promise<string>,
): Promise<Prompt[]> {
  const result: Prompt[] = [];
  for (const prompt of prompts) {
    if (prompt.kind !== "image" || !prompt.media?.image || prompt.source.name !== "Prompix Studio") {
      result.push(prompt); continue;
    }
    const folder = join(assets, prompt.media.image + ".imageset");
    const manifest = JSON.parse(await readFile(join(folder, "Contents.json"), "utf8"));
    const file = manifest.images?.find((image: { filename?: string }) => image.filename)?.filename;
    if (typeof file !== "string" || basename(file) !== file || !/\.(png|jpg|jpeg)$/.test(file)) throw new Error("Invalid studio image resource");
    const input = join(folder, file);
    const key = "studio:" + createHash("sha256").update(await readFile(input)).digest("hex");
    const imageURL = cache[key] ?? await publish(input);
    if (!/^https:\/\/api\.prompix\.dev\/media\/[a-f0-9]{64}\.jpg$/.test(imageURL)) throw new Error("Invalid studio image mirror");
    cache[key] = imageURL;
    result.push({ ...prompt, media: { ...prompt.media, imageURL } });
  }
  return result;
}
