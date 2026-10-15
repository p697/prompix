import { standardMITGrant } from "./skill-license.ts";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { posix } from "node:path";
import { z } from "zod";
import { download } from "./network.ts";
import { requestSkillTree, type SkillTreeExecutor } from "./github-skill-tree.ts";
import { frontmatterValue } from "./skills.ts";
import { fingerprint, type Candidate } from "./sources.ts";
import { creatorFromURL } from "./creators.ts";
import type { Prompt } from "../packages/schema/catalog.ts";

const sha = /^[a-f0-9]{40}$/;
const repoPattern = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/;
const entrySchema = z.object({ path: z.string().min(1).max(1000), type: z.enum(["blob", "tree", "commit"]),
  mode: z.string(), sha: z.string().regex(sha), size: z.number().int().nonnegative().optional() });
const treeSchema = z.object({ truncated: z.literal(false), tree: z.array(entrySchema).max(100000) });
type Entry = z.infer<typeof entrySchema>;
export type DiscoveredPackage = { directory: string; files: Entry[]; license: Entry };
export function githubRepositoryLink(link: string): string | undefined {
  try {
    const url = new URL(link);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port || /%2f|%5c/i.test(url.pathname)) return;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2 || (parts.length > 2 && !["tree", "blob"].includes(parts[2]))) return;
    const repo = `${parts[0]}/${parts[1].replace(/\.git$/, "")}`;
    if (repoPattern.test(repo) && ![".", ".."].includes(parts[1])) return repo.toLowerCase();
  } catch { /* Only canonical public GitHub repository links are discovery leads. */ }
}
function distributableDirectory(directory: string): boolean {
  return !directory.split("/").some(part => /^(?:evidence|tests?|fixtures?|evals?|evaluations?|benchmarks?|archive[sd]?|history|experimental|examples?|drafts?|node_modules|vendor)$/i.test(part));
}
export function discoveredSkillID(repo: string, directory: string): string {
  return "skill-discovered-" + createHash("sha256").update(`${repo.toLowerCase()}/${directory}`).digest("hex").slice(0, 24);
}

/** Host allowlisting only permits inspection. Each package must independently pass license and integrity checks. */
export function discoverSkillPackages(raw: unknown): { packages: DiscoveredPackage[]; held: number } {
  const { tree } = treeSchema.parse(raw), paths = new Set<string>();
  for (const entry of tree) {
    if (paths.has(entry.path) || /[\\\u0000-\u001f\u007f]/.test(entry.path) || entry.path.split("/").some(p => !p || p === "." || p === ".."))
      throw new Error("Unsafe or duplicate repository path");
    paths.add(entry.path);
  }
  const entries = tree.filter(e => e.path === "SKILL.md" || e.path.endsWith("/SKILL.md"));
  if (entries.length > 500) throw new Error("Repository exceeds discovery package bound");
  const packages: DiscoveredPackage[] = []; let held = 0;
  for (const entry of entries) {
    const directory = posix.dirname(entry.path);
    // Repositories often retain evaluation fixtures and old prompt experiments as SKILL.md.
    // Their public presence is not evidence that they are the current distributable package.
    if (!distributableDirectory(directory)) { held++; continue; }
    const prefix = directory === "." ? "" : directory + "/";
    const files = tree.filter(e => e.path.startsWith(prefix) && e.type !== "tree");
    if (files.length > 200 || files.some(e => e.type !== "blob" || !["100644", "100755"].includes(e.mode) || e.size === undefined || e.size > 2_000_000)
      || files.reduce((sum, e) => sum + (e.size ?? 0), 0) > 5_000_000) { held++; continue; }
    // Nested packages have their own boundary; a root index is not a complete standalone Skill.
    if (entries.some(e => e.path !== entry.path && e.path.startsWith(prefix))) { held++; continue; }
    const parts = directory === "." ? [] : directory.split("/");
    let license: Entry | undefined, ambiguous = false;
    for (let depth = parts.length; depth >= 0; depth--) {
      const base = parts.slice(0, depth).join("/");
      const matches = tree.filter(e => e.path.startsWith(base ? base + "/" : "") &&
        ["LICENSE", "LICENSE.txt", "LICENSE.md"].includes(e.path.slice(base ? base.length + 1 : 0)));
      if (matches.length) { license = matches[0]; ambiguous = matches.length !== 1; break; }
    }
    if (ambiguous || !license || license.type !== "blob" || license.mode !== "100644" || (license.size ?? Infinity) > 40000) { held++; continue; }
    packages.push({ directory, files: files.sort((a, b) => a.path.localeCompare(b.path)), license });
  }
  return { packages, held };
}
function checkBlob(bytes: Buffer, entry: Entry) {
  if (entry.size !== bytes.length || entry.sha !== createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"))
    throw new Error("Skill package blob integrity mismatch");
}
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
export async function verifyDiscoveredSkill(repo: string, revision: string, pack: DiscoveredPackage,
  read: (entry: Entry) => Promise<Buffer>, discoveredFrom?: string): Promise<{ candidate: Candidate; inventory: { path: string; sha256: string; bytes: number }[]; packageSHA256: string }> {
  if (!repoPattern.test(repo) || !sha.test(revision)) throw new Error("Invalid immutable repository identity");
  const license = await read(pack.license); checkBlob(license, pack.license);
  const grant = license.toString("utf8");
  if (!standardMITGrant(grant))
    throw new Error("Discovered package does not have a supported MIT grant");
  const files = new Map<string, Buffer>();
  for (const file of pack.files) {
    const bytes = await read(file); checkBlob(bytes, file);
    if (/^(?:LICENSE|LICENSE.txt|LICENSE.md)$/i.test(posix.basename(file.path)) && !standardMITGrant(bytes.toString("utf8")))
      throw new Error("Package includes an unsupported nested license");
    files.set(file.path, bytes);
  }
  const prefix = pack.directory === "." ? "" : pack.directory + "/";
  const markdown = files.get(prefix + "SKILL.md")?.toString("utf8").trim() ?? "";
  const header = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const name = header && frontmatterValue(header, "name"), description = header && frontmatterValue(header, "description");
  const declared = header && frontmatterValue(header, "license");
  if (!name || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || !description || description.length > 4000 || markdown.length > 30000
    || (declared && !["MIT", "MIT License"].includes(declared))) throw new Error("Unsupported Skill metadata or license override");
  // Never infer portability from the file format. The editorial review must describe service prerequisites.
  const repository = `https://github.com/${repo}`, path = pack.directory === "." ? "" : "/" + encodePath(pack.directory);
  const installURL = `${repository}/tree/${revision}${path}`;
  const inventory = pack.files.map(e => ({ path: e.path.slice(prefix.length), sha256: createHash("sha256").update(files.get(e.path)!).digest("hex"), bytes: e.size! }));
  const packageSHA256 = createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
  let imageURL: string | undefined;
  // Only an explicitly embedded raster image inside this same licensed package is a cover candidate.
  for (const doc of [markdown, files.get(prefix + "README.md")?.toString("utf8") ?? ""]) {
    for (const match of doc.matchAll(/!\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"\n]*")?\)/g)) {
      const relative = match[1]; if (/^[a-z]+:|^\/|[?#\\]/i.test(relative)) continue;
      const resolved = posix.normalize(prefix + relative);
      if (!resolved.startsWith(prefix) || !/\.(png|jpe?g|webp)$/i.test(resolved) || !files.has(resolved)) continue;
      imageURL = `https://raw.githubusercontent.com/${repo}/${revision}/${encodePath(resolved)}`; break;
    }
    if (imageURL) break;
  }
  const creator = creatorFromURL(`https://github.com/${repo.split("/")[0]}`, repo.split("/")[0]);
  const candidate: Candidate = { id: discoveredSkillID(repo, pack.directory), kind: "text", contentType: "skill", title: name, summary: description, prompt: markdown,
    example: "在支持 Agent Skills 的工具中使用完整目录。请先核对所需模型、外部服务和安装依赖；此页面不运行脚本。",
    tags: ["Agent Skills"], model: "Agent Skills", toolURL: installURL, artwork: "text-editorial", previewLabel: "Skill 使用说明", creator,
    skill: { name, description, format: "agent-skills", entrypoint: "SKILL.md", repository, directory: pack.directory, installURL,
      files: inventory.map(e => e.path) },
    source: { name: "GitHub Skills", url: `${repository}/blob/${revision}${path}/SKILL.md`, author: creator?.displayName ?? repo.split("/")[0],
      license: "MIT", repository, revision,
      method: `Public package; all listed files hash-verified, not executed or security-audited; license: ${repository}/blob/${revision}/${encodePath(pack.license.path)}${discoveredFrom ? `; discovered via ${discoveredFrom}` : ""}` },
    media: imageURL ? { image: null, video: null, demoURL: null, imageURL } : null,
    fingerprint: fingerprint(markdown), featured: false, reviewStatus: "draft" };
  return { candidate, inventory, packageSHA256 };
}
export function isDiscoveredSkill(item: Pick<Prompt, "id" | "source">): boolean {
  return item.id.startsWith("skill-discovered-") || item.source.name === "GitHub Skills";
}
export function discoveredSkillIssue(item: Prompt): string | undefined {
  const pack = item.skill, revision = item.source.revision, repo = pack && githubRepositoryLink(pack.repository);
  if (!pack || !repo || pack.repository !== `https://github.com/${repo}` || !revision || !sha.test(revision) || item.contentType !== "skill"
    || item.id !== discoveredSkillID(repo, pack.directory) || item.source.name !== "GitHub Skills" || item.source.license !== "MIT"
    || !distributableDirectory(pack.directory)
    || (pack.directory !== "." && (posix.normalize(pack.directory) !== pack.directory || pack.directory.startsWith("/") || pack.directory.startsWith("../") || pack.directory.includes("\\")))
    || item.source.repository !== pack.repository || !pack.files?.length)
    return "Discovered Skill lacks verified package identity";
  const files = pack.files;
  if (!files.includes("SKILL.md") || files.some(path => posix.normalize(path) !== path || path.startsWith("/") || path.startsWith("../") || path.includes("\\"))
    || new Set(files).size !== files.length) return "Discovered Skill inventory is inconsistent";
  const path = pack.directory === "." ? "" : "/" + encodePath(pack.directory);
  if (pack.installURL !== `${pack.repository}/tree/${revision}${path}` || item.source.url !== `${pack.repository}/blob/${revision}${path}/SKILL.md`)
    return "Discovered Skill install path is inconsistent";
}
const exec = promisify(execFile);
export async function githubJSON(endpoint: string, run: SkillTreeExecutor = exec): Promise<unknown> {
  try {
    const { stdout } = await run("gh", ["api", "--hostname", "github.com", endpoint, "--header", "Accept: application/vnd.github+json", "--header", "X-GitHub-Api-Version: 2026-03-10"],
      { encoding: "utf8", timeout: 60000, maxBuffer: 7_000_000, shell: false,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_DEBUG: "", DEBUG: "", GH_FORCE_TTY: "", GH_PAGER: "cat", PAGER: "cat" } });
    return JSON.parse(stdout);
  } catch { throw new Error("Public GitHub discovery request failed"); }
}
export async function inspectDiscoveredRepository(repo: string) {
  if (!repoPattern.test(repo)) throw new Error("Invalid discovery repository");
  const info = z.object({ private: z.literal(false), archived: z.literal(false), disabled: z.literal(false), default_branch: z.string().min(1).max(250),
    full_name: z.string() }).parse(await githubJSON(`repos/${repo}`));
  if (info.full_name.toLowerCase() !== repo.toLowerCase()) throw new Error("Repository was renamed; rediscovery required");
  const commit = z.object({ sha: z.string().regex(sha) }).parse(await githubJSON(`repos/${repo}/commits/${encodeURIComponent(info.default_branch)}`));
  const tree = await requestSkillTree(repo, commit.sha, exec);
  return { revision: commit.sha, ...discoverSkillPackages(tree) };
}
export async function collectDiscoveredPackage(repo: string, revision: string, pack: DiscoveredPackage, discoveredFrom?: string) {
  return verifyDiscoveredSkill(repo, revision, pack, async entry => (await download(
    `https://raw.githubusercontent.com/${repo}/${revision}/${encodePath(entry.path)}`, ["raw.githubusercontent.com"], 2_000_000)).bytes, discoveredFrom);
}
