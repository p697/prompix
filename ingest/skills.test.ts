import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkill, skillSources, collectSkill, skillRepositoryRevision, skillFilesFromTree, createSkillFileInventory } from "./skills.ts";
import { promptSchema } from "../packages/schema/catalog.ts";
import { applyEditorialReviews } from "./editorial.ts";
import { selectLibrary, interleaveLibrary } from "./library.ts";

const license = "Apache License\nVersion 2.0, January 2004\nSynthetic test license fixture\nEND OF TERMS AND CONDITIONS";
const source = skillSources[0];
const revision = "a".repeat(40);
const markdown = '---\nname: original-test-skill\ndescription: >-\n  Build an original example.\n  Keep the result easy to inspect.\n---\n\n# Original test skill\n\nFollow these synthetic test steps.\nRead `references/example.md` before beginning.';

test("Skill intake preserves complete source, immutable provenance and honest repository handoff", () => {
  const skill = parseSkill(markdown, license, source, revision);
  assert.equal(skill.prompt, markdown);
  assert.equal(skill.kind, "text", "Old v1 clients retain a supported modality");
  assert.equal(skill.contentType, "skill");
  assert.equal(skill.skill?.description, "Build an original example. Keep the result easy to inspect.");
  assert.equal(skill.skill?.entrypoint, "SKILL.md");
  assert.match(skill.skill!.installURL, new RegExp(`/tree/${revision}/`));
  assert.equal(skill.skill?.files, undefined, "Reading core source documents alone does not establish a complete inventory");
  assert.equal(skill.source.license, "Apache-2.0");
  assert.equal(skill.creator?.id, "github-anthropics");
  assert.equal(promptSchema.parse(skill).contentType, "skill");
  assert.equal(selectLibrary(applyEditorialReviews([skill], {}), new Set()).length, 0);
  const approved = applyEditorialReviews([skill], {
    [skill.id]: { fingerprint: skill.fingerprint, reviewedAt: new Date(0).toISOString(), metadata: { title: "Test workflow", summary: skill.summary, example: skill.example, tags: skill.tags, previewLabel: skill.previewLabel } },
  });
  assert.equal(interleaveLibrary(selectLibrary(approved, new Set()), [], new Set()).length, 1);
  assert.equal(applyEditorialReviews([{ ...skill, fingerprint: "b".repeat(64) }], { [skill.id]: { fingerprint: skill.fingerprint, reviewedAt: new Date(0).toISOString(), metadata: { title: skill.title, summary: skill.summary, example: skill.example, tags: skill.tags, previewLabel: skill.previewLabel } } })[0].reviewStatus, "draft");
});

const tree = (paths: string[], directory = source.directory) => ({ truncated: false,
  tree: paths.map(path => ({ path: `${directory}/${path}`, type: "blob" })) });

test("Skill inventory includes nested scripts and references while excluding sibling packages", () => {
  const inventory = tree(["references/example.md", "SKILL.md", "scripts/run.py", "LICENSE.txt", "assets/template.html"]);
  inventory.tree.push({ path: `${source.directory}-other/private.md`, type: "blob" });
  assert.deepEqual(skillFilesFromTree(inventory, source), ["SKILL.md", "LICENSE.txt", "assets/template.html", "references/example.md", "scripts/run.py"]);
});

test("incomplete, unbounded, duplicate and unsafe file trees fail instead of showing partial counts", () => {
  const complete = tree(["SKILL.md", "LICENSE.txt"]);
  assert.throws(() => skillFilesFromTree({ ...complete, truncated: true }, source), /truncated/);
  assert.throws(() => skillFilesFromTree(tree(["SKILL.md"]), source), /missing/);
  assert.throws(() => skillFilesFromTree(tree(["SKILL.md", "LICENSE.txt", "SKILL.md"]), source), /duplicate/);
  assert.throws(() => skillFilesFromTree(tree(["SKILL.md", "LICENSE.txt", "../outside.md"]), source), /relative path/);
  assert.throws(() => skillFilesFromTree({ ...complete, tree: [...complete.tree, { path: `${source.directory}/vendor`, type: "commit" }] }, source), /submodule/);
  assert.throws(() => skillFilesFromTree(tree(["SKILL.md", "LICENSE.txt", ...Array.from({ length: 199 }, (_, i) => `assets/file-${i}.txt`)]), source), /200-file/);
});

test("Skills at one immutable repository revision share one request even when collected concurrently", async () => {
  let requests = 0;
  const second = skillSources[1];
  const response = { truncated: false, tree: [...tree(["SKILL.md", "LICENSE.txt"]).tree,
    ...tree(["SKILL.md", "LICENSE.txt", "scripts/run.py"], second.directory).tree] };
  const load = createSkillFileInventory(async (url, hosts, maximum, headers) => {
    requests++;
    assert.equal(url, `https://api.github.com/repos/${source.repo}/git/trees/${revision}?recursive=1`);
    assert.deepEqual(hosts, ["api.github.com"]); assert.equal(maximum, 7_000_000);
    assert.equal(headers?.Accept, "application/vnd.github+json");
    return { bytes: Buffer.from(JSON.stringify(response)), type: "application/json" };
  });
  const [firstFiles, secondFiles] = await Promise.all([load(source, revision), load(second, revision)]);
  assert.equal(requests, 1); assert.equal(firstFiles.length, 2); assert.equal(secondFiles.length, 3);
  firstFiles.push("mutated-local-value");
  assert.equal((await load(source, revision)).length, 2);
  await assert.rejects(load(source, "main"), /immutable/);
  assert.equal(requests, 1);
});

test("a failed repository tree request is not repeated once for every package in a run", async () => {
  let requests = 0;
  const load = createSkillFileInventory(async () => { requests++; throw new Error("GitHub unavailable"); });
  for (const entry of skillSources.filter(entry => entry.repo === source.repo))
    await assert.rejects(load(entry, revision), /GitHub unavailable/);
  assert.equal(requests, 1);
});

test("unknown Skill sources, changed licensing and malformed metadata fail before publication", async () => {
  assert.throws(() => parseSkill(markdown, "Source available; all rights reserved", source, revision), /expected Apache/);
  assert.throws(() => parseSkill(markdown, license, source, "main"), /immutable/);
  assert.throws(() => parseSkill(markdown.replace("name: original-test-skill", "name: ../../secret"), license, source, revision), /metadata/);
  assert.throws(() => parseSkill("# No frontmatter", license, source, revision), /frontmatter/);
  await assert.rejects(collectSkill({ ...source, directory: "../../private" }, revision), /not allowlisted/);
  await assert.rejects(skillRepositoryRevision("unknown/private"), /not allowlisted/);
});
