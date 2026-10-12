import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, lstat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Prompt } from "../packages/schema/catalog.ts";
import { readResponseBytes } from "./network.ts";
import { visualLimits, visualVideoFrameCount, type PreparedVisualMedia, type VisualAttachment } from "./visual-review.ts";
export type { PreparedVisualMedia, VisualAttachment, VisualCoverage } from "./visual-review.ts";

const exec = promisify(execFile);
const imageLimit = visualLimits.attachmentBytes, videoLimit = 60_000_000, frameCount = visualVideoFrameCount;
const processOptions = { timeout: 30_000, maxBuffer: 1_000_000 } as const;
const mirror = /^https:\/\/api\.prompix\.dev\/media\/([a-f0-9]{64})\.(jpg|mp4)$/;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type ProcessOptions = { timeout: number; maxBuffer: number };
export type VisualMediaDependencies = {
  fetch: typeof fetch;
  run: (command: "ffprobe" | "ffmpeg", args: string[], options: ProcessOptions) => Promise<{ stdout: string; stderr: string }>;
};
export class VisualMediaPreparationError extends Error {
  constructor(readonly code: string) { super(`Visual media preparation deferred: ${code}`); this.name = "VisualMediaPreparationError"; }
}
function fail(code: string): never { throw new VisualMediaPreparationError(code); }

const defaults: VisualMediaDependencies = {
  fetch: (...args) => fetch(...args),
  run: async (command, args, options) => {
    // No shell or inherited credentials; diagnostics are never surfaced to the caller.
    return exec(command, args, { ...options, killSignal: "SIGKILL", env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" } });
  },
};
function checkedMirror(url: string, extension: "jpg" | "mp4") {
  const match = mirror.exec(url);
  if (!match || match[0] !== url || match[2] !== extension) fail("invalid-mirrored-media-url");
  return match[1];
}
function isJPEG(bytes: Buffer) {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}
async function fetchMedia(url: string, extension: "jpg" | "mp4", dependencies: VisualMediaDependencies) {
  const sha256 = checkedMirror(url, extension), limit = extension === "jpg" ? imageLimit : videoLimit;
  let bytes: Buffer;
  try {
    const response = await dependencies.fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (response.status !== 200 || response.url && response.url !== url) fail("media-download-response");
    bytes = await readResponseBytes(response, limit);
  } catch (error) {
    if (error instanceof VisualMediaPreparationError) throw error;
    fail("media-download-failed-or-oversize");
  }
  if (!bytes.length || bytes.length > limit) fail("media-download-failed-or-oversize");
  if (digest(bytes) !== sha256) fail("media-checksum-mismatch");
  if (extension === "jpg" ? !isJPEG(bytes) : bytes.length < 12 || bytes.subarray(4, 8).toString("ascii") !== "ftyp") fail("invalid-media-signature");
  return { bytes, sha256 };
}
async function run(dependencies: VisualMediaDependencies, command: "ffprobe" | "ffmpeg", args: string[]) {
  try {
    const result = await dependencies.run(command, args, processOptions);
    // Also enforce the adapter contract when using an injected process implementation.
    if (Buffer.byteLength(result.stdout) > processOptions.maxBuffer || Buffer.byteLength(result.stderr) > processOptions.maxBuffer) fail("media-process-output-limit");
    return result;
  } catch (error) {
    if (error instanceof VisualMediaPreparationError) throw error;
    fail(command === "ffprobe" ? "media-probe-failed" : "video-frame-extraction-failed");
  }
}
function jsonObject(text: string): Record<string, unknown> {
  try { const value = JSON.parse(text); if (value && typeof value === "object" && !Array.isArray(value)) return value; }
  catch { /* Only validated metadata can become evidence. */ }
  fail("invalid-media-probe");
}
function objects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== "object" || Array.isArray(item))) fail("invalid-media-probe");
  return value;
}
function dimensions(stream: Record<string, unknown>, maximumPixels = 33_554_432) {
  const width = Number(stream.width), height = Number(stream.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 16384 || height > 16384 || width * height > maximumPixels) fail("unsupported-media-dimensions");
  return { width, height };
}
async function inspectJPEG(path: string, dependencies: VisualMediaDependencies, maximumDimension?: number) {
  const output = await run(dependencies, "ffprobe", ["-v", "error", "-max_alloc", "67108864", "-protocol_whitelist", "file",
    "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-of", "json", path]);
  const streams = objects(jsonObject(output.stdout).streams);
  if (streams.length !== 1 || streams[0].codec_name !== "mjpeg") fail("invalid-jpeg-content");
  const size = dimensions(streams[0]);
  if (maximumDimension && Math.max(size.width, size.height) > maximumDimension) fail("oversized-video-frame");
}
const localMovieInput = ["-protocol_whitelist", "file", "-enable_drefs", "0", "-use_absolute_path", "0", "-f", "mov"];

async function videoFrames(path: string, directory: string, sourceURL: string, sha256: string, dependencies: VisualMediaDependencies): Promise<PreparedVisualMedia> {
  const metadata = await run(dependencies, "ffprobe", ["-v", "error", "-max_alloc", "67108864", ...localMovieInput,
    "-show_entries", "format=duration:stream=codec_type,width,height,duration", "-of", "json", path]);
  const info = jsonObject(metadata.stdout), streams = objects(info.streams), videos = streams.filter(stream => stream.codec_type === "video");
  if (videos.length !== 1) fail("unsupported-video-streams");
  dimensions(videos[0]);
  const format = info.format && typeof info.format === "object" ? info.format as Record<string, unknown> : {};
  const durations = [Number(format.duration), Number(videos[0].duration)].filter(value => Number.isFinite(value) && value > 0);
  const durationSeconds = Math.max(...durations);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 60) fail("unsupported-video-duration");
  const frames = await run(dependencies, "ffprobe", ["-v", "error", "-max_alloc", "67108864", ...localMovieInput,
    "-select_streams", "v:0", "-show_frames", "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", path]);
  const timestamps = objects(jsonObject(frames.stdout).frames).map(frame => Number(frame.best_effort_timestamp_time));
  if (timestamps.length < frameCount || timestamps.length > 14400 || timestamps.some((value, index) => !Number.isFinite(value) || value < 0 || index > 0 && value < timestamps[index - 1])) fail("invalid-video-frame-times");
  const origin = timestamps[0], end = timestamps.at(-1)! - origin;
  if (end < durationSeconds * 0.9 || end >= durationSeconds) fail("insufficient-video-timeline-coverage");
  const selected = Array.from({ length: frameCount }, (_, sample) => {
    const target = origin + end * sample / (frameCount - 1);
    return timestamps.reduce((nearest, value, index) => Math.abs(value - target) < Math.abs(timestamps[nearest] - target) ? index : nearest, 0);
  });
  if (new Set(selected).size !== frameCount) fail("insufficient-distinct-video-frames");
  const sampleTimes = selected.map(index => Number((timestamps[index] - origin).toFixed(6)));
  if (sampleTimes.some((time, index) => index > 0 && (time <= sampleTimes[index - 1] || time - sampleTimes[index - 1] > durationSeconds * 0.5))) fail("insufficient-video-timeline-coverage");
  const selection = selected.map(index => `eq(n\\,${index})`).join("+");
  const output = await run(dependencies, "ffmpeg", ["-hide_banner", "-loglevel", "info", "-nostdin", "-n", "-max_alloc", "67108864", "-threads", "1", "-filter_threads", "1", "-copyts",
    ...localMovieInput, "-i", path, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf",
    `select=${selection},scale=w='min(1200,iw)':h='min(1200,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,showinfo`,
    "-frames:v", String(frameCount), "-fps_mode", "passthrough", "-q:v", "3", "-threads", "1", "-map_metadata", "-1", "-fs", String(frameCount * imageLimit),
    "-f", "image2", "-start_number", "0", join(directory, "frame-%02d.jpg")]);
  const decoded = [...output.stderr.matchAll(/\bn:\s*(\d+)\s+pts:\s*[-\d]+\s+pts_time:([^\s]+).*?\bs:(\d+)x(\d+)/g)];
  if (decoded.length !== frameCount || decoded.some((frame, index) => Number(frame[1]) !== index || !Number.isFinite(Number(frame[2]))
    || Math.abs(Number(frame[2]) - timestamps[selected[index]]) > 0.001 || Number(frame[3]) <= 0 || Number(frame[4]) <= 0 || Number(frame[3]) > 1200 || Number(frame[4]) > 1200)) fail("unverified-extracted-frame-times");
  const files = (await readdir(directory)).filter(name => /^frame-.*\.jpg$/.test(name));
  if (files.length !== frameCount) fail("incomplete-video-frames");
  const attachments: VisualAttachment[] = [];
  for (let index = 0; index < frameCount; index++) {
    const path = join(directory, `frame-${String(index).padStart(2, "0")}.jpg`), details = await lstat(path);
    if (!details.isFile() || details.size <= 0 || details.size > imageLimit) fail("invalid-video-frame-file");
    const bytes = await readFile(path);
    if (!isJPEG(bytes)) fail("invalid-video-frame-signature");
    await inspectJPEG(path, dependencies, 1200);
    attachments.push({ id: `frame-${index}`, path, sha256: digest(bytes), byteLength: bytes.length, role: "video-frame", sourceURL, timeSeconds: sampleTimes[index] });
  }
  return { attachments, coverage: { mode: "sampled-frames", durationSeconds, sampleTimes, videoSHA256: sha256, videoSourceURL: sourceURL,
    hasAudio: streams.some(stream => stream.codec_type === "audio") } };
}

/** Files live beneath the caller-owned directory. Failed preparation removes its partial files. */
export async function prepareVisualMedia(prompt: Prompt, directory: string, overrides: Partial<VisualMediaDependencies> = {}): Promise<PreparedVisualMedia> {
  if (prompt.kind === "web") fail("web-visual-preparation-unsupported");
  const images = [...new Set([prompt.media?.imageURL, ...(prompt.media?.imageURLs ?? [])].filter((url): url is string => !!url))];
  const video = prompt.media?.videoURL;
  if (!images.length) fail(video ? "missing-video-poster" : "missing-mirrored-image");
  if (images.length > 8 || (prompt.media?.imageURLs?.length ?? 0) > 8) fail("too-many-images");
  if (prompt.kind === "video" && !video) fail("missing-mirrored-video");
  for (const image of images) checkedMirror(image, "jpg");
  if (video) checkedMirror(video, "mp4");
  const dependencies = { ...defaults, ...overrides };
  await mkdir(resolve(directory), { recursive: true });
  const working = await mkdtemp(join(resolve(directory), "visual-"));
  try {
    const attachments: VisualAttachment[] = [];
    for (const [index, url] of images.entries()) {
      const { bytes, sha256 } = await fetchMedia(url, "jpg", dependencies), path = join(working, `image-${index}.jpg`);
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      await inspectJPEG(path, dependencies);
      attachments.push({ id: video && index === 0 ? "poster-0" : `image-${index}`, path, sha256, byteLength: bytes.length,
        role: video && index === 0 ? "poster" : "image", sourceURL: url });
    }
    if (!video) return { attachments, coverage: { mode: "images" } };
    const { bytes, sha256 } = await fetchMedia(video, "mp4", dependencies), path = join(working, "source.mp4");
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    const sampled = await videoFrames(path, working, video, sha256, dependencies);
    return { attachments: [...attachments, ...sampled.attachments], coverage: sampled.coverage };
  } catch (error) {
    await rm(working, { recursive: true, force: true });
    if (error instanceof VisualMediaPreparationError) throw error;
    fail("media-preparation-failed");
  }
}
