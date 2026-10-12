import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { Prompt } from "../packages/schema/catalog.ts";
import { prepareVisualMedia, type VisualMediaDependencies } from "./visual-media.ts";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const mirror = (bytes: Buffer, extension = "jpg") => `https://api.prompix.dev/media/${digest(bytes)}.${extension}`;
const jpeg = (marker = 0) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, marker, 0xff, 0xd9]);
const mp4 = Buffer.from([0, 0, 0, 20, ...Buffer.from("ftypisom"), 0, 0, 0, 0]);
const cover = jpeg(), second = jpeg(1);
const fixture: Prompt = { id: "visual-fixture", kind: "image", title: "Original fixture", summary: "Synthetic example",
  prompt: "Draw a red square on a plain background.", example: "Original test instructions", tags: ["test"], model: "Any", toolURL: null,
  artwork: "test", previewLabel: "Synthetic fixture", source: { name: "Prompix", url: null, license: "Original", method: "Test" },
  media: { image: null, video: null, demoURL: null, imageURL: mirror(cover) } };
const videoFixture: Prompt = { ...fixture, kind: "video", media: { ...fixture.media!, videoURL: mirror(mp4, "mp4") } };
async function temporary(work: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "prompix-visual-media-test-"));
  try { await work(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
function harness(options: { duration?: number; frameTimes?: number[]; hasAudio?: boolean; badFrame?: boolean; shiftedTimes?: boolean } = {}) {
  const fetched: string[] = [], commands: { command: string; args: string[] }[] = [];
  const assets = new Map([[mirror(cover), cover], [mirror(second), second], [mirror(mp4, "mp4"), mp4]]);
  const frameTimes = options.frameTimes ?? Array.from({ length: 100 }, (_, index) => index / 10);
  const dependencies: VisualMediaDependencies = {
    fetch: async (url, init) => {
      assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
      fetched.push(String(url));
      const bytes = assets.get(String(url)); assert.ok(bytes, "Unexpected URL must not trigger a real network request");
      return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/octet-stream" } });
    },
    run: async (command, args, settings) => {
      commands.push({ command, args });
      assert.equal(settings.timeout, 30_000); assert.equal(settings.maxBuffer, 1_000_000);
      assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file");
      if (args.includes("-show_frames")) return { stdout: JSON.stringify({ frames: frameTimes.map(time => ({ best_effort_timestamp_time: String(time) })) }), stderr: "" };
      if (args.some(arg => arg.startsWith("format=duration"))) return { stdout: JSON.stringify({ format: { duration: String(options.duration ?? 10) },
        streams: [{ codec_type: "video", width: 1920, height: 1080, duration: String(options.duration ?? 10) }, ...(options.hasAudio ? [{ codec_type: "audio" }] : [])] }), stderr: "" };
      if (command === "ffprobe") return { stdout: JSON.stringify({ streams: [{ codec_name: "mjpeg", width: 640, height: 360 }] }), stderr: "" };
      assert.equal(args[args.indexOf("-enable_drefs") + 1], "0");
      assert.equal(args[args.indexOf("-use_absolute_path") + 1], "0");
      const filter = args[args.indexOf("-vf") + 1], indexes = [...filter.matchAll(/eq\(n\\,(\d+)\)/g)].map(match => Number(match[1]));
      assert.equal(indexes.length, 6);
      const output = args.at(-1)!;
      for (let index = 0; index < indexes.length; index++) await writeFile(output.replace("%02d", String(index).padStart(2, "0")), options.badFrame ? Buffer.from("not an image") : jpeg(index + 10));
      return { stdout: "", stderr: indexes.map((frame, index) => `[Parsed_showinfo_2] n: ${index} pts: ${frame} pts_time:${frameTimes[frame] + (options.shiftedTimes ? 1 : 0)} fmt:yuv420p s:640x360`).join("\n") };
    },
  };
  return { dependencies, fetched, commands, assets };
}

test("mirrored image preparation preserves exact bytes, cover-first gallery order and role while deduplicating", () => temporary(async directory => {
  const { dependencies, fetched } = harness(), prompt = { ...fixture, media: { ...fixture.media!, imageURLs: [mirror(cover), mirror(second), mirror(cover)] } };
  const original = structuredClone(prompt), result = await prepareVisualMedia(prompt, directory, dependencies);
  assert.deepEqual(result.coverage, { mode: "images" });
  assert.deepEqual(fetched, [mirror(cover), mirror(second)]);
  assert.deepEqual(result.attachments.map(({ id, role, sourceURL }) => ({ id, role, sourceURL })), [
    { id: "image-0", role: "image", sourceURL: mirror(cover) }, { id: "image-1", role: "image", sourceURL: mirror(second) },
  ]);
  for (const [index, attachment] of result.attachments.entries()) {
    const bytes = await readFile(attachment.path);
    assert.ok(isAbsolute(attachment.path)); assert.deepEqual(bytes, index === 0 ? cover : second);
    assert.equal(attachment.sha256, digest(bytes)); assert.equal(attachment.byteLength, bytes.length);
    assert.equal(attachment.timeSeconds, undefined);
  }
  assert.deepEqual(prompt, original);
}));

test("invalid hosts, URL variants, unsupported web and missing media are rejected before downloading", () => temporary(async directory => {
  const { dependencies, fetched } = harness();
  for (const url of ["https://evil.example/media/" + digest(cover) + ".jpg", mirror(cover) + "?token=secret", mirror(cover) + "#part", mirror(cover) + "\n", mirror(cover) + "\r\n",
    mirror(cover).replace("https:", "http:"), mirror(cover).replace("api.prompix.dev", "api.prompix.dev:443"),
    mirror(cover).replace("api.prompix.dev", "user@api.prompix.dev"), mirror(cover).replace(".jpg", ".png")]) {
    await assert.rejects(prepareVisualMedia({ ...fixture, media: { ...fixture.media!, imageURLs: [mirror(cover), url] } }, directory, dependencies), /invalid-mirrored-media-url/);
  }
  await assert.rejects(prepareVisualMedia({ ...fixture, kind: "web" }, directory, dependencies), /web-visual-preparation-unsupported/);
  await assert.rejects(prepareVisualMedia({ ...fixture, media: null }, directory, dependencies), /missing-mirrored-image/);
  await assert.rejects(prepareVisualMedia({ ...videoFixture, media: { ...videoFixture.media!, imageURL: undefined } }, directory, dependencies), /missing-video-poster/);
  await assert.rejects(prepareVisualMedia({ ...fixture, kind: "video" }, directory, dependencies), /missing-mirrored-video/);
  assert.deepEqual(fetched, []);
}));

test("content hashes and signatures are verified before decoding and partial files are removed", () => temporary(async directory => {
  for (const bytes of [jpeg(99), Buffer.from("<html>not a JPEG</html>")]) {
    const { dependencies, commands } = harness(), url = bytes[0] === 0xff ? mirror(cover) : mirror(bytes);
    dependencies.fetch = async () => new Response(new Uint8Array(bytes));
    await assert.rejects(prepareVisualMedia({ ...fixture, media: { ...fixture.media!, imageURL: url } }, directory, dependencies), bytes[0] === 0xff ? /media-checksum-mismatch/ : /invalid-media-signature/);
    assert.deepEqual(commands, []); assert.deepEqual(await readdir(directory), []);
  }
  const { dependencies } = harness(); dependencies.fetch = async () => new Response(null, { status: 302, headers: { Location: "https://evil.example/secret" } });
  await assert.rejects(prepareVisualMedia(fixture, directory, dependencies), /media-download-response/);
  assert.deepEqual(await readdir(directory), []);
}));

test("the exact JPEG byte limit is accepted and decoded overflow is rejected despite a smaller advertised length", () => temporary(async directory => {
  const exact = Buffer.alloc(8_000_000); jpeg().copy(exact); exact[exact.length - 2] = 0xff; exact[exact.length - 1] = 0xd9;
  const { dependencies } = harness();
  dependencies.fetch = async () => new Response(new Uint8Array(exact), { headers: { "Content-Length": "100", "Content-Encoding": "br" } });
  const result = await prepareVisualMedia({ ...fixture, media: { ...fixture.media!, imageURL: mirror(exact) } }, directory, dependencies);
  assert.equal(result.attachments[0].byteLength, 8_000_000);
  let cancelled = false;
  dependencies.fetch = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(exact)); controller.enqueue(new Uint8Array([0]));
  }, cancel() { cancelled = true; } }), { headers: { "Content-Length": "1" } });
  await assert.rejects(prepareVisualMedia(fixture, directory, dependencies), /media-download-failed-or-oversize/);
  assert.equal(cancelled, true);
}));

test("short video evidence includes original poster, gallery, six actual frames, audio presence and source hash", () => temporary(async directory => {
  const { dependencies, fetched } = harness({ hasAudio: true });
  const prompt = { ...videoFixture, media: { ...videoFixture.media!, imageURLs: [mirror(cover), mirror(second)] } };
  const result = await prepareVisualMedia(prompt, directory, dependencies);
  assert.deepEqual(fetched, [mirror(cover), mirror(second), mirror(mp4, "mp4")]);
  assert.deepEqual(result.attachments.map(item => item.role), ["poster", "image", ...Array(6).fill("video-frame")]);
  assert.equal(result.coverage.mode, "sampled-frames");
  if (result.coverage.mode !== "sampled-frames") throw new Error("Missing sampled coverage");
  assert.equal(result.coverage.durationSeconds, 10); assert.equal(result.coverage.hasAudio, true);
  assert.equal(result.coverage.videoSHA256, digest(mp4)); assert.equal(result.coverage.videoSourceURL, mirror(mp4, "mp4"));
  assert.deepEqual(result.coverage.sampleTimes, [0, 2, 4, 5.9, 7.9, 9.9]);
  for (const [index, attachment] of result.attachments.slice(2).entries()) {
    const bytes = await readFile(attachment.path);
    assert.equal(attachment.timeSeconds, result.coverage.sampleTimes[index]); assert.equal(attachment.sourceURL, mirror(mp4, "mp4"));
    assert.equal(attachment.sha256, digest(bytes)); assert.equal(attachment.byteLength, bytes.length);
  }
}));

test("long, invalid, sparse or incomplete video timelines defer and remove all partial assets", () => temporary(async directory => {
  for (const options of [{ duration: 60.0001 }, { duration: 0 }, { duration: NaN }, { frameTimes: [0, 1, 2, 3, 4] },
    { frameTimes: [0, 2, 4, 6, 8, 10] }, { frameTimes: [0, 0.1, 0.2, 0.3, 0.4, 9.9] }, { frameTimes: [0, 1, 2, 3, 4, 8] }]) {
    const { dependencies } = harness(options);
    await assert.rejects(prepareVisualMedia(videoFixture, directory, dependencies), /unsupported-video-duration|invalid-video-frame-times|insufficient-video-timeline-coverage|insufficient-distinct-video-frames/);
    assert.deepEqual(await readdir(directory), []);
  }
  const { dependencies } = harness({ duration: 60, frameTimes: Array.from({ length: 600 }, (_, index) => index / 10) });
  assert.equal((await prepareVisualMedia(videoFixture, directory, dependencies)).coverage.mode, "sampled-frames");
}));

test("bad MP4 signatures and the video decoded byte limit fail before video probing", () => temporary(async directory => {
  const bad = Buffer.from("not an MP4 file"), { dependencies, assets } = harness(); assets.set(mirror(bad, "mp4"), bad);
  await assert.rejects(prepareVisualMedia({ ...videoFixture, media: { ...videoFixture.media!, videoURL: mirror(bad, "mp4") } }, directory, dependencies), /invalid-media-signature/);
  const originalFetch = dependencies.fetch;
  dependencies.fetch = async (url, init) => String(url).endsWith(".mp4") ? new Response(new Uint8Array([0]), { headers: { "Content-Length": "60000001" } }) : originalFetch(url, init);
  await assert.rejects(prepareVisualMedia(videoFixture, directory, dependencies), /media-download-failed-or-oversize/);
  let cancelled = false;
  dependencies.fetch = async (url, init) => String(url).endsWith(".mp4") ? new Response(new ReadableStream({ start(controller) {
    const chunk = new Uint8Array(7_500_000);
    for (let index = 0; index < 8; index++) controller.enqueue(chunk);
    controller.enqueue(new Uint8Array([0]));
  }, cancel() { cancelled = true; } })) : originalFetch(url, init);
  await assert.rejects(prepareVisualMedia(videoFixture, directory, dependencies), /media-download-failed-or-oversize/);
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(directory), []);
}));

test("malformed probes, timeouts, oversized diagnostics and mismatched extracted frames fail closed without leaking diagnostics", () => temporary(async directory => {
  for (const mode of ["json", "timeout", "output"]) {
    const { dependencies } = harness();
    dependencies.run = async () => {
      if (mode === "timeout") throw new Error("private-token-fixture timed out");
      return { stdout: mode === "json" ? "not JSON" : "x".repeat(1_000_001), stderr: "" };
    };
    await assert.rejects(prepareVisualMedia(fixture, directory, dependencies), error => {
      assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /private-token-fixture/); return true;
    });
    assert.deepEqual(await readdir(directory), []);
  }
  for (const options of [{ badFrame: true }, { shiftedTimes: true }]) {
    await assert.rejects(prepareVisualMedia(videoFixture, directory, harness(options).dependencies), /invalid-video-frame-signature|unverified-extracted-frame-times/);
    assert.deepEqual(await readdir(directory), []);
  }
}));

test("local synthetic MP4 produces verifiable JPEG frames with actual timestamps and bounded dimensions", async t => {
  const exec = promisify(execFile);
  try { await exec("ffmpeg", ["-version"], { timeout: 5000 }); await exec("ffprobe", ["-version"], { timeout: 5000 }); }
  catch { t.skip("Local ffmpeg/ffprobe unavailable; deterministic adapter coverage still runs"); return; }
  await temporary(async directory => {
    const poster = join(directory, "synthetic.jpg"), video = join(directory, "synthetic.mp4");
    await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=1600x900:d=0.1", "-frames:v", "1", "-threads", "1", poster], { timeout: 30_000 });
    await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1600x900:rate=12:duration=2", "-f", "lavfi", "-i", "sine=frequency=400:duration=2",
      "-c:v", "mpeg4", "-q:v", "4", "-threads", "1", "-c:a", "aac", "-shortest", "-movflags", "+faststart", video], { timeout: 30_000 });
    const imageBytes = await readFile(poster), videoBytes = await readFile(video);
    const assets = new Map([[mirror(imageBytes), imageBytes], [mirror(videoBytes, "mp4"), videoBytes]]);
    const result = await prepareVisualMedia({ ...videoFixture, media: { ...videoFixture.media!, imageURL: mirror(imageBytes), videoURL: mirror(videoBytes, "mp4") } }, join(directory, "prepared"), {
      fetch: async url => { const bytes = assets.get(String(url)); assert.ok(bytes); return new Response(new Uint8Array(bytes)); },
    });
    assert.equal(result.attachments.length, 7);
    assert.equal(result.coverage.mode, "sampled-frames");
    if (result.coverage.mode !== "sampled-frames") throw new Error("Missing video coverage");
    assert.equal(result.coverage.hasAudio, true); assert.equal(result.coverage.videoSHA256, digest(videoBytes));
    const { sampleTimes, durationSeconds } = result.coverage;
    assert.equal(sampleTimes.length, 6); assert.ok(sampleTimes[0] <= durationSeconds * 0.1);
    assert.ok(sampleTimes.at(-1)! >= durationSeconds * 0.9); assert.ok(sampleTimes.at(-1)! < durationSeconds);
    for (const attachment of result.attachments.slice(1)) {
      const bytes = await readFile(attachment.path);
      assert.equal(attachment.sha256, digest(bytes)); assert.equal(attachment.byteLength, bytes.length);
      const probe = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", attachment.path]);
      const dimensions = JSON.parse(probe.stdout).streams[0]; assert.ok(dimensions.width <= 1200); assert.ok(dimensions.height <= 1200);
    }
  });
});
