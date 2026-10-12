import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPublisherPackages, parsePublisherSkill, publisherSkillIssue, skillPublishers } from "./publisher-skills.ts";
import { preparePublisherSkills } from "./publisher-skill-daily.ts";
import { applyEditorialReviews } from "./editorial.ts";
import { automaticReviewEligibility, editorialDecisionKey, editorialCacheSchema, editorialModel, runEditorialReview } from "./editorial-runner.ts";
import { promptSchema } from "../packages/schema/catalog.ts";

const revision = "a".repeat(40), publisher = skillPublishers[0];
const body = Buffer.from('---\nname: original-test\ndescription: Build an original synthetic example with clear constraints.\nlicense: MIT License\n---\n\nRead references/example.md, implement the requested feature, and verify its behavior.');
const license = Buffer.from('MIT License\nSynthetic testing notice\nPermission is hereby granted, free of charge\nTHE SOFTWARE IS PROVIDED "AS IS"');
const blob = (path: string, bytes: Buffer = body) => ({ path, type: "blob" as const, mode: "100644", size: bytes.length,
  sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") });
const directory = publisher.root + "/original-test";
const tree = () => ({ truncated: false, tree: [blob("LICENSE", license), blob(directory + "/SKILL.md"), blob(directory + "/references/example.md"),
  blob(".claude/skills/internal/SKILL.md"), blob("plugins/expo-experiments/skills/experimental/SKILL.md")] });
const pack = () => discoverPublisherPackages(publisher, tree())[0];
const candidate = () => parsePublisherSkill(pack(), revision, body, license);

test("public publisher discovery excludes internal directories and retains complete nested inventories", () => {
  const packages = discoverPublisherPackages(publisher, tree()); assert.equal(packages.length, 1);
  assert.deepEqual(packages[0].files, ["SKILL.md", "references/example.md"]);
  assert.equal(packages[0].license.path, "LICENSE", "Root license is not falsely listed inside the package");
  const item = candidate(); assert.equal(item.prompt, body.toString()); assert.equal(item.source.license, "MIT");
  assert.equal(item.skill!.installURL, `https://github.com/expo/skills/tree/${revision}/${directory}`);
  assert.equal(item.creator!.id, "github-expo"); assert.equal(publisherSkillIssue(item), undefined);
  assert.equal(automaticReviewEligibility(item), undefined); assert.equal(promptSchema.safeParse(item).success, true);
});

test("truncation, path ambiguity, unsafe package entries and missing licenses fail closed", () => {
  const original = tree();
  for (const invalid of [ { ...original, truncated: true },
    { ...original, tree: [...original.tree, original.tree[0]] },
    { ...original, tree: [...original.tree, blob(directory + "/../escape.md")] },
    { ...original, tree: [...original.tree, { ...blob(directory + "/link"), mode: "120000" }] },
    { ...original, tree: original.tree.filter(entry => entry.path !== "LICENSE") },
    { ...original, tree: [...original.tree, blob("LICENSE.txt", license)] }])
    assert.throws(() => discoverPublisherPackages(publisher, invalid));
  assert.throws(() => discoverPublisherPackages({ ...publisher, root: ".claude/skills" } as never, original), /allowlisted/);
});

test("the nearest package license and exact Git bytes govern collection", () => {
  const local = { ...tree(), tree: [...tree().tree, blob(directory + "/LICENSE", license)] };
  const nearest = discoverPublisherPackages(publisher, local)[0]; assert.equal(nearest.license.path, directory + "/LICENSE");
  assert.throws(() => parsePublisherSkill(nearest, revision, Buffer.concat([body, Buffer.from("\n")]), license), /Git object/);
  const wrong = Buffer.from("All rights reserved"); nearest.license = blob(directory + "/LICENSE", wrong);
  assert.throws(() => parsePublisherSkill(nearest, revision, body, wrong), /MIT grant/);
  assert.throws(() => parsePublisherSkill(pack(), "main", body, license), /immutable/);
  const conflict = Buffer.from(body.toString().replace("MIT License", "GPL-3.0"));
  assert.throws(() => parsePublisherSkill({ ...pack(), entry: blob(directory + "/SKILL.md", conflict) }, revision, conflict, license), /metadata or license/);
});

test("publisher approvals bind the immutable full package revision, including unchanged entry text", () => {
  const item = candidate();
  const review = { fingerprint: item.fingerprint, sourceRevision: revision, reviewedAt: new Date().toISOString(),
    metadata: { title: "Original workflow", summary: item.summary, example: item.example, tags: item.tags, previewLabel: item.previewLabel } };
  assert.equal(applyEditorialReviews([item], { [item.id]: review })[0].reviewStatus, "candidate");
  const next = parsePublisherSkill(pack(), "b".repeat(40), body, license);
  assert.equal(next.fingerprint, item.fingerprint);
  assert.notEqual(editorialDecisionKey(next), editorialDecisionKey(item));
  assert.equal(applyEditorialReviews([next], { [item.id]: review })[0].reviewStatus, "draft");
  const wrong = structuredClone(item); wrong.skill!.directory = "../internal";
  assert.match(publisherSkillIssue(wrong)!, /identity/);
  assert.equal(applyEditorialReviews([wrong], { [item.id]: review })[0].reviewStatus, "draft");
});

test("publisher collection shares a six-hour cache and retains the prior pinned draft on a failed refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-publishers-")), now = "2026-10-12T10:00:00Z";
  try {
    let calls = 0;
    const collect = async (value: (typeof skillPublishers)[number]) => {
      calls++; return { revision, candidates: value.id === "expo" ? [candidate()] : [], deferred: [], tree: tree() };
    };
    assert.equal((await preparePublisherSkills(root, { now, collect })).candidates.length, 1);
    assert.equal(calls, skillPublishers.length);
    assert.equal((await preparePublisherSkills(root, { now, collect })).candidates.length, 1); assert.equal(calls, skillPublishers.length);
    const failed = await preparePublisherSkills(root, { now: "2026-10-12T17:00:00Z", collect: async () => { throw new Error("Unavailable"); } });
    assert.equal(failed.candidates[0].source.revision, revision);
    const retry = await preparePublisherSkills(root, { now: "2026-10-12T17:01:00Z", collect });
    assert.equal(retry.candidates.length, 1); assert.equal(calls, skillPublishers.length, "A failed refresh cannot cause a tight request loop");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("verified package context reaches the reviewer and supersedes an older entry-only deferral", async () => {
  const item = candidate(), now = "2026-10-12T10:00:00Z", oldKey = `${item.id}:${item.fingerprint}:${revision}`;
  const cache = editorialCacheSchema.parse({ version: 1, decisions: { [oldKey]: {
    id: item.id, fingerprint: item.fingerprint, sourceRevision: revision, decision: "defer", outputKind: "skill",
    metadata: null, reason: "Entry-only review lacks companion context", reviewedAt: now, model: editorialModel,
  } } });
  let saved = cache;
  const result = await runEditorialReview({ candidates: [item], previous: [], reviews: {}, cache,
    day: "2026-10-12", now, maxRequests: 1,
    provider: async items => {
      assert.equal(items[0].expectedOutputKind, "skill");
      assert.deepEqual(items[0].skillPackage?.files, ["SKILL.md", "references/example.md"]);
      assert.equal(items[0].skillPackage?.revision, revision);
      return { decisions: [{ id: item.id, fingerprint: item.fingerprint, outputKind: "skill", decision: "approve", reason: "Complete package entry", metadata: {
        title: "Original example", summary: "Build an original example.", example: "使用建议：Install the pinned package on a desktop tool.",
        tags: ["Development"], previewLabel: "Skill 使用说明", cover: null,
      } }] };
    }, persistCache: async value => { saved = editorialCacheSchema.parse(value); }, persistReviews: async () => {}, persistLedger: async () => {},
  });
  assert.equal(result.report.approved, 1); assert.ok(saved.decisions[oldKey], "Historical evidence is retained");
  assert.ok(saved.decisions[editorialDecisionKey(item)].reviewContext);
  assert.equal(result.reviews[item.id].sourceRevision, revision);
});


test("author-owned marketing packages preserve creator identity and exclude repository tools", () => {
  const author = skillPublishers.find(value => value.id === "corey-haines")!;
  const directory = "skills/original-test";
  const tree = { truncated: false, tree: [blob("LICENSE", license), blob(directory + "/SKILL.md"),
    blob(directory + "/references/example.md"), blob("tools/SKILL.md"), blob("tests/fixture/SKILL.md")] };
  const packages = discoverPublisherPackages(author, tree);
  assert.equal(packages.length, 1);
  const item = parsePublisherSkill(packages[0], revision, body, license);
  assert.equal(item.id, "skill-publisher-corey-haines-original-test");
  assert.equal(item.creator!.id, "github-coreyhaines31");
  assert.equal(item.source.author, "Corey Haines");
  assert.equal(publisherSkillIssue(item), undefined);
  assert.equal(automaticReviewEligibility(item), undefined);
  assert.equal(promptSchema.safeParse(item).success, true);
  const altered = structuredClone(item);
  altered.skill!.repository = "https://github.com/other/marketingskills";
  assert.match(publisherSkillIssue(altered)!, /identity/);
});
