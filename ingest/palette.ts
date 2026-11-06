import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { paletteSchema, type Palette } from "../packages/schema/enrichment.ts";

/** Three dominant colors of a preview, computed locally: ffmpeg shrinks the image to a
 * fixed grid of RGB pixels and a deterministic k-means groups them. No model call. */

const exec = promisify(execFile);
const side = 64, clusters = 3, iterations = 16;

export type DecodePixels = (path: string) => Promise<Uint8Array>;

/** Area-averaged 64×64 RGB pixels; no shell, no inherited environment beyond PATH. */
export const decodeWithFFmpeg: DecodePixels = async path => {
  const { stdout } = await exec("ffmpeg", ["-nostdin", "-v", "error", "-i", path, "-frames:v", "1",
    "-vf", `scale=${side}:${side}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
  { encoding: "buffer", timeout: 30_000, maxBuffer: side * side * 3 + 1024, killSignal: "SIGKILL", env: { PATH: process.env.PATH, LANG: "C" } });
  return new Uint8Array(stdout);
};

export async function computePalette(path: string, decode: DecodePixels = decodeWithFFmpeg): Promise<Palette> {
  return paletteFromPixels(await decode(path));
}

type Color = [number, number, number];
const distance = (a: Color, b: Color) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const hex = (color: Color) => "#" + color.map(value => Math.round(value).toString(16).padStart(2, "0")).join("").toUpperCase();

export function paletteFromPixels(rgb: Uint8Array): Palette {
  if (rgb.length < 3 || rgb.length % 3 !== 0) throw new Error("Palette needs whole RGB pixels");
  const pixels: Color[] = [];
  for (let offset = 0; offset < rgb.length; offset += 3) pixels.push([rgb[offset], rgb[offset + 1], rgb[offset + 2]]);
  // Deterministic k-means++: seed with the most common coarse color, then the color that
  // is both frequent and far from every seed, so a small accent can still win a slot.
  const bins = new Map<number, { count: number; sum: Color }>();
  for (const pixel of pixels) {
    const key = (pixel[0] >> 4) << 8 | (pixel[1] >> 4) << 4 | pixel[2] >> 4, bin = bins.get(key) ?? { count: 0, sum: [0, 0, 0] };
    bin.count++; bin.sum = [bin.sum[0] + pixel[0], bin.sum[1] + pixel[1], bin.sum[2] + pixel[2]];
    bins.set(key, bin);
  }
  const candidates = [...bins].sort((a, b) => a[0] - b[0]).map(([, bin]) => ({ count: bin.count, color: bin.sum.map(sum => sum / bin.count) as Color }));
  let centers: Color[] = [];
  while (centers.length < clusters) {
    let best = candidates[0], score = -1;
    for (const candidate of candidates) {
      const value = centers.length ? candidate.count * Math.min(...centers.map(center => distance(candidate.color, center))) : candidate.count;
      if (value > score) { best = candidate; score = value; }
    }
    centers.push([...best.color] as Color);
  }
  let counts: number[] = [];
  for (let round = 0; round < iterations; round++) {
    const sums = centers.map(() => [0, 0, 0]);
    counts = centers.map(() => 0);
    for (const pixel of pixels) {
      let best = 0;
      for (let index = 1; index < clusters; index++) if (distance(pixel, centers[index]) < distance(pixel, centers[best])) best = index;
      counts[best]++;
      for (let channel = 0; channel < 3; channel++) sums[best][channel] += pixel[channel];
    }
    const next = centers.map((center, index) => counts[index] ? sums[index].map(sum => sum / counts[index]) as Color : center);
    const moved = next.some((center, index) => distance(center, centers[index]) > 0.25);
    centers = next;
    if (!moved) break;
  }
  // Floor to three decimals so the weights never sum above one.
  const colors = centers.map((center, index) => ({ hex: hex(center), weight: Math.floor(counts[index] / pixels.length * 1000) / 1000 }))
    .sort((a, b) => b.weight - a.weight || a.hex.localeCompare(b.hex));
  return paletteSchema.parse(colors);
}
