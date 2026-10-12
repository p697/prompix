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
  const load = createSkillFileInventory(async (command, args, options) => {
    requests++;
    assert.equal(command, "gh");
    assert.deepEqual(args, ["api", "--hostname", "github.com", `repos/${source.repo}/git/trees/${revision}?recursive=1`,
      "--header", "Accept: application/vnd.github+json", "--header", "X-GitHub-Api-Version: 2026-03-10"]);
    assert.equal(options.encoding, "utf8"); assert.equal(options.timeout, 60_000); assert.equal(options.maxBuffer, 7_000_000);
    assert.equal(options.killSignal, "SIGKILL"); assert.equal(options.shell, false);
    assert.equal(options.env?.GH_PROMPT_DISABLED, "1"); assert.equal(options.env?.GH_DEBUG, ""); assert.equal(options.env?.DEBUG, "");
    assert.equal(options.env?.GH_FORCE_TTY, ""); assert.equal(options.env?.GH_PAGER, "cat"); assert.equal(options.env?.PAGER, "cat");
    assert.equal(options.env?.GH_NO_UPDATE_NOTIFIER, "1"); assert.equal(options.env?.GH_NO_EXTENSION_UPDATE_NOTIFIER, "1");
    return { stdout: JSON.stringify(response) };
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
    await assert.rejects(load(entry, revision), /^Error: Skill repository tree request failed$/);
  assert.equal(requests, 1);
});

test("tree requests are separated by repository and exact immutable revision", async () => {
  const endpoints: string[] = [], otherSource = skillSources.find(entry => entry.repo !== source.repo)!;
  const response = { truncated: false, tree: [...tree(["SKILL.md", "LICENSE.txt"]).tree,
    ...tree(["SKILL.md", "LICENSE.txt"], otherSource.directory).tree] };
  const load = createSkillFileInventory(async (_command, args) => {
    endpoints.push(args[3]);
    return { stdout: JSON.stringify(response) };
  });
  await Promise.all([load(source, revision), load(source, "b".repeat(40)), load(otherSource, revision)]);
  assert.deepEqual(endpoints, [
    `repos/${source.repo}/git/trees/${revision}?recursive=1`,
    `repos/${source.repo}/git/trees/${"b".repeat(40)}?recursive=1`,
    `repos/${otherSource.repo}/git/trees/${revision}?recursive=1`,
  ]);
});

test("unallowlisted sources and nonexact revisions fail before starting the CLI", async () => {
  let requests = 0;
  const load = createSkillFileInventory(async () => { requests++; throw new Error("Unexpected CLI call"); });
  for (const invalidSource of [{ ...source, id: "unknown" }, { ...source, repo: "unknown/private" }, { ...source, directory: "../private" }])
    await assert.rejects(load(invalidSource, revision), /not allowlisted/);
  for (const invalidRevision of ["main", "a".repeat(39), "a".repeat(41), "A".repeat(40), `${revision}\n`, `${revision}?recursive=0`]) {
    await assert.rejects(load(source, invalidRevision), /immutable/);
    await assert.rejects(collectSkill(source, invalidRevision), /Invalid Skill repository revision/);
  }
  assert.equal(requests, 0);
});

test("CLI failures including timeouts and output overflow expose no raw diagnostics", async () => {
  for (const properties of [{ code: "ENOENT" }, { killed: true, signal: "SIGKILL" }, { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, { code: 1 }]) {
    const diagnostic = "synthetic-private-diagnostic";
    const failure = Object.assign(new Error(diagnostic), properties, { stdout: diagnostic, stderr: diagnostic, cause: new Error(diagnostic) });
    let requests = 0;
    const load = createSkillFileInventory(async () => { requests++; throw failure; });
    for (const entry of [source, skillSources[1]]) {
      await assert.rejects(load(entry, revision), error => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Skill repository tree request failed");
        assert.equal(error.cause, undefined);
        assert.deepEqual(Object.keys(error), []);
        assert.ok(!String(error.stack).includes(diagnostic));
        return true;
      });
    }
    assert.equal(requests, 1, "A failed authenticated request must not fall back to another request");
  }
});

test("malformed JSON is redacted and complete tree validation still applies to CLI output", async () => {
  for (const stdout of ["", "synthetic-private-diagnostic", '{"truncated": false, "tree": [']) {
    const load = createSkillFileInventory(async () => ({ stdout }));
    await assert.rejects(load(source, revision), /^Error: Skill repository tree response is not valid JSON$/);
  }
  for (const value of [null, {}, { ...tree(["SKILL.md", "LICENSE.txt"]), truncated: true }]) {
    const load = createSkillFileInventory(async () => ({ stdout: JSON.stringify(value) }));
    await assert.rejects(load(source, revision), /malformed or truncated/);
  }
});

test("decoded tree output accepts exactly 7 MB and rejects a multibyte overflow", async () => {
  const value = tree(["SKILL.md", "LICENSE.txt"]), json = JSON.stringify(value);
  const exact = json + " ".repeat(7_000_000 - Buffer.byteLength(json));
  assert.equal(Buffer.byteLength(exact), 7_000_000);
  assert.deepEqual(await createSkillFileInventory(async () => ({ stdout: exact }))(source, revision), ["SKILL.md", "LICENSE.txt"]);
  const overflow = JSON.stringify({ ...value, padding: "é".repeat(3_500_000) });
  assert.ok(overflow.length < 7_000_000);
  assert.ok(Buffer.byteLength(overflow) > 7_000_000);
  await assert.rejects(createSkillFileInventory(async () => ({ stdout: overflow }))(source, revision), /exceeds size limit/);
});

test("unknown Skill sources, changed licensing and malformed metadata fail before publication", async () => {
  assert.throws(() => parseSkill(markdown, "Source available; all rights reserved", source, revision), /expected Apache/);
  assert.throws(() => parseSkill(markdown, license, source, "main"), /immutable/);
  assert.throws(() => parseSkill(markdown.replace("name: original-test-skill", "name: ../../secret"), license, source, revision), /metadata/);
  assert.throws(() => parseSkill("# No frontmatter", license, source, revision), /frontmatter/);
  await assert.rejects(collectSkill({ ...source, directory: "../../private" }, revision), /not allowlisted/);
  await assert.rejects(skillRepositoryRevision("unknown/private"), /not allowlisted/);
});
