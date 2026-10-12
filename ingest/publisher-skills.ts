import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { download } from "./network.ts";
import { frontmatterValue } from "./skills.ts";
import { requestSkillTree } from "./github-skill-tree.ts";
import { fingerprint, type Candidate } from "./sources.ts";
import { creatorFromURL } from "./creators.ts";
import type { Prompt } from "../packages/schema/catalog.ts";

const exec = promisify(execFile);
/** Public package roots only: internal evaluation and experimental directories are excluded. */
export const skillPublishers = [
  { id: "expo", repo: "expo/skills", root: "plugins/expo/skills", publisher: "Expo" },
  { id: "supabase", repo: "supabase/agent-skills", root: "skills", publisher: "Supabase" },
] as const;
export type SkillPublisher = (typeof skillPublishers)[number];
const sha = /^[a-f0-9]{40}$/;
const slug = /^[a-z0-9][a-z0-9-]{0,63}$/;
const treeSchema = z.object({ truncated: z.literal(false), tree: z.array(z.object({
  path: z.string().min(1).max(1000), type: z.enum(["blob", "tree", "commit"]),
  mode: z.string(), sha: z.string().regex(sha), size: z.number().int().nonnegative().optional(),
})).max(100000) });
type Tree = z.infer<typeof treeSchema>;
export type PublisherPackage = { publisher: SkillPublisher; directory: string; id: string;
  files: string[]; entry: Tree["tree"][number]; license: Tree["tree"][number] };
function assertPublisher(publisher: SkillPublisher) {
  if (!skillPublishers.some(value => JSON.stringify(value) === JSON.stringify(publisher))) throw new Error("Skill publisher is not allowlisted");
}
export function isPublisherSkill(item: Pick<Prompt, "id" | "source">): boolean {
  return item.id.startsWith("skill-publisher-") || skillPublishers.some(value => item.source.name === `${value.publisher} Skills`);
}

/** Discover only one-level packages with complete regular-file inventories at an immutable tree. */
export function discoverPublisherPackages(publisher: SkillPublisher, value: unknown): PublisherPackage[] {
  assertPublisher(publisher);
  const data = treeSchema.parse(value), paths = new Set<string>();
  for (const entry of data.tree) {
    if (paths.has(entry.path) || /[\\\u0000-\u001f\u007f]/.test(entry.path) || entry.path.split("/").some(part => !part || part === "." || part === ".."))
      throw new Error("Publisher tree contains duplicate or invalid paths");
    paths.add(entry.path);
  }
  const prefix = publisher.root + "/";
  const entries = data.tree.filter(entry => entry.path.startsWith(prefix) && entry.path.endsWith("/SKILL.md") &&
    entry.path.slice(prefix.length).split("/").length === 2);
  if (entries.length > 64) throw new Error("Publisher exceeds the 64-package collection limit");
  return entries.map(entry => {
    const name = entry.path.slice(prefix.length, -"/SKILL.md".length), directory = `${publisher.root}/${name}`;
    if (!slug.test(name)) throw new Error("Invalid publisher package name");
    const members = data.tree.filter(value => value.path.startsWith(directory + "/") && value.type !== "tree");
    if (members.some(value => value.type !== "blob" || !["100644", "100755"].includes(value.mode)))
      throw new Error("Publisher package contains a symlink or submodule");
    const files = members.map(value => value.path.slice(directory.length + 1));
    if (!files.includes("SKILL.md") || files.length > 200) throw new Error("Publisher package inventory is incomplete or oversized");
    // Respect the closest license to this package; never silently prefer a distant root license.
    const ancestors = directory.split("/");
    let license: Tree["tree"][number] | undefined;
    for (let depth = ancestors.length; depth >= 0 && !license; depth--) {
      const base = ancestors.slice(0, depth).join("/");
      const licenses = data.tree.filter(value => ["LICENSE", "LICENSE.txt", "LICENSE.md"].some(name => value.path === (base ? base + "/" : "") + name));
      if (licenses.length > 1) throw new Error("Publisher package has ambiguous license files");
      license = licenses[0];
    }
    if (!license || license.type !== "blob" || license.mode !== "100644") throw new Error("Publisher package is missing a regular license file");
    return { publisher, directory, id: `skill-publisher-${publisher.id}-${name}`, entry, license,
      files: ["SKILL.md", ...files.filter(value => value !== "SKILL.md").sort()] };
  }).sort((a, b) => a.id.localeCompare(b.id));
}
function verifyBlob(bytes: Buffer, entry: Tree["tree"][number]) {
  const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (entry.size !== bytes.length || entry.sha !== hash) throw new Error("Publisher file does not match its pinned Git object");
}
export function parsePublisherSkill(pack: PublisherPackage, revision: string, body: Buffer, licenseBytes: Buffer): Candidate {
  assertPublisher(pack.publisher);
  if (!sha.test(revision)) throw new Error("Publisher Skill requires an immutable revision");
  verifyBlob(body, pack.entry); verifyBlob(licenseBytes, pack.license);
  const license = licenseBytes.toString("utf8"), markdown = body.toString("utf8").trim();
  if (!/^\s*(?:The )?MIT License\b/.test(license) || !license.includes("Permission is hereby granted, free of charge") ||
      !license.includes('THE SOFTWARE IS PROVIDED "AS IS"')) throw new Error("Publisher license is not the expected MIT grant");
  const header = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const name = header ? frontmatterValue(header, "name") : undefined, description = header ? frontmatterValue(header, "description") : undefined;
  const declaredLicense = header ? frontmatterValue(header, "license") : undefined;
  if (!name || !slug.test(name) || !description || description.length > 4000 || markdown.length > 30000 ||
      (declaredLicense && !["MIT", "MIT License"].includes(declaredLicense))) throw new Error("Publisher Skill metadata or license is unsupported");
  const repo = `https://github.com/${pack.publisher.repo}`, directoryURL = `${repo}/tree/${revision}/${pack.directory}`;
  return { id: pack.id, kind: "text", contentType: "skill", title: name, summary: description, prompt: markdown,
    example: "在电脑的编程助手中安装完整目录及参考文件，按任务使用；此页面不执行安装或脚本。",
    tags: ["Agent Skills", pack.publisher.publisher], model: "Agent Skills", toolURL: directoryURL,
    artwork: "text-editorial", previewLabel: "Skill 使用说明",
    creator: creatorFromURL(`https://github.com/${pack.publisher.repo.split("/")[0]}`, pack.publisher.publisher),
    skill: { name, description, format: "agent-skills", entrypoint: "SKILL.md", repository: repo,
      directory: pack.directory, installURL: directoryURL, files: pack.files },
    source: { name: `${pack.publisher.publisher} Skills`, author: pack.publisher.publisher, license: "MIT",
      url: `${repo}/blob/${revision}/${pack.directory}/SKILL.md`, repository: repo, revision,
      method: `Official public Skill; license: ${repo}/blob/${revision}/${pack.license.path}` },
    media: null, fingerprint: fingerprint(markdown), featured: false, reviewStatus: "draft" };
}
export function publisherSkillIssue(item: Pick<Prompt, "id" | "source" | "skill" | "contentType">): string | undefined {
  const pack = item.skill, revision = item.source.revision;
  const publisher = skillPublishers.find(value => pack?.repository === `https://github.com/${value.repo}`);
  const name = publisher && pack?.directory.startsWith(publisher.root + "/") ? pack.directory.slice(publisher.root.length + 1) : "";
  if (!publisher || !pack || item.contentType !== "skill" || !slug.test(name) || !revision || !sha.test(revision) ||
      item.id !== `skill-publisher-${publisher.id}-${name}` || item.source.name !== `${publisher.publisher} Skills` ||
      item.source.license !== "MIT" || item.source.repository !== pack.repository ||
      item.source.url !== `${pack.repository}/blob/${revision}/${pack.directory}/SKILL.md` ||
      pack.installURL !== `${pack.repository}/tree/${revision}/${pack.directory}` || !pack.files?.includes("SKILL.md"))
    return "Publisher Skill lacks verified public-package identity";
}
export async function collectPublisherSkills(publisher: SkillPublisher) {
  assertPublisher(publisher);
  let revision: string;
  try {
    const { stdout } = await exec("git", ["ls-remote", "--exit-code", `https://github.com/${publisher.repo}.git`, "HEAD"],
      { timeout: 60000, maxBuffer: 200000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    revision = stdout.match(/^([a-f0-9]{40})\tHEAD\r?$/m)?.[1] ?? "";
  } catch { throw new Error("Publisher revision lookup failed"); }
  if (!sha.test(revision)) throw new Error("Invalid publisher revision");
  const tree = await requestSkillTree(publisher.repo, revision, exec), packs = discoverPublisherPackages(publisher, tree);
  const licenses = new Map<string, Promise<Buffer>>(), candidates: Candidate[] = [], deferred: { id: string; reason: string }[] = [];
  for (const pack of packs) {
    try {
      const raw = `https://raw.githubusercontent.com/${publisher.repo}/${revision}/`;
      if (!licenses.has(pack.license.path)) licenses.set(pack.license.path, download(raw + pack.license.path, ["raw.githubusercontent.com"], 40000).then(result => result.bytes));
      const [body, license] = await Promise.all([download(raw + pack.entry.path, ["raw.githubusercontent.com"], 100000), licenses.get(pack.license.path)!]);
      candidates.push(parsePublisherSkill(pack, revision, body.bytes, license));
    } catch (error) { deferred.push({ id: pack.id, reason: error instanceof Error ? error.message : "Publisher package read failed" }); }
  }
  return { revision, candidates, deferred, tree };
}
