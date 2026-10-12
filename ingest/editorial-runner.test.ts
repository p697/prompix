import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyEditorialReviews, type Reviews } from "./editorial.ts";
import { fingerprint, type Candidate } from "./sources.ts";
import { parseSkill, skillSources } from "./skills.ts";
import { prepareDailyEditorial } from "./editorial-daily.ts";
import { editorialResponseSchema } from "./editorial-provider.ts";
import { automaticReviewEligibility, editorialDecisionKey, editorialQueue, runEditorialReview,
  type EditorialCache, type EditorialInput, type EditorialLedger, type EditorialProvider } from "./editorial-runner.ts";
import { editorialInput, editorialLedgerSchema, type EditorialAttempt } from "./editorial-runner.ts";

const revision = "a".repeat(40), day = "2026-10-12";
function candidate(id: string, body = `Write a practical three-step weekend plan for ${id}. Ask for the available time and location, then suggest a clear route and alternatives for rain.`): Candidate {
  return { id, kind: "text", title: `Weekend ${id}`, summary: "A synthetic weekend-planning fixture.", prompt: body,
    example: "An original test fixture.", tags: ["Planning"], model: "General text model", toolURL: null, artwork: "test",
    previewLabel: "Test", source: { name: "prompts.chat", license: "CC0-1.0", method: "Synthetic test fixture",
      url: `https://github.com/f/prompts.chat/blob/${revision}/prompts.csv`, revision }, media: null,
    fingerprint: fingerprint(body), featured: false, reviewStatus: "draft" };
}
const metadata = { title: "安排一次轻松的周末出行", summary: "根据时间和地点，整理可执行的周末路线。",
  example: "使用建议：先填写出发地点和可用时间，再复制到对话工具，并根据当地情况调整路线。",
  tags: ["日常有用", "出行计划"], previewLabel: "提示词主题" as const, cover: null };
const approve = (items: EditorialInput[]) => ({ decisions: items.map(item => ({ id: item.id, fingerprint: item.fingerprint,
  outputKind: item.contentType === "skill" ? "skill" : item.kind, decision: "approve", reason: "Complete useful instructions", metadata: { ...metadata, previewLabel: item.requiredPreviewLabel } })) });
function harness(candidates: Candidate[], provider: EditorialProvider, initialLedger?: EditorialLedger | EditorialAttempt) {
  const state: { cache: EditorialCache; reviews: Reviews; ledger?: EditorialLedger; events: string[] } = {
    cache: { version: 1, decisions: {} }, reviews: {}, events: [],
    ...(initialLedger ? { ledger: editorialLedgerSchema.parse(initialLedger) } : {}),
  };
  const run = (currentDay = day, items = candidates, maxRequests: number | undefined = 1) => runEditorialReview({ candidates: items, previous: [],
    reviews: state.reviews, cache: state.cache, ledger: state.ledger, maxRequests, day: currentDay, now: `${currentDay}T00:00:00Z`,
    provider: async input => { state.events.push("provider"); return provider(input); },
    persistCache: async value => { state.cache = structuredClone(value); state.events.push("cache"); },
    persistReviews: async value => { state.reviews = structuredClone(value); state.events.push("reviews"); },
    persistLedger: async value => { state.ledger = structuredClone(value); state.events.push(value.attempts.at(-1)!.state); },
  });
  return { state, run };
}

test("daily review reserves before its only request, approves at most three records, and preserves protected source data", async () => {
  const items = Array.from({ length: 5 }, (_, index) => candidate(`item-${index}`));
  const original = structuredClone(items);
  const { state, run } = harness(items, async input => ({ ...approve(input), inputTokens: 500, outputTokens: 250 }));
  const result = await run();
  assert.equal(result.report.requests, 1); assert.equal(result.report.approved, 3);
  assert.equal(result.report.attemptedCandidates, 3);
  assert.deepEqual(state.events.slice(0, 2), ["reserved", "provider"]);
  assert.equal(state.ledger?.attempts[0]?.inputTokens, 500);
  assert.equal(Object.keys(state.reviews).length, 3);
  for (const item of applyEditorialReviews(items, state.reviews).filter(item => item.reviewStatus === "candidate")) {
    const raw = original.find(value => value.id === item.id)!;
    assert.equal(item.prompt, raw.prompt); assert.deepEqual(item.source, raw.source);
    assert.equal(item.creator, raw.creator); assert.equal(item.toolURL, raw.toolURL); assert.deepEqual(item.media, raw.media);
    assert.match(item.example, /^使用建议：/);
  }
  assert.deepEqual(items, original);
  const second = await run();
  assert.equal(second.report.status, "daily-limit"); assert.equal(second.report.requests, 0);
  assert.equal(state.events.filter(value => value === "provider").length, 1);
});

test("rejections and deferred decisions are cached by exact identity/fingerprint, but changed text is eligible", async () => {
  const items = [candidate("reject"), candidate("defer")];
  const { state, run } = harness(items, async input => ({ decisions: input.map(item => ({ id: item.id, fingerprint: item.fingerprint,
    outputKind: "unknown", decision: item.id, reason: "Source is a teaser or needs editorial judgment", metadata: null })) }));
  const first = await run();
  assert.equal(first.report.rejected, 1); assert.equal(first.report.deferred, 1);
  assert.equal(Object.keys(state.reviews).length, 0);
  const second = await run("2026-10-13");
  assert.equal(second.report.requests, 0); assert.equal(second.report.cachedDecisions, 2);
  const changed = candidate("reject", items[0].prompt + " Ask for a preferred transport mode too.");
  const third = await run("2026-10-14", [changed, items[1]]);
  assert.equal(third.report.requests, 1); assert.equal(third.report.attemptedCandidates, 1);
  assert.ok(state.cache.decisions[editorialDecisionKey(changed)]);
});

test("empty, missing, duplicate, mismatched and protected-field outputs fail the whole batch without review approvals", async () => {
  const items = [candidate("one"), candidate("two")];
  const variants = [
    (input: EditorialInput[]) => [],
    (input: EditorialInput[]) => approve(input).decisions.slice(0, 1),
    (input: EditorialInput[]) => [approve(input).decisions[0], approve(input).decisions[0]],
    (input: EditorialInput[]) => approve(input).decisions.map(item => ({ ...item, fingerprint: "f".repeat(64) })),
    (input: EditorialInput[]) => approve(input).decisions.map(item => ({ ...item, metadata: { ...item.metadata, imageURL: "https://invented.example/image.jpg" } })),
    (input: EditorialInput[]) => approve(input).decisions.map(item => ({ ...item, prompt: "Rewritten source instructions" })),
    (input: EditorialInput[]) => approve(input).decisions.map(item => ({ ...item, metadata: { ...item.metadata, example: "I tested this and it works perfectly." } })),
  ];
  for (const variant of variants) {
    const { state, run } = harness(items, async input => ({ decisions: variant(input) }));
    const result = await run();
    assert.equal(result.report.status, "failed"); assert.equal(result.report.approved, 0);
    assert.equal(Object.keys(state.reviews).length, 0); assert.equal(Object.keys(state.cache.decisions).length, 0);
    assert.equal(state.ledger?.attempts.at(-1)?.state, "failed");
    assert.equal((await run()).report.requests, 0, "An invalid response must not trigger a second paid attempt");
  }
});

test("provider response schema fixes exact ID/fingerprint pairs and decision count for each request", () => {
  const items = [candidate("one"), candidate("two")].map(editorialInput);
  const schema = editorialResponseSchema(items), valid = approve(items);
  assert.equal(schema.safeParse(valid).success, true);
  assert.equal(schema.safeParse({ decisions: valid.decisions.slice(0, 1) }).success, false);
  assert.equal(schema.safeParse({ decisions: valid.decisions.map(value => ({ ...value, fingerprint: "f".repeat(64) })) }).success, false);
  assert.equal(schema.safeParse({ decisions: valid.decisions.map(value => ({ ...value, id: "invented-id" })) }).success, false);
  assert.equal(schema.safeParse({ decisions: [{ ...valid.decisions[0], fingerprint: items[1].fingerprint }, valid.decisions[1]] }).success, false);
  assert.throws(() => editorialResponseSchema([items[0], items[0]]), /Invalid bounded/);
});

test("provider failure consumes the day and only a later UTC day can retry", async () => {
  let calls = 0;
  const { state, run } = harness([candidate("one")], async input => { if (++calls === 1) throw new Error("Ambiguous provider timeout"); return approve(input); });
  assert.equal((await run()).report.status, "failed");
  assert.equal(state.ledger?.requests, 1);
  assert.equal((await run()).report.requests, 0); assert.equal(calls, 1);
  assert.equal((await run("2026-10-13")).report.approved, 1); assert.equal(calls, 2);
});

test("allowlist, license, source fingerprint and missing real webpage evidence defer without provider calls", async () => {
  const base = candidate("one");
  const items = [
    { ...base, id: "x-post", source: { ...base.source, name: "X", license: "Unknown", url: "https://x.com/test/status/1" } },
    { ...base, id: "changed-license", source: { ...base.source, license: "All rights reserved" } },
    { ...base, id: "changed-text", prompt: base.prompt + " Changed text." },
    { ...base, id: "web-without-preview", kind: "web" as const },
  ];
  let calls = 0;
  const { state, run } = harness(items, async input => { calls++; return approve(input); });
  const result = await run();
  assert.equal(result.report.preflightDeferred, 4); assert.equal(result.report.requests, 0); assert.equal(calls, 0);
  assert.equal(Object.keys(state.cache.decisions).length, 4); assert.equal(state.ledger, undefined);
});

test("full source input is never truncated to fit the character budget", async () => {
  const items = [candidate("a", "A useful complete instruction. " + "x".repeat(7900)), candidate("b", "A second complete instruction. " + "y".repeat(5900)),
    candidate("c", "A third complete instruction. " + "z".repeat(2900)), candidate("too-large", "Copy every step. " + "q".repeat(36000))];
  let sent: EditorialInput[] = [];
  const { run } = harness(items, async input => { sent = input; return approve(input); });
  const result = await run();
  assert.equal(result.report.requests, 1); assert.equal(result.report.preflightDeferred, 1);
  assert.ok(sent.length <= 3); assert.ok(JSON.stringify(sent).length <= 36000);
  for (const input of sent) assert.equal(input.prompt, items.find(item => item.id === input.id)?.prompt);
  assert.match(automaticReviewEligibility(items[3])!, /Complete source exceeds/);
});

test("published edits lead the queue and source/modality rotation changes the first new shelf", () => {
  const text = candidate("new-text"), image = { ...candidate("new-image"), kind: "image" as const }, video = { ...candidate("new-video"), kind: "video" as const };
  const edited = candidate("published-edit");
  const first = editorialQueue([text, image, video, edited], [edited]);
  const rotated = editorialQueue([text, image, video, edited], [edited], 1);
  assert.equal(first[0].id, edited.id); assert.equal(rotated[0].id, edited.id);
  assert.notEqual(first[1].id, rotated[1].id);
  assert.equal(new Set(first.map(item => item.kind)).size, 3);
});

test("failed durable reservation makes no request and failed approval persistence leaves input state untouched", async () => {
  const item = candidate("one"), cache: EditorialCache = { version: 1, decisions: {} };
  let calls = 0;
  const options = { candidates: [item], previous: [], reviews: {}, cache, day,
    provider: async (input: EditorialInput[]) => { calls++; return approve(input); },
    persistCache: async () => {}, persistReviews: async () => {}, persistLedger: async () => { throw new Error("Storage failure"); } };
  await assert.rejects(runEditorialReview(options), /Storage failure/); assert.equal(calls, 0);
  let ledger: EditorialLedger | undefined;
  const result = await runEditorialReview({ ...options, persistLedger: async value => { ledger = structuredClone(value); },
    persistReviews: async () => { throw new Error("Review storage failure"); } });
  assert.equal(result.report.status, "failed"); assert.equal(calls, 1); assert.equal(ledger?.attempts.at(-1)?.state, "failed");
  assert.deepEqual(result.reviews, {}); assert.deepEqual(cache.decisions, {});
});

test("ordinary staging cannot invoke a configured provider or create a request ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-editorial-dry-run-"));
  try {
    const result = await prepareDailyEditorial([candidate("one")], {}, [], root, false,
      { PROMPIX_EDITORIAL_PROVIDER: "codex", PROMPIX_CODEX: "/missing-executable-must-not-run" });
    assert.equal(result.report.status, "disabled"); assert.equal(result.report.requests, 0);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("manual review command includes official Skill candidate snapshots and releases its content lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-skill-review-"));
  try {
    const source = skillSources[0];
    const skill = parseSkill("---\nname: test-example\ndescription: Original synthetic test instructions.\n---\n# Example\nWrite three concrete steps to plan an original page layout.",
      "Apache License\nVersion 2.0, January 2004\nEND OF TERMS AND CONDITIONS", source, revision);
    await mkdir(join(root, "candidates"));
    await writeFile(join(root, "candidates", `skill-${source.id}.json`), JSON.stringify([skill]));
    const metadataPath = join(root, "metadata.json");
    const { cover: _, ...fields } = metadata;
    await writeFile(metadataPath, JSON.stringify({ ...fields, previewLabel: "Skill 使用说明" }));
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "ingest/review.ts", skill.id, metadataPath],
      { cwd: process.cwd(), env: { ...process.env, PROMPIX_CONTENT_DIR: root }, timeout: 10000 });
    assert.equal(JSON.parse(result.stdout).reviewed, skill.id);
    const reviews = JSON.parse(await readFile(join(root, "editorial.json"), "utf8"));
    assert.equal(reviews[skill.id].fingerprint, skill.fingerprint);
    assert.equal((await readdir(root)).includes("daily.lock"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("one invocation processes four bounded batches by default, then rotates budget on the next UTC day", async () => {
  const items = Array.from({ length: 15 }, (_, index) => candidate(`batch-${String(index).padStart(2, "0")}`));
  const batches: string[][] = [];
  const { state, run } = harness(items, async input => approve(input));
  // Call the runner without maxRequests to exercise the real default.
  const result = await runEditorialReview({ candidates: items, previous: [], reviews: state.reviews, cache: state.cache, day,
    provider: async input => {
      assert.ok(input.length <= 3); assert.ok(JSON.stringify(input).length <= 36000);
      assert.equal(state.ledger?.attempts.at(-1)?.state, "reserved");
      assert.equal(state.ledger?.requests, batches.length + 1);
      batches.push(input.map(item => item.id));
      return { ...approve(input), inputTokens: 100, outputTokens: 50 };
    }, persistCache: async value => { state.cache = structuredClone(value); },
    persistReviews: async value => { state.reviews = structuredClone(value); },
    persistLedger: async value => { state.ledger = structuredClone(value); } });
  assert.equal(result.report.requests, 4); assert.equal(result.report.dailyRequests, 4); assert.equal(result.report.maxRequests, 4);
  assert.equal(result.report.approved, 12); assert.equal(result.report.attemptedCandidates, 12);
  assert.equal(new Set(batches.flat()).size, 12);
  assert.deepEqual(state.ledger?.attempts.map(attempt => attempt.state), Array(4).fill("completed"));
  assert.equal(state.ledger?.attempts.reduce((total, attempt) => total + (attempt.inputTokens ?? 0), 0), 400);
  assert.equal((await run(day, items, 4)).report.requests, 0);
  const next = await run("2026-10-13", items, 4);
  assert.equal(next.report.requests, 1); assert.equal(next.report.dailyRequests, 1); assert.equal(next.report.approved, 3);
  assert.equal(Object.keys(state.reviews).length, 15);
});

test("completed same-day batches leave only unspent slots for newly available candidates", async () => {
  const items = Array.from({ length: 12 }, (_, index) => candidate(`resume-${index}`));
  const seen: string[] = [];
  const { state, run } = harness(items, async input => { seen.push(...input.map(item => item.id)); return approve(input); });
  assert.equal((await run(day, items.slice(0, 3), 4)).report.dailyRequests, 1);
  const resumed = await run(day, items, 3);
  assert.equal(resumed.report.requests, 2); assert.equal(resumed.report.dailyRequests, 3);
  assert.equal((await run(day, items, 2)).report.requests, 0, "A lower configured cap never resets spent requests");
  assert.equal((await run(day, items, 4)).report.requests, 1);
  assert.equal(new Set(seen).size, 12); assert.equal(seen.length, 12);
  assert.equal(state.ledger?.requests, 4);
});

function legacyAttempt(state: EditorialAttempt["state"] = "completed"): EditorialAttempt {
  return { day, requests: 1, model: "gpt-5.6-luna", reservedAt: `${day}T00:00:00Z`, candidateIDs: ["legacy"], inputCharacters: 100,
    state, inputTokens: 150, outputTokens: 25 };
}

test("legacy completed ledgers preserve their spent request and evidence when migrated", async () => {
  const legacy = legacyAttempt();
  const items = [candidate("legacy"), ...Array.from({ length: 12 }, (_, index) => candidate(`new-${index}`))];
  const seen: string[] = [];
  const { state, run } = harness(items, async input => { seen.push(...input.map(item => item.id)); return approve(input); }, legacy);
  const result = await run(day, items, 4);
  assert.equal(result.report.requests, 3); assert.equal(result.report.dailyRequests, 4);
  assert.equal(seen.length, 9); assert.equal(seen.includes("legacy"), false, "Missing old cache cannot repay today's old candidate");
  assert.deepEqual(state.ledger?.attempts[0], legacy);
  assert.equal(state.ledger?.schemaVersion, 2);
});

test("legacy interrupted and failed ledgers remain blocked until the next UTC day", async () => {
  for (const status of ["reserved", "failed"] as const) {
    let calls = 0;
    const { run } = harness([candidate("legacy")], async input => { calls++; return approve(input); }, legacyAttempt(status));
    const blocked = await run(day, undefined, 20);
    assert.equal(blocked.report.status, "daily-limit"); assert.equal(blocked.report.dailyRequests, 1); assert.equal(calls, 0);
    assert.equal((await run("2026-10-13", undefined, 4)).report.requests, 1); assert.equal(calls, 1);
  }
});

test("failure in a later batch preserves earlier approvals and blocks all remaining same-day slots", async () => {
  const items = Array.from({ length: 10 }, (_, index) => candidate(`partial-${index}`));
  let calls = 0;
  const { state, run } = harness(items, async input => { if (++calls === 2) throw new Error("Ambiguous response after billing"); return approve(input); });
  const result = await run(day, items, 4);
  assert.equal(result.report.status, "failed"); assert.equal(result.report.requests, 2); assert.equal(result.report.dailyRequests, 2);
  assert.equal(result.report.approved, 3); assert.equal(Object.keys(result.reviews).length, 3);
  assert.equal(Object.keys(state.cache.decisions).length, 3);
  assert.deepEqual(state.ledger?.attempts.map(attempt => attempt.state), ["completed", "failed"]);
  assert.equal((await run(day, items, 20)).report.requests, 0); assert.equal(calls, 2);
  assert.equal((await run("2026-10-13", items, 4)).report.approved, 7);
});

test("interruption after a later reservation retains the entire journal and cannot trigger another provider call", async () => {
  const items = Array.from({ length: 8 }, (_, index) => candidate(`interrupted-${index}`));
  let saved: EditorialLedger | undefined, calls = 0;
  const options = { candidates: items, previous: [], reviews: {}, cache: { version: 1 as const, decisions: {} }, day,
    provider: async (input: EditorialInput[]) => { calls++; return approve(input); },
    persistCache: async () => {}, persistReviews: async () => {},
    persistLedger: async (ledger: EditorialLedger) => { saved = structuredClone(ledger);
      if (ledger.requests === 2) throw new Error("Process interrupted after reservation write"); } };
  await assert.rejects(runEditorialReview(options), /Process interrupted/);
  assert.equal(calls, 1); assert.deepEqual(saved?.attempts.map(attempt => attempt.state), ["completed", "reserved"]);
  const resumed = await runEditorialReview({ ...options, ledger: saved, persistLedger: async () => {} });
  assert.equal(resumed.report.requests, 0); assert.equal(resumed.report.dailyRequests, 2); assert.equal(calls, 1);
});

test("zero limit disables new requests and invalid daily limits or journals fail before calling", async () => {
  let calls = 0;
  const options = { candidates: [candidate("one")], previous: [], reviews: {}, cache: { version: 1 as const, decisions: {} }, day,
    provider: async (input: EditorialInput[]) => { calls++; return approve(input); },
    persistCache: async () => {}, persistReviews: async () => {}, persistLedger: async () => {} };
  assert.equal((await runEditorialReview({ ...options, maxRequests: 0 })).report.status, "daily-limit");
  for (const maxRequests of [-1, 1.5, 41, NaN]) await assert.rejects(runEditorialReview({ ...options, maxRequests }), /request limit/);
  const corrupt = { schemaVersion: 2, day, requests: 1, attempts: [legacyAttempt(), legacyAttempt("reserved")] } as EditorialLedger;
  await assert.rejects(runEditorialReview({ ...options, ledger: corrupt }));
  assert.equal(calls, 0);
});


test("daily wrapper migrates one spent request, archives each new response separately, and honors configured limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-editorial-batches-"));
  try {
    const today = new Date().toISOString().slice(0, 10), directory = join(root, "editorial");
    const ledgerPath = join(directory, "daily-attempts", `${today}.json`);
    await mkdir(join(directory, "daily-attempts"), { recursive: true });
    const legacy = { ...legacyAttempt(), day: today, reservedAt: `${today}T00:00:00Z` };
    await writeFile(ledgerPath, JSON.stringify(legacy));
    await mkdir(join(directory, "responses"));
    await writeFile(join(directory, "responses", `${today}.json`), "legacy audit evidence\n");
    const executable = join(root, "synthetic-editorial-provider.cjs");
    // This local executable implements the CLI wire format without running a model or network.
    await writeFile(executable, `#!${process.execPath}
const fs = require("node:fs");
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const { candidates } = JSON.parse(input.trim().split("\\n").at(-1));
  const ledger = JSON.parse(fs.readFileSync(${JSON.stringify(ledgerPath)}, "utf8"));
  if (ledger.attempts.at(-1).state !== "reserved") process.exit(2);
  const decisions = candidates.map(item => ({ id: item.id, fingerprint: item.fingerprint, outputKind: item.contentType === "skill" ? "skill" : item.kind, decision: "approve", reason: "Synthetic complete source", metadata: { ...${JSON.stringify(metadata)}, previewLabel: item.requiredPreviewLabel } }));
  fs.writeFileSync(process.argv[process.argv.indexOf("--output-last-message") + 1], JSON.stringify({ decisions }));
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 50 } }) + "\\n");
});
`);
    await chmod(executable, 0o700);
    const environment = { PROMPIX_EDITORIAL_PROVIDER: "codex", PROMPIX_CODEX: executable, PROMPIX_EDITORIAL_MAX_REQUESTS: "3" };
    const items = Array.from({ length: 12 }, (_, index) => candidate(`wrapper-${index}`));
    const first = await prepareDailyEditorial(items, {}, [], root, true, environment);
    assert.equal(first.report.status, "reviewed"); assert.equal(first.report.requests, 2); assert.equal(first.report.dailyRequests, 3);
    const ledger = editorialLedgerSchema.parse(JSON.parse(await readFile(ledgerPath, "utf8")));
    assert.deepEqual(ledger.attempts[0], legacy);
    assert.deepEqual(await readdir(join(directory, "responses")), [`${today}-002.json`, `${today}-003.json`, `${today}.json`].sort());
    assert.equal(await readFile(join(directory, "responses", `${today}.json`), "utf8"), "legacy audit evidence\n");
    const second = await prepareDailyEditorial(items, first.reviews, [], root, true, environment);
    assert.equal(second.report.requests, 0); assert.equal(second.report.dailyRequests, 3);
    const next = await prepareDailyEditorial(items, first.reviews, [], root, true,
      { ...environment, PROMPIX_EDITORIAL_MAX_REQUESTS: "4" });
    assert.equal(next.report.requests, 1); assert.equal(next.report.dailyRequests, 4);
    assert.ok((await readdir(join(directory, "responses"))).includes(`${today}-004.json`));
    for (const invalid of ["", "2.5", "41", "-1", "Infinity", " 4 "]) await assert.rejects(
      prepareDailyEditorial(items, {}, [], root, true, { ...environment, PROMPIX_EDITORIAL_MAX_REQUESTS: invalid }), /request limit/);
    let clockReads = 0;
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000);
    const rollover = await prepareDailyEditorial([...items, ...Array.from({ length: 6 }, (_, index) => candidate(`rollover-${index}`))],
      next.reviews, [], root, true, { ...environment, PROMPIX_EDITORIAL_MAX_REQUESTS: "6" },
      () => ++clockReads <= 2 ? new Date(`${today}T23:59:59Z`) : tomorrow);
    assert.equal(rollover.report.status, "failed"); assert.match(rollover.report.error!, /UTC editorial review day changed/);
    assert.equal(rollover.report.approved, 3); assert.equal(rollover.report.dailyRequests, 6);
    const responses = await readdir(join(directory, "responses"));
    assert.ok(responses.includes(`${today}-005.json`)); assert.equal(responses.includes(`${today}-006.json`), false);
    const stopped = editorialLedgerSchema.parse(JSON.parse(await readFile(ledgerPath, "utf8")));
    assert.deepEqual(stopped.attempts.slice(-2).map(attempt => attempt.state), ["completed", "failed"]);
    await writeFile(ledgerPath, JSON.stringify({ ...legacy, day: "2026-01-01" }));
    await assert.rejects(prepareDailyEditorial(items, {}, [], root, true, environment), /ledger date does not match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mismatched output modalities are deferred independently without approving misleading text cards", async () => {
  const items = [candidate("scene", "A photorealistic portrait in soft window light, vertical frame, natural skin and shallow depth of field."),
    candidate("script", "Write a two-minute video script for a fictional photography tutorial."), candidate("uncertain")];
  const original = structuredClone(items);
  const { state, run } = harness(items, async input => ({ decisions: approve(input).decisions.map(decision => ({ ...decision,
    outputKind: decision.id === "scene" ? "image" : decision.id === "uncertain" ? "unknown" : "text" })) }));
  const result = await run();
  assert.equal(result.report.status, "reviewed");
  assert.equal(result.report.approved, 1); assert.equal(result.report.deferred, 2);
  assert.deepEqual(Object.keys(state.reviews), ["script"]);
  assert.equal(state.cache.decisions[editorialDecisionKey(items[0])].metadata, null);
  assert.equal(state.cache.decisions[editorialDecisionKey(items[0])].outputKind, "image");
  assert.match(state.cache.decisions[editorialDecisionKey(items[0])].reason, /does not match/);
  assert.equal(state.ledger?.attempts[0].state, "completed");
  assert.deepEqual(items, original);
});

test("live editorial responses must classify output even when their old cache remains readable", async () => {
  const items = [candidate("scene")];
  const { outputKind: _omitted, ...old } = approve(items.map(editorialInput)).decisions[0];
  assert.equal(editorialResponseSchema(items.map(editorialInput)).safeParse({ decisions: [old] }).success, false);
  const { editorialCacheSchema } = await import("./editorial-runner.ts");
  assert.equal(editorialCacheSchema.safeParse({ version: 1, decisions: {
    [editorialDecisionKey(items[0])]: { ...old, model: "gpt-5.6-luna", reviewedAt: day + "T00:00:00Z" },
  } }).success, true);
  const { run } = harness(items, async () => ({ decisions: [old] }));
  assert.equal((await run()).report.status, "failed");
});
