import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotHistoryEditorial } from "./history-editorial.ts";
import { atomic } from "./publication.ts";
import { parseCommunityCSV } from "./sources.ts";
import { runEditorialReview, editorialVersion } from "./editorial-runner.ts";
import { applyEditorialReviews } from "./editorial.ts";

test("a fully inherited approval survives a zero-request review and later shared changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "history-editorial-"));
  try {
    const directory = join(root, "batch"), shared = join(root, "shared");
    const [candidate] = parseCommunityCSV('act,prompt,type,contributor\n"Paper garden","Describe a tiny paper garden with three folded flowers and a quiet pond. Keep the description under 100 words.",TEXT,studio\n', "synthetic");
    const reviews = { [candidate.id]: { fingerprint: candidate.fingerprint, reviewedAt: "2026-10-18T00:00:00Z",
      metadata: { title: "Paper garden", summary: "Three folded flowers.", example: "Paper petals beside a pond.", tags: ["art"], previewLabel: "Editorial example" } } };
    await atomic(join(shared, "editorial.json"), reviews);
    const local = await snapshotHistoryEditorial(directory, shared);
    const forbidden = async () => { throw new Error("No provider or persistence callback should run"); };
    const result = await runEditorialReview({ candidates: [candidate], previous: [], reviews: local,
      cache: { version: editorialVersion, decisions: {} }, day: "2026-10-20", provider: forbidden,
      persistReviews: forbidden, persistCache: forbidden, persistLedger: forbidden });
    assert.equal(result.report.requests, 0);
    assert.equal(result.report.status, "no-pending");
    const before = await readFile(join(directory, "editorial.json"));
    assert.deepEqual(JSON.parse(before.toString()), result.reviews);
    assert.equal(applyEditorialReviews([candidate], result.reviews)[0].reviewStatus, "candidate");
    await atomic(join(shared, "editorial.json"), {});
    assert.deepEqual(await snapshotHistoryEditorial(directory, shared), local);
    assert.deepEqual(await readFile(join(directory, "editorial.json")), before);
    assert.equal(applyEditorialReviews([{ ...candidate, fingerprint: "a".repeat(64) }], local)[0].reviewStatus, "draft");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("empty local evidence is authoritative and malformed evidence cannot fall back to shared approvals", async () => {
  const root = await mkdtemp(join(tmpdir(), "history-editorial-invalid-"));
  try {
    const directory = join(root, "batch"), shared = join(root, "shared");
    assert.deepEqual(await snapshotHistoryEditorial(directory, shared), {});
    await atomic(join(shared, "editorial.json"), { malformed: true });
    assert.deepEqual(await snapshotHistoryEditorial(directory, shared), {});
    await atomic(join(directory, "editorial.json"), { malformed: true });
    await assert.rejects(snapshotHistoryEditorial(directory, shared));
    await rm(join(directory, "editorial.json"));
    await assert.rejects(snapshotHistoryEditorial(directory, shared));
    await assert.rejects(readFile(join(directory, "editorial.json")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
