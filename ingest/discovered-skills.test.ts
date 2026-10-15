import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkillPackages, verifyDiscoveredSkill, discoveredSkillIssue, githubRepositoryLink } from "./discovered-skills.ts";
import { prepareDiscoveredSkills } from "./discovered-skill-daily.ts";
import { applyEditorialReviews } from "./editorial.ts";
import { automaticReviewEligibility, editorialDecisionKey } from "./editorial-runner.ts";
const revision = "a".repeat(40);
const license = 'MIT License\nCopyright (c) 2026 Test Author\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.';
function fixture() {
  const bytes = new Map<string, Buffer>(Object.entries({
    LICENSE: license,
    "skills/poster/SKILL.md": "---\nname: poster\ndescription: Design an original poster with a clear hierarchy.\n---\n# Poster\nRead reference.md and prepare an original layout.\n![Example](assets/example.png)",
    "skills/poster/reference.md": "Choose a clear focal point. Keep the title legible.",
    "skills/poster/assets/example.png": "first-party-image-fixture",
  }).map(([path, body]) => [path, Buffer.from(body)]));
  const tree = { truncated: false, tree: [...bytes].map(([path, data]) => ({ path, type: "blob", mode: "100644", size: data.length,
    sha: createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex") })) };
  return { bytes, tree, read: async (entry: { path: string }) => bytes.get(entry.path)! };
}
test("X links can discover repositories but redirects, arbitrary hosts, issue pages and credentials cannot become fetch targets", () => {
  assert.equal(githubRepositoryLink("https://github.com/Artist/Creative-Skills/tree/branch/with/slash/skills/poster"), "artist/creative-skills");
  for (const link of ["http://github.com/a/b", "https://github.com.evil.test/a/b", "https://u:p@github.com/a/b", "https://github.com:8443/a/b", "https://github.com/a/b/issues/1", "https://127.0.0.1/a/b", "https://github.com/a/b%2fc"])
    assert.equal(githubRepositoryLink(link), undefined, link);
});
test("full package verification reads every file and keeps canonical identity, explicit cover provenance and review gate", async () => {
  const f = fixture(), pack = discoverSkillPackages(f.tree).packages[0], read: string[] = [];
  const result = await verifyDiscoveredSkill("artist/creative-skills", revision, pack, async entry => { read.push(entry.path); return f.read(entry); }, "https://x.com/artist/status/123");
  const item = result.candidate;
  assert.equal(discoveredSkillIssue(item), undefined); assert.equal(automaticReviewEligibility(item), undefined);
  assert.equal(result.inventory.length, 3); assert.equal(new Set(read).size, 4);
  assert.match(item.media!.imageURL!, /\/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\/skills\/poster\/assets\/example.png$/);
  assert.match(item.source.method, /discovered via https:\/\/x.com\/artist\/status\/123/);
  assert.equal(item.reviewStatus, "draft"); assert.equal(applyEditorialReviews([item], {})[0].reviewStatus, "draft");
  assert.notEqual(editorialDecisionKey(item), editorialDecisionKey({ ...item, source: { ...item.source, revision: "b".repeat(40) } }));
  assert.ok(discoveredSkillIssue({ ...item, skill: { ...item.skill!, files: ["SKILL.md", "../../secret"] } }));
});
test("corrupt companion files or licenses block the whole package, even when SKILL.md is valid", async () => {
  for (const corrupt of ["LICENSE", "skills/poster/reference.md", "skills/poster/assets/example.png"]) {
    const f = fixture(), pack = discoverSkillPackages(f.tree).packages[0];
    await assert.rejects(verifyDiscoveredSkill("artist/creative-skills", revision, pack,
      async entry => entry.path === corrupt ? Buffer.from("tampered") : f.read(entry)), /integrity mismatch/);
  }
});
test("truncated trees, traversal, duplicate paths, symlinks, submodules and nearest-license ambiguity fail closed", () => {
  const f = fixture();
  assert.throws(() => discoverSkillPackages({ ...f.tree, truncated: true }));
  for (const path of ["skills/poster/../escape", "skills/poster/\\secret", "skills/poster/SKILL.md"]) {
    assert.throws(() => discoverSkillPackages({ ...f.tree, tree: [...f.tree.tree, { ...f.tree.tree[0], path }] }), /Unsafe/);
  }
  for (const mutation of [{ mode: "120000" }, { type: "commit" }, { size: 6_000_000 }]) {
    const result = discoverSkillPackages({ ...f.tree, tree: f.tree.tree.map(e => e.path.endsWith("reference.md") ? { ...e, ...mutation } : e) });
    assert.equal(result.packages.length, 0); assert.equal(result.held, 1);
  }
  const ambiguous = discoverSkillPackages({ ...f.tree, tree: [...f.tree.tree, { ...f.tree.tree[0], path: "LICENSE.md" }] });
  assert.equal(ambiguous.packages.length, 0);
});
test("closest restrictive license overrides permissive root license", async () => {
  const f = fixture(), body = Buffer.from("All rights reserved");
  const path = "skills/poster/LICENSE"; f.bytes.set(path, body);
  f.tree.tree.push({ path, type: "blob", mode: "100644", size: body.length, sha: createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex") });
  const pack = discoverSkillPackages(f.tree).packages[0]; assert.equal(pack.license.path, path);
  await assert.rejects(verifyDiscoveredSkill("artist/creative-skills", revision, pack, f.read), /MIT grant/);
});
test("discovery persists X priority and complete drafts across restarts without repeating successful package work", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-new-skill-")), f = fixture(); let inspected = 0, collected = 0, searches = 0;
  const records = [{ postID: "123", sourceURL: "https://x.com/artist/status/123", snapshot: "test", state: "blocked" as const,
    reason: "missing-prompt-boundary", expandedLinks: ["https://github.com/artist/creative-skills"] }];
  const options = { now: "2026-10-15T00:00:00Z", search: async () => { searches++; return { incomplete_results: false, items: [] }; },
    inspect: async () => { inspected++; return { revision, ...discoverSkillPackages(f.tree) }; },
    collect: async (repo: string, commit: string, pack: ReturnType<typeof discoverSkillPackages>["packages"][number], origin?: string) => {
      collected++; return verifyDiscoveredSkill(repo, commit, pack, f.read, origin);
    } };
  try {
    const first = await prepareDiscoveredSkills(root, records, options); assert.equal(first.report.xLeads, 1); assert.equal(first.candidates.length, 1);
    const second = await prepareDiscoveredSkills(root, records, options); assert.deepEqual(second.candidates, first.candidates);
    assert.equal(inspected, 1); assert.equal(collected, 1); assert.equal(searches, 1);
    await prepareDiscoveredSkills(root, records, { ...options, now: "2026-10-15T06:00:00Z" });
    assert.equal(inspected, 2); assert.equal(collected, 1);
    const evidence = JSON.parse(await readFile(join(root, "skill-discovery/evidence", `${first.candidates[0].id}-${revision}.json`), "utf8"));
    assert.equal(evidence.inventory.length, 3); assert.equal(evidence.packageSHA256.length, 64);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("a package network failure is eligible for a later retry rather than permanently considered checked", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-new-skill-retry-")), f = fixture(); let calls = 0;
  const options = { now: "2026-10-15T00:00:00Z", search: async () => ({ incomplete_results: false, items: [{ html_url: "https://github.com/artist/creative-skills", private: false }] }),
    inspect: async () => ({ revision, ...discoverSkillPackages(f.tree) }), collect: async (repo: string, commit: string, pack: ReturnType<typeof discoverSkillPackages>["packages"][number]) => {
      if (++calls === 1) throw new Error("timeout"); return verifyDiscoveredSkill(repo, commit, pack, f.read);
    } };
  try {
    assert.equal((await prepareDiscoveredSkills(root, [], options)).candidates.length, 0);
    assert.equal((await prepareDiscoveredSkills(root, [], { ...options, now: "2026-10-15T06:00:00Z" })).candidates.length, 1);
    assert.equal(calls, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("license keyword bait and appended commercial restrictions are not accepted as MIT", async () => {
  const { standardMITGrant } = await import("./skill-license.ts");
  assert.equal(standardMITGrant(license), true);
  assert.equal(standardMITGrant(license + "\nCommercial use prohibited."), false);
  assert.equal(standardMITGrant('MIT License\nPermission is hereby granted, free of charge\nTHE SOFTWARE IS PROVIDED "AS IS"'), false);
});
test("historical experiments and evaluation fixtures are excluded from current package discovery", () => {
  const f = fixture();
  for (const directory of ["evidence/v1", "tests/fixtures", "archive/old", "experimental/unused"]) {
    const tree = { ...f.tree, tree: f.tree.tree.map(e => ({ ...e, path: e.path.replace("skills/poster", directory) })) };
    assert.equal(discoverSkillPackages(tree).packages.length, 0);
  }
});

test("X gets most inspection slots while unchecked repositories and GitHub searches cannot starve", async () => {
  const root = await mkdtemp(join(tmpdir(), "prompix-discovery-fairness-"));
  const inspected: string[] = [];
  const records = Array.from({ length: 5 }, (_, index) => ({ postID: String(index + 1), sourceURL: `https://x.com/artist/status/${index + 1}`,
    snapshot: "test", state: "blocked" as const, reason: "missing-prompt-boundary",
    expandedLinks: [`https://github.com/artist/${index < 2 ? "creative" : "other"}-${index}`] }));
  const options = { search: async () => ({ incomplete_results: false, items: [0, 1].map(i => ({ html_url: `https://github.com/search/design-${i}`, private: false })) }),
    inspect: async (repo: string) => { inspected.push(repo); return { revision, packages: [], held: 0 }; } };
  try {
    await prepareDiscoveredSkills(root, records, { ...options, now: "2026-10-15T00:00:00Z" });
    assert.equal(inspected.filter(r => r.startsWith("artist/")).length, 2);
    assert.equal(inspected.filter(r => r.startsWith("search/")).length, 1);
    await prepareDiscoveredSkills(root, records, { ...options, now: "2026-10-15T06:00:00Z" });
    assert.equal(inspected.length, 6); assert.equal(new Set(inspected).size, 6);
  } finally { await rm(root, { recursive: true, force: true }); }
});
