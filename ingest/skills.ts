import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { download } from "./network.ts";
import { fingerprint, type Candidate } from "./sources.ts";
import { creatorFromURL } from "./creators.ts";

const exec = promisify(execFile);
// Source documents are downloaded into the private content cache, never Git.
// Each directory must independently carry Apache-2.0 terms before collection succeeds.
export const skillSources = [
  ...["frontend-design", "algorithmic-art", "canvas-design", "webapp-testing", "mcp-builder", "theme-factory",
    "academy-guide", "brand-guidelines", "discernment-nudge", "internal-comms", "slack-gif-creator", "web-artifacts-builder"].map(name => ({
    id: `anthropic-${name}`, repo: "anthropics/skills", directory: `skills/${name}`, publisher: "Anthropic", model: "Claude Code", tool: "https://claude.ai/",
  })),
  ...["pdf", "playwright", "jupyter-notebook", "gh-fix-ci", "aspnet-core", "chatgpt-apps", "cli-creator",
    "define-goal", "gh-address-comments", "linear", "migrate-to-codex", "netlify-deploy",
    "openai-docs", "render-deploy", "screenshot", "security-best-practices", "security-ownership-map",
    "security-threat-model", "sentry", "speech", "transcribe", "winui-app", "yeet"].map(name => ({
    id: `openai-${name}`, repo: "openai/skills", directory: `skills/.curated/${name}`, publisher: "OpenAI", model: "Codex", tool: "https://chatgpt.com/codex",
  })),
] as const;
export type SkillSource = (typeof skillSources)[number];

function assertSource(source: SkillSource): void {
  if (!skillSources.some(allowed => allowed.id === source.id && allowed.repo === source.repo && allowed.directory === source.directory)) throw new Error("Skill source is not allowlisted");
}

/** Parse only the two scalar frontmatter fields; never execute YAML tags or source instructions. */
export function frontmatterValue(frontmatter: string, key: string): string | undefined {
  const lines = frontmatter.split(/\r?\n/);
  const index = lines.findIndex(line => line.startsWith(`${key}:`));
  if (index < 0) return;
  const value = lines[index].slice(key.length + 1).trim();
  if (/^[>|][-+]?$/.test(value)) {
    const collected: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (line && !/^\s/.test(line)) break;
      collected.push(line.trim());
    }
    return collected.join(value.startsWith(">") ? " " : "\n").trim();
  }
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { return; }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

export function parseSkill(markdown: string, license: string, source: SkillSource, revision: string): Candidate {
  assertSource(source);
  if (revision.length !== 40 || !/^[a-f0-9]{40}$/.test(revision)) throw new Error("Skill requires an immutable Git revision");
  if (!/^\s*Apache License\s+Version 2\.0, January 2004/.test(license) || !license.includes("END OF TERMS AND CONDITIONS")) throw new Error("Skill directory does not have the expected Apache-2.0 license");
  const header = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!header) throw new Error("Skill is missing YAML frontmatter");
  const name = frontmatterValue(header, "name");
  const description = frontmatterValue(header, "description");
  if (!name || !/^[a-z0-9-]{1,64}$/.test(name) || !description || description.length > 4000 || markdown.length > 30000) throw new Error("Skill metadata exceeds supported limits");
  const repository = `https://github.com/${source.repo}`;
  const directoryURL = `${repository}/tree/${revision}/${source.directory}`;
  return {
    id: `skill-${source.id}`, kind: "text", contentType: "skill", title: name,
    summary: description, prompt: markdown.trim(),
    example: "阅读完整 SKILL.md，然后前往源代码仓库获取该目录及配套文件，在支持 Agent Skills 的工具中使用。",
    tags: ["Agent Skills", "开发工具"], model: source.model, toolURL: source.tool,
    artwork: "text-editorial", previewLabel: "Skill 使用说明",
    creator: creatorFromURL(`https://github.com/${source.repo.split("/")[0]}`, source.publisher),
    skill: { name, description, format: "agent-skills", entrypoint: "SKILL.md", repository, directory: source.directory, installURL: directoryURL },
    source: { name: `${source.publisher} Skills`, url: `${repository}/blob/${revision}/${source.directory}/SKILL.md`, author: source.publisher, license: "Apache-2.0", method: "官方开源 Skill", repository, revision },
    media: null, fingerprint: fingerprint(markdown.trim()), featured: false, reviewStatus: "draft",
  };
}

export async function skillRepositoryRevision(repo: string): Promise<string> {
  if (!skillSources.some(source => source.repo === repo)) throw new Error("Skill repository is not allowlisted");
  const response = await exec("git", ["ls-remote", "--exit-code", `https://github.com/${repo}.git`, "HEAD"], { timeout: 60_000, maxBuffer: 200_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const revision = response.stdout.match(/^([a-f0-9]{40})\tHEAD\r?$/m)?.[1];
  if (!revision) throw new Error("Invalid Skill repository revision");
  return revision;
}

const gitTreeSchema = z.object({
  truncated: z.literal(false),
  tree: z.array(z.object({ path: z.string().min(1).max(1000), type: z.enum(["blob", "tree", "commit"]) })).max(100000),
});

/** Enumerate the complete pinned package, never describe downloaded core files as its full inventory. */
export function skillFilesFromTree(value: unknown, source: SkillSource): string[] {
  assertSource(source);
  const parsed = gitTreeSchema.safeParse(value);
  if (!parsed.success) throw new Error("Skill repository tree is malformed or truncated");
  const prefix = source.directory + "/";
  const entries = parsed.data.tree.filter(entry => entry.path.startsWith(prefix));
  if (entries.some(entry => entry.type === "commit")) throw new Error("Skill submodule inventory cannot be enumerated completely");
  const files = entries.filter(entry => entry.type === "blob").map(entry => entry.path.slice(prefix.length));
  if (files.some(path => /[\\\u0000-\u001f\u007f]/.test(path) || path.split("/").some(part => !part || part === "." || part === "..")))
    throw new Error("Skill inventory contains an invalid relative path");
  if (new Set(files).size !== files.length || !files.includes("SKILL.md") || !files.includes("LICENSE.txt"))
    throw new Error("Skill inventory is duplicate or missing required core files");
  if (files.length > 200) throw new Error("Complete Skill inventory exceeds the 200-file catalog limit");
  const core = ["SKILL.md", "LICENSE.txt"];
  return [...core, ...files.filter(path => !core.includes(path)).sort()];
}

type SkillTreeExecutor = (command: string, args: string[], options: ExecFileOptionsWithStringEncoding) => Promise<{ stdout: string }>;
const treeResponseLimit = 7_000_000;

async function requestSkillTree(repo: string, revision: string, run: SkillTreeExecutor): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await run("gh", ["api", "--hostname", "github.com", `repos/${repo}/git/trees/${revision}?recursive=1`,
      "--header", "Accept: application/vnd.github+json", "--header", "X-GitHub-Api-Version: 2026-03-10"], {
      encoding: "utf8", timeout: 60_000, maxBuffer: treeResponseLimit, killSignal: "SIGKILL", shell: false,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_DEBUG: "", DEBUG: "", GH_FORCE_TTY: "",
        GH_PAGER: "cat", PAGER: "cat", GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1" },
    }));
  } catch {
    // Child-process errors contain stdout/stderr; never expose CLI diagnostics or credentials.
    throw new Error("Skill repository tree request failed");
  }
  if (Buffer.byteLength(stdout, "utf8") > treeResponseLimit) throw new Error("Skill repository tree exceeds size limit");
  try { return JSON.parse(stdout); }
  catch { throw new Error("Skill repository tree response is not valid JSON"); }
}

/** Share one bounded authenticated request across all Skills at the same repository revision. */
export function createSkillFileInventory(run: SkillTreeExecutor = exec) {
  const trees = new Map<string, Promise<unknown>>();
  return async (source: SkillSource, revision: string): Promise<string[]> => {
    assertSource(source);
    if (revision.length !== 40 || !/^[a-f0-9]{40}$/.test(revision)) throw new Error("Skill inventory requires an immutable Git revision");
    const key = `${source.repo}:${revision}`;
    if (!trees.has(key)) {
      trees.set(key, requestSkillTree(source.repo, revision, run));
    }
    return skillFilesFromTree(await trees.get(key), source);
  };
}
const skillFileInventory = createSkillFileInventory();

export async function collectSkill(source: SkillSource, revision: string): Promise<Candidate> {
  assertSource(source);
  if (revision.length !== 40 || !/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid Skill repository revision");
  const raw = `https://raw.githubusercontent.com/${source.repo}/${revision}/${source.directory}`;
  const [body, license, files] = await Promise.all([
    download(`${raw}/SKILL.md`, ["raw.githubusercontent.com"], 100_000),
    download(`${raw}/LICENSE.txt`, ["raw.githubusercontent.com"], 40_000),
    skillFileInventory(source, revision),
  ]);
  const candidate = parseSkill(body.bytes.toString(), license.bytes.toString(), source, revision);
  return { ...candidate, skill: { ...candidate.skill!, files } };
}
