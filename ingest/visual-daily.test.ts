import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Prompt } from "../packages/schema/catalog.ts";
import { prepareDailyVisualReview } from "./visual-daily.ts";
import { applyEditorialReviews } from "./editorial.ts";
import { selectLibrary, retainPublishedLibrary } from "./library.ts";
import { fingerprint, type Candidate } from "./sources.ts";
import { visualLedgerSchema, visualReviewModel, type VisualAttempt } from "./visual-review.ts";

function picture(): Candidate {
  const prompt = "Create a quiet garden illustration with a stone path, flowering trees, soft morning light and a small wooden bench. Keep the composition spacious and readable.";
  return { id: "visual-daily-fixture", kind: "image", title: "Quiet garden", summary: "An original test fixture.",
    prompt, example: "Synthetic instructions for a test.", tags: ["Garden"], model: "Test model", toolURL: null,
    artwork: "test", previewLabel: "Source image", source: { name: "Test", url: "https://example.com/garden",
      license: "Original", method: "Synthetic test fixture" },
    media: { image: null, video: null, demoURL: null, imageURL: `https://api.prompix.dev/media/${"a".repeat(64)}.jpg` },
    fingerprint: fingerprint(prompt), featured: false, reviewStatus: "draft" };
}

test("daily dry-run cannot use a configured provider or write a visual ledger, and cached metadata cannot publish media", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-visual-dry-"));
  try {
    const item = picture();
    const reviewed = applyEditorialReviews([item], { [item.id]: { fingerprint: item.fingerprint,
      reviewedAt: "2026-10-12T00:00:00Z", metadata: { title: item.title, summary: item.summary,
        example: item.example, tags: item.tags, previewLabel: item.previewLabel } } });
    const selected = selectLibrary(reviewed, new Set());
    assert.equal(selected.length, 1, "A historical metadata approval still reaches the independent gate");
    const result = await prepareDailyVisualReview(selected, [], root, false,
      { PROMPIX_VISUAL_PROVIDER: "codex", PROMPIX_CODEX: "/must-not-be-executed" });
    assert.equal(result.report.requests, 0);
    assert.deepEqual(result.prompts, []);
    assert.deepEqual(result.withheldIDs, [item.id]);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("withheld media replacement preserves the entire previous snapshot and its saved identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-visual-retention-"));
  try {
    const item = picture();
    const previous: Prompt = { ...item, prompt: "Create a quiet garden with a single flowering tree and a wooden bench.",
      media: { ...item.media!, imageURL: `https://api.prompix.dev/media/${"b".repeat(64)}.jpg` } };
    const result = await prepareDailyVisualReview([item], [previous], root, true, {});
    assert.deepEqual(result.withheldIDs, [item.id]);
    const retained = retainPublishedLibrary(result.prompts, [previous], new Set(), () => "awaiting-media-review");
    assert.deepEqual(retained.prompts, [previous]);
    assert.equal(retained.retainedPrevious.reasons["awaiting-media-review"], 1);
    assert.equal(result.report.requests, 0);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unchanged published snapshot stays available without inventing a visual approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-visual-previous-"));
  try {
    const item = picture();
    const result = await prepareDailyVisualReview([item], [item], root, true, {});
    assert.deepEqual(result.prompts, [item]);
    assert.equal(result.report.previousSnapshots, 1);
    assert.equal(result.report.approved, 0);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("daily zero budget prevents configured provider and media preparation without writing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-visual-zero-"));
  try {
    const result = await prepareDailyVisualReview([picture()], [], root, true,
      { PROMPIX_VISUAL_PROVIDER: "codex", PROMPIX_VISUAL_MAX_REQUESTS: "0", PROMPIX_CODEX: "/must-not-be-executed" });
    assert.equal(result.report.maxRequests, 0); assert.equal(result.report.requests, 0);
    assert.equal(result.report.dailyRequests, 0); assert.equal(result.report.prepared, 0);
    assert.equal(result.report.status, "daily-limit"); assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("daily visual budget configuration validates before media or provider work, including dry-run", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-visual-budget-"));
  try {
    for (const value of ["-1", "41", "4.5", "", "four"]) {
      await assert.rejects(prepareDailyVisualReview([picture()], [], root, false,
        { PROMPIX_VISUAL_PROVIDER: "codex", PROMPIX_VISUAL_MAX_REQUESTS: value, PROMPIX_CODEX: "/must-not-be-executed" }), /request limit/);
    }
    const result = await prepareDailyVisualReview([picture()], [], root, false, { PROMPIX_VISUAL_MAX_REQUESTS: "7" });
    assert.equal(result.report.maxRequests, 7); assert.equal(result.report.requests, 0);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function batchFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "prompix-visual-wrapper-")), bin = join(root, "bin");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(bin);
  // Original one-pixel JPEG, with synthetic local probe/provider executables: no network or model runs.
  const pixel = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=", "base64");
  const hash = createHash("sha256").update(pixel).digest("hex");
  t.mock.method(globalThis, "fetch", async () => new Response(pixel));
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
  await writeFile(join(bin, "ffprobe"), `#!${process.execPath}
process.stdout.write(JSON.stringify({ streams: [{ codec_name: "mjpeg", width: 1, height: 1 }] }));
`, { mode: 0o700 });
  const executable = join(bin, "synthetic-provider.cjs"), calls = join(root, "calls.jsonl");
  await writeFile(executable, `#!${process.execPath}
const fs = require("node:fs");
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const { candidates } = JSON.parse(input.trim().split("\\n").at(-1));
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(candidates.map(item => item.id)) + "\\n");
  const decisions = candidates.map(item => ({ id: item.id, identity: item.identity, verdict: "match", reason: "Synthetic wrapper response.",
    attachments: item.attachments.map(attachment => ({ id: attachment.id, sha256: attachment.sha256, verdict: "match", reason: "Synthetic attachment response." })) }));
  fs.writeFileSync(process.argv[process.argv.indexOf("--output-last-message") + 1], JSON.stringify({ decisions }));
});
`, { mode: 0o700 });
  const items = Array.from({ length: 6 }, (_, index) => ({ ...picture(), id: `wrapper-${index}`,
    media: { ...picture().media!, imageURL: `https://api.prompix.dev/media/${hash}.jpg` } }));
  return { root, items, calls, environment: { PROMPIX_VISUAL_PROVIDER: "codex", PROMPIX_CODEX: executable } };
}

test("daily visual wrapper migrates legacy usage and preserves separate audit files for every batch", async t => {
  const { root, items, calls, environment } = await batchFixture(t);
  const day = "2026-10-12", directory = join(root, "visual-review"), clock = () => new Date(`${day}T12:00:00Z`);
  const ledgerPath = join(directory, "daily-attempts", `${day}.json`);
  await mkdir(join(directory, "daily-attempts"), { recursive: true });
  const legacy: VisualAttempt = { day, requests: 1, model: visualReviewModel, reservedAt: `${day}T00:00:00Z`,
    candidateIDs: ["legacy"], identities: ["a".repeat(64)], inputCharacters: 100, attachments: 1, attachmentBytes: 100, state: "completed" };
  await writeFile(ledgerPath, JSON.stringify(legacy));
  await mkdir(join(directory, "responses"));
  await writeFile(join(directory, "responses", `${day}.json`), "Legacy audit evidence\n");
  const result = await prepareDailyVisualReview(items, [], root, true,
    { ...environment, PROMPIX_VISUAL_MAX_REQUESTS: "3" }, clock);
  assert.equal(result.report.status, "reviewed"); assert.equal(result.report.requests, 2); assert.equal(result.report.dailyRequests, 3);
  assert.equal(result.prompts.length, 6);
  const ledger = visualLedgerSchema.parse(JSON.parse(await readFile(ledgerPath, "utf8")));
  assert.deepEqual(ledger.attempts[0], legacy);
  assert.deepEqual((await readdir(join(directory, "responses"))).sort(), [`${day}-002.json`, `${day}-003.json`, `${day}.json`]);
  assert.equal(await readFile(join(directory, "responses", `${day}.json`), "utf8"), "Legacy audit evidence\n");
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 2);
  await writeFile(ledgerPath, JSON.stringify({ ...ledger, day: "2026-10-11",
    attempts: ledger.attempts.map(attempt => ({ ...attempt, day: "2026-10-11" })) }));
  await assert.rejects(prepareDailyVisualReview(items, [], root, true, environment, clock), /ledger does not match its UTC day file/);
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 2, "A journal stored under the wrong day cannot reset paid usage");
});

test("UTC rollover stops new visual calls while preserving completed batches and the consumed reservation", async t => {
  const { root, items, calls, environment } = await batchFixture(t);
  const day = "2026-10-12", tomorrow = "2026-10-13", directory = join(root, "visual-review");
  let clockReads = 0;
  const result = await prepareDailyVisualReview(items, [], root, true, environment,
    () => new Date(++clockReads <= 2 ? `${day}T23:59:59Z` : `${tomorrow}T00:00:01Z`));
  assert.equal(result.report.status, "failed"); assert.match(result.report.error!, /UTC visual review day changed/);
  assert.equal(result.report.requests, 2); assert.equal(result.prompts.length, 3);
  const ledger = visualLedgerSchema.parse(JSON.parse(await readFile(join(directory, "daily-attempts", `${day}.json`), "utf8")));
  assert.deepEqual(ledger.attempts.map(attempt => attempt.state), ["completed", "failed"]);
  assert.deepEqual(await readdir(join(directory, "responses")), [`${day}-001.json`]);
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 1);
  const blocked = await prepareDailyVisualReview(items, [], root, true, environment, () => new Date(`${day}T23:59:59Z`));
  assert.equal(blocked.report.requests, 0); assert.equal(blocked.prompts.length, 3);
  const resumed = await prepareDailyVisualReview(items, [], root, true, environment, () => new Date(`${tomorrow}T00:00:01Z`));
  assert.equal(resumed.report.requests, 1); assert.equal(resumed.report.dailyRequests, 1); assert.equal(resumed.prompts.length, 6);
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 2);
  assert.deepEqual((await readdir(join(directory, "responses"))).sort(), [`${day}-001.json`, `${tomorrow}-001.json`]);
});
