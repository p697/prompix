import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clawHubSources, clawHubID, clawHubURL, parseClawHubSkill, inspectClawHubVersion, collectClawHubSkill,
  clawHubCandidateIdentity, ClawHubHTTPError, type ClawHubRead, type ClawHubSource } from "./clawhub.ts";
import { prepareClawHub, filterClawHubAvailability, readClawHubState, clawHubRetryTime, assertClawHubAvailability } from "./clawhub-daily.ts";
import { applyEditorialReviews, type Reviews } from "./editorial.ts";
import { automaticReviewEligibility, editorialCacheSchema, editorialDecisionKey, runEditorialReview, type EditorialCache } from "./editorial-runner.ts";
import { publicationText } from "./templates.ts";
import { atomic } from "./publication.ts";
import { promptSchema } from "../packages/schema/catalog.ts";

// Only synthetic data; real registry responses are never repository fixtures.
function fixture(source: ClawHubSource = clawHubSources[0]) {
  const bytes = Buffer.from(`---\nname: synthetic-skill\ndescription: Test-only instructions for arranging a fictional garden.\n---\n\nAsk for the garden size and available sunlight. Suggest three fictional flower arrangements.\n`);
  const detail = { skill: { slug: source.slug, displayName: "Synthetic Skill" }, latestVersion: { version: "1.0.0", license: null },
    owner: { handle: source.owner, userId: "synthetic-owner-id", displayName: "Test Author", image: "https://avatars.githubusercontent.com/u/123?v=4" }, moderation: null };
  const version = { skill: { slug: source.slug }, version: { version: "1.0.0", license: null,
    files: [{ path: "SKILL.md", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
      { path: "reference.md", size: 100, sha256: "b".repeat(64) }],
    security: { status: "clean", hasWarnings: true, hasScanResult: true, scanners: { example: { status: "clean", normalizedStatus: "clean" } } } } };
  const candidate = () => parseClawHubSkill(source, detail, version, bytes);
  return { source, bytes, detail, version, candidate };
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const reader = (calls: string[] = []): ClawHubRead => async url => {
  calls.push(url); const u = new URL(url);
  const source = clawHubSources.find(source => u.searchParams.get("ownerHandle") === source.owner && u.pathname.startsWith(`/api/v1/skills/${source.slug}`));
  assert.ok(source); const f = fixture(source);
  return u.pathname.endsWith("/file") ? f.bytes : u.pathname.includes("/versions/") ? encode(f.version) : encode(f.detail);
};
const metadata = { title: "Arrange a garden", summary: "A synthetic review", example: "使用建议：填写条件后使用。", tags: ["test"], previewLabel: "Skill 使用说明" as const };

test("registry reads preserve scoped owner, pinned version, exact bytes, complete inventory and null evidence", async () => {
  const calls: string[] = []; const result = await collectClawHubSkill(clawHubSources[0], reader(calls));
  assert.equal(calls.length, 3);
  for (const url of calls) assert.equal(new URL(url).searchParams.get("ownerHandle"), "steipete");
  assert.equal(new URL(calls[2]).searchParams.get("version"), "1.0.0");
  assert.equal(result.candidate.reviewStatus, "draft"); assert.equal(result.candidate.contentType, "skill");
  assert.deepEqual(result.candidate.skill?.files, ["SKILL.md", "reference.md"]);
  assert.equal(result.evidence.explicitLicense, null); assert.equal(result.evidence.detail.moderation, null);
  assert.equal(result.evidence.hasWarnings, true); assert.match(result.candidate.source.revision!, /^1\.0\.0:[a-f0-9]{64}$/);
  assert.equal(result.candidate.creator?.externalID, "synthetic-owner-id");
  assert.match(result.candidate.skill!.repository, /^https:\/\/clawhub\.ai\//);
  assert.equal(automaticReviewEligibility(result.candidate), undefined);
  assert.equal(clawHubCandidateIdentity(promptSchema.parse(result.candidate)), clawHubCandidateIdentity(result.candidate), "Schema field ordering cannot invalidate provenance");
  assert.throws(() => clawHubURL({ owner: "another-author", slug: "github" }), /not allowlisted/);
});

test("conflicting moderation, non-clean version, missing scan and scanner disagreement withhold before downloading instructions", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.version.version.security.status = "suspicious"; },
    (f: ReturnType<typeof fixture>) => { f.version.version.security.hasScanResult = false; },
    (f: ReturnType<typeof fixture>) => { f.version.version.security.scanners.example.normalizedStatus = "suspicious"; },
  ]) {
    const f = fixture(); mutate(f); let requests = 0;
    await assert.rejects(collectClawHubSkill(f.source, async url => { requests++; return new URL(url).pathname.includes("/versions/") ? encode(f.version) : encode(f.detail); }), /not clean/);
    assert.equal(requests, 2);
  }
  const f = fixture();
  for (const moderation of [{ isSuspicious: true, isMalwareBlocked: false, verdict: "clean" },
    { isSuspicious: false, isMalwareBlocked: true, verdict: "clean" }, { isSuspicious: false, isMalwareBlocked: false, verdict: "pending" }])
    assert.throws(() => inspectClawHubVersion(f.source, { ...f.detail, moderation }, f.version), /moderation/);
});

test("registry provenance rejects changed owners, versions, body hashes, invalid inventories and conflicting licenses", () => {
  const f = fixture();
  assert.throws(() => parseClawHubSkill(f.source, { ...f.detail, owner: { ...f.detail.owner, handle: "impostor" } }, f.version, f.bytes), /mismatch/);
  assert.throws(() => parseClawHubSkill(f.source, f.detail, { ...f.version, version: { ...f.version.version, version: "2.0.0" } }, f.bytes), /mismatch/);
  assert.throws(() => parseClawHubSkill(f.source, f.detail, f.version, Buffer.from(f.bytes.toString().replace("garden", "danger"))), /bytes/);
  for (const files of [[], [f.version.version.files[0], f.version.version.files[0]], [f.version.version.files[1]],
    [...f.version.version.files, { path: "../outside", size: 1, sha256: "c".repeat(64) }]])
    assert.throws(() => inspectClawHubVersion(f.source, f.detail, { ...f.version, version: { ...f.version.version, files } }));
  assert.throws(() => inspectClawHubVersion(f.source, f.detail, { ...f.version, version: { ...f.version.version, license: "Proprietary" } }));
});

test("manifest identity is order-independent, excludes mutable scan metadata and binds all files and publisher IDs", () => {
  const f = fixture(), original = f.candidate();
  f.version.version.files.reverse(); f.version.version.security.hasWarnings = false;
  assert.equal(f.candidate().source.revision, original.source.revision);
  f.version.version.files.find(file => file.path === "reference.md")!.sha256 = "c".repeat(64);
  const changed = f.candidate();
  assert.notEqual(changed.source.revision, original.source.revision);
  assert.equal(changed.fingerprint, original.fingerprint);
  assert.notEqual(editorialDecisionKey(changed), editorialDecisionKey(original));
  f.detail.owner.userId = "another-publisher";
  assert.notEqual(f.candidate().source.revision, changed.source.revision);
});

test("changed supporting files invalidate approval and decision cache without changing prompt fingerprint", async () => {
  const f = fixture(), original = f.candidate();
  let reviews: Reviews = {}, cache: EditorialCache = { version: 1, decisions: {} }, calls = 0;
  const run = async (day: string) => runEditorialReview({ candidates: [f.candidate()], previous: [], reviews, cache, day,
    provider: async items => { calls++; return { decisions: items.map(item => ({ id: item.id, fingerprint: item.fingerprint, decision: "approve", reason: "Synthetic complete fixture", metadata: { ...metadata, cover: null } })) }; },
    persistReviews: async value => { reviews = value; }, persistCache: async value => { cache = editorialCacheSchema.parse(value); }, persistLedger: async () => {} });
  assert.equal((await run("2026-10-12")).report.approved, 1);
  assert.equal(reviews[original.id].sourceRevision, original.source.revision);
  assert.equal(applyEditorialReviews([original], reviews)[0].reviewStatus, "candidate");
  const oldReview = { ...reviews[original.id] }; delete oldReview.sourceRevision;
  assert.equal(applyEditorialReviews([original], { [original.id]: oldReview })[0].reviewStatus, "draft");
  f.version.version.files[1].sha256 = "c".repeat(64);
  assert.equal(applyEditorialReviews([f.candidate()], reviews)[0].reviewStatus, "draft");
  assert.equal((await run("2026-10-13")).report.approved, 1); assert.equal(calls, 2);
  assert.equal(Object.keys(cache.decisions).length, 2);
  assert.equal(publicationText({ ...original, prompt: '{argument name="keep" default="source"}' }, reviews), '{argument name="keep" default="source"}');
});

test("daily collection caches public reads, withholds failed old copies, binds publication identity and leaves tombstones untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-clawhub-"));
  try {
    const now = "2026-10-12T12:00:00.000Z", first = await prepareClawHub(root, { now, read: reader() });
    assert.equal(first.report.requests, 9); assert.equal(first.candidates.length, 3);
    const cached = await prepareClawHub(root, { now, read: async () => { throw new Error("Should not read"); } });
    assert.equal(cached.report.requests, 0); assert.equal(cached.candidates.length, 3);
    assert.equal(filterClawHubAvailability(first.candidates, first.state, Date.parse(now)).prompts.length, 3);
    assert.equal(filterClawHubAvailability(first.candidates, first.state, Date.parse(now) + 24 * 3_600_000).prompts.length, 0);
    const changed = { ...first.candidates[0], prompt: "Changed source body" };
    assert.equal(filterClawHubAvailability([changed], first.state, Date.parse(now)).prompts.length, 0);
    const localized = { ...first.candidates[0], title: "Edited title", creator: { ...first.candidates[0].creator!, avatarURL: "https://api.prompix.dev/media/avatar.jpg" } };
    assert.equal(clawHubCandidateIdentity(localized), clawHubCandidateIdentity(first.candidates[0]));
    await atomic(join(root, "moderation.json"), { removedIDs: ["existing-removal"] });
    const before = await readFile(join(root, "moderation.json"));
    const failed = await prepareClawHub(root, { now: "2026-10-13T12:00:00.000Z", read: async () => { throw new ClawHubHTTPError(404); } });
    assert.equal(failed.candidates.length, 0); assert.equal(failed.report.requests, 3);
    assert.equal(filterClawHubAvailability(first.candidates, failed.state, Date.parse("2026-10-13T12:01:00Z")).prompts.length, 0);
    await assert.rejects(assertClawHubAvailability(root, { prompts: first.candidates }), /unavailable/);
    assert.deepEqual(await readFile(join(root, "moderation.json")), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a mislabeled registry candidate remains deferred without corrupting the revision-aware decision cache", async () => {
  const item = { ...fixture().candidate(), id: "unallowlisted-source" };
  let cache: EditorialCache = { version: 1, decisions: {} };
  const result = await runEditorialReview({ candidates: [item], previous: [], reviews: {}, cache, day: "2026-10-12",
    provider: async () => { throw new Error("Preflight must not call a provider"); },
    persistReviews: async () => {}, persistLedger: async () => {}, persistCache: async value => { cache = editorialCacheSchema.parse(value); } });
  assert.equal(result.report.requests, 0); assert.equal(result.report.preflightDeferred, 1);
  assert.equal(cache.decisions[editorialDecisionKey(item)].sourceRevision, item.source.revision);
});

test("Retry-After stops the pass, persists across processes and prevents immediate request retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-clawhub-throttle-"));
  try {
    const now = "2026-10-12T12:00:00.000Z";
    const first = await prepareClawHub(root, { now, read: async () => { throw new ClawHubHTTPError(429, "86400"); } });
    assert.equal(first.report.requests, 1); assert.equal(first.state.nextAttemptAfter, "2026-10-13T12:00:00.000Z");
    const next = await prepareClawHub(root, { now: "2026-10-13T11:00:00.000Z", read: async () => { throw new Error("Unexpected request"); } });
    assert.equal(next.report.requests, 0); assert.equal(next.candidates.length, 0);
    assert.equal((await readClawHubState(root)).records[clawHubID(clawHubSources[2])].status, "failed");
    assert.equal(clawHubRetryTime("Mon, 12 Oct 2026 20:00:00 GMT", Date.parse(now)), "2026-10-12T20:00:00.000Z");
    assert.equal(clawHubRetryTime("invalid", Date.parse(now)), "2026-10-12T13:00:00.000Z");
  } finally { await rm(root, { recursive: true, force: true }); }
});
