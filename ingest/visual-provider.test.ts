import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { codexVisualProvider, visualInstructions, visualResponseSchema } from "./visual-provider.ts";
import { visualInputCharacters, visualLimits, visualProviderInput, visualRequestText, visualReviewModel, type VisualAttachment, type VisualDecision, type VisualInput } from "./visual-review.ts";

// One-pixel synthetic JPEG; no third-party source imagery or prompt content.
const pixel = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=", "base64");
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t: TestContext, count = 2) {
  const root = await mkdtemp(join(tmpdir(), "prompix-visual-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attachments: VisualAttachment[] = [];
  for (let index = 0; index < count; index++) {
    // Different valid JPEG comment segments distinguish order and byte binding.
    const comment = Buffer.from(`synthetic-${index}`), segment = Buffer.alloc(4);
    segment[0] = 0xff; segment[1] = 0xfe; segment.writeUInt16BE(comment.length + 2, 2);
    const bytes = Buffer.concat([pixel.subarray(0, 2), segment, comment, pixel.subarray(2)]);
    const path = join(root, `private attachment ${index}; $.jpg`), hash = sha(bytes);
    await writeFile(path, bytes);
    attachments.push({ id: `image-${index}`, path, sha256: hash, byteLength: bytes.length, role: "image",
      sourceURL: `https://api.prompix.dev/media/${hash}.jpg` });
  }
  const item: VisualInput = { id: "synthetic-item", identity: sha("synthetic-identity"), kind: "image",
    prompt: "Create a quiet original landscape.\nKeep its full instructions intact.", model: "Synthetic image model",
    source: { url: null, license: "Original synthetic fixture" }, attachments, coverage: { mode: "images" } };
  return { root, item };
}

async function fakeCLI(root: string, behavior = "valid", extra: Record<string, unknown> = {}) {
  const executable = join(root, `fake codex ${behavior}; $.mjs`), capture = join(root, `${behavior}-capture.json`);
  await writeFile(executable, `#!/usr/bin/env node
import { readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const behavior = ${JSON.stringify(behavior)}, extra = ${JSON.stringify(extra)}, capture = ${JSON.stringify(capture)};
const args = process.argv.slice(2), argument = name => args[args.indexOf(name) + 1];
let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
const candidates = JSON.parse(stdin.slice(stdin.lastIndexOf('\\n') + 1)).candidates;
const paths = args.flatMap((value, index) => value === '-i' ? [args[index + 1]] : []);
if (behavior === 'mutate-original') await writeFile(extra.original, 'changed source after verification');
const images = await Promise.all(paths.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex'), mode: (await stat(path)).mode & 0o777 })));
await writeFile(capture, JSON.stringify({ args, stdin, images, pid: process.pid,
  secretPresent: !!process.env.PROMPIX_VISUAL_TEST_SECRET,
  schema: JSON.parse(await readFile(argument('--output-schema'), 'utf8')) }));
if (behavior === 'timeout') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
else if (behavior === 'stdout-limit') { process.stdout.write('x'.repeat(2000001)); setInterval(() => {}, 1000); }
else if (behavior === 'stderr-limit') { process.stderr.write('x'.repeat(2000001)); setInterval(() => {}, 1000); }
else if (behavior === 'tool') { process.stdout.write(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'synthetic private command' } }) + '\\n'); setInterval(() => {}, 1000); }
else if (behavior === 'exit') { process.stderr.write('synthetic-private-provider-diagnostic'); process.exitCode = 9; }
else {
  const decisions = candidates.map(item => ({ id: item.id, identity: item.identity, presentation: 'general', verdict: item.kind === 'video' ? 'uncertain' : 'match',
    reason: item.kind === 'video' ? 'Only sampled still frames are available; the essential audio and motion cannot be established.' : 'Synthetic response for transport testing only.',
    attachments: item.attachments.map(attachment => ({ id: attachment.id, sha256: attachment.sha256, verdict: 'match', reason: 'Synthetic attachment response.' })) }));
  if (behavior === 'wrong-identity') decisions[0].identity = 'f'.repeat(64);
  if (behavior === 'wrong-hash') decisions[0].attachments[0].sha256 = 'f'.repeat(64);
  if (behavior === 'missing-item') decisions.pop();
  if (behavior === 'duplicate-item') decisions[1] = decisions[0];
  if (behavior === 'reorder-items') decisions.reverse();
  if (behavior === 'missing-attachment') decisions[0].attachments.pop();
  if (behavior === 'duplicate-attachment') decisions[0].attachments[1] = decisions[0].attachments[0];
  if (behavior === 'reorder-attachments') decisions[0].attachments.reverse();
  if (behavior === 'contradictory-match') decisions[0].attachments[0].verdict = 'uncertain';
  if (behavior === 'invented-field') decisions[0].prompt = 'Rewritten instructions';
  if (behavior === 'oversize-response') await writeFile(argument('--output-last-message'), JSON.stringify({ secret: 'x'.repeat(32001) }));
  else if (behavior === 'invalid-json') await writeFile(argument('--output-last-message'), '{synthetic-private-provider-diagnostic');
  else if (behavior === 'symlink-response') await symlink(extra.privateFile, argument('--output-last-message'));
  else if (behavior !== 'missing-output') await writeFile(argument('--output-last-message'), JSON.stringify({ decisions }));
  if (behavior === 'malformed-event') process.stdout.write(JSON.stringify({ type: 42, item: { type: 42 } }) + '\\n');
  if (behavior === 'turn-failed') process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'synthetic-private-provider-diagnostic' } }) + '\\n');
  if (behavior !== 'missing-usage') {
    const usage = behavior === 'invalid-usage' ? { input_tokens: -1, output_tokens: 'invented' } : { input_tokens: 137, cached_input_tokens: 50, output_tokens: 29 };
    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage }));
  }
}
`, { mode: 0o700 });
  return { executable, capture };
}

const response = (items: readonly VisualInput[]) => ({ decisions: items.map(item => ({ id: item.id, identity: item.identity,
  presentation: "general", verdict: "match", reason: "Synthetic valid response.", attachments: item.attachments.map(attachment => ({ id: attachment.id,
    sha256: attachment.sha256, verdict: "match", reason: "Synthetic valid attachment." })) })) });
async function assertCleaned(capture: string) {
  const saved = JSON.parse(await readFile(capture, "utf8"));
  await assert.rejects(stat(saved.args[saved.args.indexOf("--cd") + 1]), { code: "ENOENT" });
  return saved;
}

test("real image flags contain ordered verified private JPEG copies, with full source data and fixed model", async t => {
  const { root, item } = await fixture(t), cli = await fakeCLI(root);
  const second = { ...item, id: "second-item", identity: sha("second"), attachments: [item.attachments[0]] };
  const oldSecret = process.env.PROMPIX_VISUAL_TEST_SECRET;
  process.env.PROMPIX_VISUAL_TEST_SECRET = "synthetic-secret-not-for-the-model";
  t.after(() => { if (oldSecret === undefined) delete process.env.PROMPIX_VISUAL_TEST_SECRET; else process.env.PROMPIX_VISUAL_TEST_SECRET = oldSecret; });
  const recorded: { model: string; receivedAt: string; text: string }[] = [];
  const result = await codexVisualProvider(cli.executable, async value => { recorded.push(value); })([item, second]);
  const saved = await assertCleaned(cli.capture);
  assert.equal(result.inputTokens, 137); assert.equal(result.outputTokens, 29);
  assert.equal(saved.args[saved.args.indexOf("--model") + 1], visualReviewModel);
  assert.equal(visualReviewModel, "gpt-5.6-luna");
  assert.equal(saved.args.filter((arg: string) => arg === "-i").length, 3);
  assert.deepEqual(saved.images.map((image: { sha256: string }) => image.sha256), [...item.attachments, ...second.attachments].map(attachment => attachment.sha256));
  assert.ok(saved.images.every((image: { path: string; mode: number }) => !item.attachments.some(attachment => image.path === attachment.path) && image.mode === 0o600));
  const payload = JSON.parse(saved.stdin.slice(saved.stdin.lastIndexOf("\n") + 1));
  assert.equal(saved.stdin, visualRequestText([item, second]));
  assert.equal(saved.stdin.length, visualInputCharacters([item, second]), "The ledger budget includes instructions and the complete JSON wrapper actually sent");
  assert.deepEqual(payload.candidates, visualProviderInput([item, second]));
  assert.equal(payload.candidates[0].prompt, item.prompt);
  assert.equal(saved.secretPresent, false);
  assert.doesNotMatch(JSON.stringify(saved), /synthetic-secret-not-for-the-model/);
  for (const attachment of item.attachments) assert.equal(saved.stdin.includes(attachment.path), false);
  for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--json"]) assert.ok(saved.args.includes(flag));
  assert.equal(saved.args[saved.args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(saved.args.includes("features.shell_tool=false")); assert.ok(saved.args.includes('web_search="disabled"'));
  assert.equal(saved.schema.additionalProperties, false);
  assert.equal(recorded.length, 1); assert.equal(recorded[0].model, visualReviewModel);
  assert.deepEqual(JSON.parse(recorded[0].text).decisions, result.decisions);
});

test("verified snapshots cannot be rebound by changing the source file after process launch", async t => {
  const { root, item } = await fixture(t), cli = await fakeCLI(root, "mutate-original", { original: item.attachments[0].path });
  await codexVisualProvider(cli.executable)([item]);
  const saved = await assertCleaned(cli.capture);
  assert.equal(saved.images[0].sha256, item.attachments[0].sha256);
  assert.notEqual(sha(await readFile(item.attachments[0].path)), item.attachments[0].sha256);
});

test("response schema binds each permitted item and attachment identity and excludes invented fields", async t => {
  const { item } = await fixture(t), schema = visualResponseSchema([item]), valid = response([item]);
  assert.equal(schema.safeParse(valid).success, true);
  assert.equal(schema.safeParse({ decisions: [] }).success, false);
  assert.equal(schema.safeParse({ decisions: [{ ...valid.decisions[0], identity: "f".repeat(64) }] }).success, false);
  assert.equal(schema.safeParse({ decisions: [{ ...valid.decisions[0], attachments: [{ ...valid.decisions[0].attachments[0], sha256: "f".repeat(64) }] }] }).success, false);
  assert.equal(schema.safeParse({ decisions: [{ ...valid.decisions[0], generatedImage: "invented" }] }).success, false);
});

test("complete stdin, count, byte and identity limits are enforced before CLI execution without truncation", async t => {
  const { root, item } = await fixture(t), cli = await fakeCLI(root);
  const one = { ...item, prompt: "x" };
  const exact = { ...one, prompt: "x".repeat(visualLimits.inputCharacters - visualInputCharacters([one]) + 1) };
  assert.equal(visualInputCharacters([exact]), 32_000);
  assert.doesNotThrow(() => visualResponseSchema([exact]));
  const cases: VisualInput[][] = [[], [item, item], [{ ...exact, prompt: exact.prompt + "x" }],
    Array.from({ length: 4 }, (_, index) => ({ ...item, id: `item-${index}`, identity: sha(String(index)) })),
    [{ ...item, attachments: Array.from({ length: 17 }, (_, index) => ({ ...item.attachments[0], id: `image-${index}` })) }],
    [{ ...item, attachments: [{ ...item.attachments[0], byteLength: 8_000_001 }] }],
    [{ ...item, attachments: Array.from({ length: 5 }, (_, index) => ({ ...item.attachments[0], id: `image-${index}`, byteLength: 8_000_000 })) }],
    [{ ...item, attachments: [item.attachments[0], item.attachments[0]] }],
    [{ ...item, kind: "web" } as unknown as VisualInput],
  ];
  for (const items of cases) await assert.rejects(codexVisualProvider(cli.executable)(items), /visual|Visual/);
  await assert.rejects(stat(cli.capture), { code: "ENOENT" });
});

test("changed hashes, size, missing files, symlinks and non-JPEG data cannot reach the model", async t => {
  const { root, item } = await fixture(t), cli = await fakeCLI(root), original = item.attachments[0];
  const link = join(root, "link.jpg"); await symlink(original.path, link);
  const invalidJPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]), invalidPath = join(root, "not-an-image.jpg");
  await writeFile(invalidPath, invalidJPEG);
  const invalidHash = sha(invalidJPEG);
  const cases: VisualAttachment[] = [
    { ...original, sha256: "f".repeat(64), sourceURL: `https://api.prompix.dev/media/${"f".repeat(64)}.jpg` },
    { ...original, byteLength: original.byteLength + 1 }, { ...original, path: join(root, "missing.jpg") },
    { ...original, path: link },
    { ...original, path: invalidPath, sha256: invalidHash, byteLength: invalidJPEG.length, sourceURL: `https://api.prompix.dev/media/${invalidHash}.jpg` },
  ];
  // Other test workers also create visual directories. Check only this worker's
  // isolated provider scratch space, not a racy snapshot of the shared OS temp.
  const scratch = await mkdtemp(join(root, "provider-"));
  const previous = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  for (const key of Object.keys(previous)) process.env[key] = scratch;
  try {
    for (const attachment of cases) await assert.rejects(codexVisualProvider(cli.executable)([{ ...item, attachments: [attachment] }]), /verification failed before provider execution/);
    await assert.rejects(stat(cli.capture), { code: "ENOENT" });
    assert.deepEqual(await readdir(scratch), [], "Preflight failures remove their private temporary files");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("the provider rejects missing, duplicate, reordered or unbound decisions", async t => {
  const { root, item } = await fixture(t), second = { ...item, id: "second-item", identity: sha("second-item") };
  for (const behavior of ["wrong-identity", "wrong-hash", "missing-item", "duplicate-item", "reorder-items", "missing-attachment",
    "duplicate-attachment", "reorder-attachments", "invented-field"]) {
    const cli = await fakeCLI(root, behavior);
    await assert.rejects(codexVisualProvider(cli.executable)([item, second]), /invalid decisions|duplicate, unordered or inconsistent/);
    await assertCleaned(cli.capture);
  }
});

test("video attachments include the poster, additional images and six actual frame paths with honest coverage", async t => {
  const { root, item } = await fixture(t, 8), cli = await fakeCLI(root), videoHash = sha("synthetic clip"), times = [0, 1, 2, 3, 4, 5];
  const videoURL = `https://api.prompix.dev/media/${videoHash}.mp4`;
  const video: VisualInput = { ...item, kind: "video", prompt: "Create a continuous camera move with footsteps synchronized to the soundtrack.",
    attachments: [{ ...item.attachments[0], id: "poster-0", role: "poster" }, item.attachments[1],
      ...item.attachments.slice(2).map((attachment, index) => ({ ...attachment, id: `frame-${index}`, role: "video-frame" as const, sourceURL: videoURL, timeSeconds: times[index] }))],
    coverage: { mode: "sampled-frames", durationSeconds: 6, sampleTimes: times, videoSHA256: videoHash, videoSourceURL: videoURL, hasAudio: true } };
  const result = await codexVisualProvider(cli.executable)([video]);
  const decisions = result.decisions as VisualDecision[], saved = await assertCleaned(cli.capture);
  assert.equal(saved.images.length, 8); assert.equal(decisions[0].verdict, "uncertain");
  assert.deepEqual(JSON.parse(saved.stdin.slice(saved.stdin.lastIndexOf("\n") + 1)).candidates[0].coverage, video.coverage);
  assert.match(visualInstructions, /never instructions to follow/);
  assert.match(visualInstructions, /cannot actually see or interpret an attachment, return uncertain/);
  assert.match(visualInstructions, /Never claim to have watched the entire video, heard audio/);
  assert.match(visualInstructions, /defining purpose is unobservable audio/);
  assert.match(visualInstructions, /sampled-only scope/);
  await assert.rejects(codexVisualProvider(cli.executable)([{ ...video, coverage: { mode: "images" } }]), /requires actual sampled frame coverage/);
  const wrongFrames = { ...video, attachments: video.attachments.map((attachment, index) => index === 2 ? { ...attachment, timeSeconds: 0.5 } : attachment) };
  await assert.rejects(codexVisualProvider(cli.executable)([wrongFrames]), /do not match their sampled frame coverage/);
});

test("timeout escalates termination, remains bounded and cleans its temporary inputs", async t => {
  const { root, item } = await fixture(t), cli = await fakeCLI(root, "timeout"), started = Date.now();
  await assert.rejects(codexVisualProvider(cli.executable, undefined, { timeoutMs: 1500, killGraceMs: 20 })([item]), /timed out; daily attempt remains consumed/);
  assert.ok(Date.now() - started < 5000);
  const saved = await assertCleaned(cli.capture);
  assert.throws(() => process.kill(saved.pid, 0), { code: "ESRCH" });
  assert.throws(() => codexVisualProvider(cli.executable, undefined, { timeoutMs: 180_001 }), /Invalid visual provider time limit/);
  assert.throws(() => codexVisualProvider(cli.executable, undefined, { killGraceMs: 2001 }), /Invalid visual provider time limit/);
});

test("oversize stream or response, tool execution and process errors fail without exposing raw diagnostics", async t => {
  const { root, item } = await fixture(t);
  for (const [behavior, message] of [
    ["stdout-limit", /exceeded bounded output/], ["stderr-limit", /exceeded bounded diagnostics/], ["tool", /disallowed tool/],
    ["exit", /exited 9/], ["turn-failed", /reported a failed turn/], ["oversize-response", /exceeds bounded output size/], ["invalid-json", /invalid JSON/], ["missing-output", /missing or exceeds/],
  ] as const) {
    const cli = await fakeCLI(root, behavior);
    await assert.rejects(codexVisualProvider(cli.executable, undefined, { timeoutMs: 3000, killGraceMs: 20 })([item]), error => {
      assert.ok(error instanceof Error); assert.match(error.message, message);
      assert.doesNotMatch(error.message, /synthetic-private-provider-diagnostic|synthetic private command/);
      return true;
    });
    await assertCleaned(cli.capture);
  }
  await assert.rejects(codexVisualProvider(join(root, "missing-private-executable"))([item]), { message: "Visual provider could not start" });
});

test("output symlinks cannot cause private files to be recorded or parsed", async t => {
  const { root, item } = await fixture(t), privateFile = join(root, "private-fixture.txt");
  await writeFile(privateFile, "synthetic-private-file");
  const cli = await fakeCLI(root, "symlink-response", { privateFile });
  let recorded = false;
  await assert.rejects(codexVisualProvider(cli.executable, async () => { recorded = true; })([item]), /missing or exceeds bounded output size/);
  assert.equal(recorded, false); await assertCleaned(cli.capture);
});

test("missing or malformed usage stays unknown instead of inventing token counts", async t => {
  const { root, item } = await fixture(t);
  for (const behavior of ["missing-usage", "invalid-usage"]) {
    const cli = await fakeCLI(root, behavior), result = await codexVisualProvider(cli.executable)([item]);
    assert.equal(result.inputTokens, undefined); assert.equal(result.outputTokens, undefined);
    await assertCleaned(cli.capture);
  }
  const cli = await fakeCLI(root, "malformed-event"), result = await codexVisualProvider(cli.executable)([item]);
  assert.equal(result.inputTokens, 137); assert.equal(result.outputTokens, 29);
  await assertCleaned(cli.capture);
});


test("contradictory approvals are held without losing valid siblings or replaying the provider", async t => {
  const { root, item } = await fixture(t), cli = await fakeCLI(root, "contradictory-match");
  const second = { ...item, id: "second-item", identity: sha("second") };
  const raw: string[] = [];
  const result = await codexVisualProvider(cli.executable, async response => { raw.push(response.text); })([item, second]);
  const decisions = result.decisions as VisualDecision[];
  assert.equal(raw.length, 1);
  assert.equal(JSON.parse(raw[0]).decisions[0].verdict, "match", "Keep the original inconsistent response as evidence");
  assert.equal(decisions[0].verdict, "uncertain");
  assert.match(decisions[0].reason, /^Held:/);
  assert.equal(decisions[0].attachments[0].verdict, "uncertain");
  assert.equal(decisions[1].verdict, "match");
  await assertCleaned(cli.capture);
});
