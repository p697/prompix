import { createHash } from "node:crypto";
import { z } from "zod";
import { promptSchema, type Prompt } from "../packages/schema/catalog.ts";
import { readResponseBytes } from "./network.ts";
import { frontmatterValue } from "./skills.ts";
import { fingerprint, type Candidate } from "./sources.ts";

/** Expand through review, never install or execute files returned by this registry. */
export const clawHubSources = [
  { owner: "steipete", slug: "github" },
  { owner: "steipete", slug: "gog" },
  { owner: "oswalpalash", slug: "ontology" },
] as const;
export type ClawHubSource = { owner: string; slug: string };
export const clawHubID = (source: ClawHubSource) => `skill-clawhub-${fingerprint(`${source.owner}/${source.slug}`).slice(0, 16)}`;
export const clawHubPage = (source: ClawHubSource) => `https://clawhub.ai/${source.owner}/skills/${source.slug}`;
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, canonical(value)]));
  return value;
}
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const versionName = z.string().regex(/^[0-9][a-zA-Z0-9.+-]{0,79}$/);
const file = z.object({ path: z.string().min(1).max(500), size: z.number().int().nonnegative().max(50_000_000), sha256: sha });
const detailSchema = z.object({
  skill: z.object({ slug: z.string(), displayName: z.string().min(1).max(250) }),
  latestVersion: z.object({ version: versionName, license: z.enum(["MIT-0"]).nullable() }),
  owner: z.object({ handle: z.string(), userId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
    displayName: z.string().min(1).max(200), image: z.string().nullable().optional() }),
  moderation: z.object({ isSuspicious: z.boolean(), isMalwareBlocked: z.boolean(), verdict: z.string() }).nullable(),
});
const versionSchema = z.object({
  skill: z.object({ slug: z.string() }),
  version: z.object({ version: versionName, license: z.enum(["MIT-0"]).nullable(),
    files: z.array(file).min(1).max(200),
    security: z.object({ status: z.string(), hasWarnings: z.boolean(), hasScanResult: z.boolean(),
      scanners: z.record(z.string(), z.object({ status: z.string(), normalizedStatus: z.string().optional() }).nullable()).optional(),
    }),
  }),
});

function assertSource(source: ClawHubSource): void {
  if (!clawHubSources.some(value => value.owner === source.owner && value.slug === source.slug)) throw new Error("ClawHub source is not allowlisted");
}
export function clawHubURL(source: ClawHubSource, suffix = "", params: Record<string, string> = {}): string {
  assertSource(source);
  const url = new URL(`https://clawhub.ai/api/v1/skills/${source.slug}${suffix}`);
  url.searchParams.set("ownerHandle", source.owner);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

export function inspectClawHubVersion(source: ClawHubSource, detailValue: unknown, versionValue: unknown) {
  assertSource(source);
  const detail = detailSchema.parse(detailValue), parsedVersion = versionSchema.parse(versionValue), version = parsedVersion.version;
  if (detail.skill.slug !== source.slug || detail.owner.handle !== source.owner || parsedVersion.skill.slug !== source.slug
    || detail.latestVersion.version !== version.version) throw new Error("ClawHub owner, skill or version mismatch");
  if (detail.moderation && (detail.moderation.isSuspicious || detail.moderation.isMalwareBlocked || detail.moderation.verdict !== "clean"))
    throw new Error("ClawHub moderation does not permit this skill");
  if (version.security.status !== "clean" || !version.security.hasScanResult
    || Object.values(version.security.scanners ?? {}).some(scan => scan && (scan.status !== "clean" || (scan.normalizedStatus && scan.normalizedStatus !== "clean"))))
    throw new Error("ClawHub version scan is not clean");
  const files = [...version.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (files.some(value => /[\\\u0000-\u001f\u007f]/.test(value.path) || value.path.split("/").some(part => !part || part === "." || part === ".."))
    || new Set(files.map(value => value.path)).size !== files.length) throw new Error("Invalid ClawHub file inventory");
  const entry = files.find(value => value.path === "SKILL.md");
  if (!entry || entry.size > 100_000) throw new Error("Missing or oversized ClawHub SKILL.md");
  // Bind publisher identity and every file digest, even when SKILL.md did not change.
  const manifestSHA256 = sha256(JSON.stringify({ ownerID: detail.owner.userId, owner: source.owner, slug: source.slug, version: version.version, files }));
  return { detail, version, files, entry, manifestSHA256 };
}

export function parseClawHubSkill(source: ClawHubSource, detailValue: unknown, versionValue: unknown, bytes: Buffer): Candidate {
  const { detail, version, files, entry, manifestSHA256 } = inspectClawHubVersion(source, detailValue, versionValue);
  if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) throw new Error("ClawHub entrypoint bytes do not match the pinned file inventory");
  const markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const header = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const name = header && frontmatterValue(header, "name"), description = header && frontmatterValue(header, "description");
  const declaredLicense = header && frontmatterValue(header, "license");
  if (declaredLicense && declaredLicense !== "MIT-0") throw new Error("ClawHub frontmatter conflicts with registry license policy");
  if (!name || !/^[a-z0-9-]{1,64}$/.test(name) || !description || description.length > 4000 || markdown.length > 30000)
    throw new Error("Unsupported ClawHub skill frontmatter or body size");
  const page = clawHubPage(source);
  const candidate: Candidate = {
    id: clawHubID(source), kind: "text", contentType: "skill", title: detail.skill.displayName, summary: description, prompt: markdown.trim(),
    example: "阅读完整 SKILL.md，并从 ClawHub 来源页面获取完整文件及使用说明，在支持 Agent Skills 的工具中使用。",
    tags: ["Agent Skills", "社区工具"], model: "Agent Skills", toolURL: null, artwork: "text-editorial", previewLabel: "Skill 使用说明",
    creator: { id: `clawhub-${detail.owner.userId}`, platform: "web", externalID: detail.owner.userId, username: source.owner,
      displayName: detail.owner.displayName, profileURL: `https://clawhub.ai/${source.owner}`,
      ...(detail.owner.image && /^https:\/\/avatars\.githubusercontent\.com\/u\/\d+(?:\?v=\d+)?$/.test(detail.owner.image) ? { avatarURL: detail.owner.image } : {}) },
    skill: { name, description, format: "agent-skills", entrypoint: "SKILL.md", repository: page, directory: `${source.owner}/${source.slug}`,
      installURL: `${page}?version=${encodeURIComponent(version.version)}`, files: ["SKILL.md", ...files.filter(value => value.path !== "SKILL.md").map(value => value.path)] },
    source: { name: "ClawHub", url: clawHubURL(source, "/file", { version: version.version, path: "SKILL.md" }),
      author: detail.owner.displayName, license: "MIT-0", method: "ClawHub public registry; MIT-0 registry policy", repository: page,
      revision: `${version.version}:${manifestSHA256}` },
    media: null, fingerprint: fingerprint(markdown.trim()), featured: false, reviewStatus: "draft",
  };
  promptSchema.parse(candidate);
  return candidate;
}

/** Exact provenance, including package-wide changes, must survive editorial metadata changes. */
export function clawHubCandidateIdentity(item: Prompt): string {
  return sha256(JSON.stringify(canonical({ id: item.id, prompt: item.prompt, source: item.source, skill: item.skill,
    creator: item.creator && { id: item.creator.id, externalID: item.creator.externalID, username: item.creator.username, profileURL: item.creator.profileURL } })));
}
export function isClawHubItem(item: Prompt): boolean {
  return item.id.startsWith("skill-clawhub-") || item.source.name === "ClawHub";
}
export function clawHubReviewEligibility(item: Candidate): string | undefined {
  const source = clawHubSources.find(value => clawHubID(value) === item.id);
  const revision = item.source.revision?.match(/^([0-9][a-zA-Z0-9.+-]{0,79}):([a-f0-9]{64})$/);
  if (!source || !revision || item.contentType !== "skill" || item.source.name !== "ClawHub" || item.source.license !== "MIT-0"
    || item.source.repository !== clawHubPage(source) || item.skill?.repository !== clawHubPage(source)
    || item.source.url !== clawHubURL(source, "/file", { version: revision[1], path: "SKILL.md" })
    || item.skill.directory !== `${source.owner}/${source.slug}` || !item.skill.files?.includes("SKILL.md")
    || item.skill.installURL !== `${clawHubPage(source)}?version=${encodeURIComponent(revision[1])}`)
    return "ClawHub provenance does not match the allowlisted registry package";
}

export class ClawHubHTTPError extends Error {
  constructor(readonly status: number, readonly retryAfter?: string) { super(`ClawHub HTTP ${status}`); }
}
export type ClawHubRead = (url: string, maximumBytes: number) => Promise<Buffer>;
export const readClawHub: ClawHubRead = async (value, maximumBytes) => {
  const url = new URL(value);
  if (url.origin !== "https://clawhub.ai" || !url.pathname.startsWith("/api/v1/") || url.username || url.password) throw new Error("Invalid ClawHub API URL");
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000), headers: { Accept: "application/json, text/plain", "User-Agent": "Prompix/0.3 (+https://prompix.dev)" } });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ClawHubHTTPError(response.status, response.headers.get("retry-after") ?? undefined);
  }
  return readResponseBytes(response, maximumBytes);
};
export async function collectClawHubSkill(source: ClawHubSource, read: ClawHubRead = readClawHub) {
  assertSource(source);
  const detailBytes = await read(clawHubURL(source), 500_000);
  const detail = JSON.parse(detailBytes.toString("utf8"));
  const version = detailSchema.parse(detail).latestVersion.version;
  const versionBytes = await read(clawHubURL(source, `/versions/${encodeURIComponent(version)}`), 500_000);
  const versionValue = JSON.parse(versionBytes.toString("utf8"));
  const inspected = inspectClawHubVersion(source, detail, versionValue);
  const bytes = await read(clawHubURL(source, "/file", { version, path: "SKILL.md" }), 100_000);
  const candidate = parseClawHubSkill(source, detail, versionValue, bytes);
  return { candidate, evidence: { detail, version: versionValue, entrypointText: new TextDecoder("utf-8", { fatal: true }).decode(bytes), entrypointSHA256: sha256(bytes), entrypointBytes: bytes.length,
    manifestSHA256: inspected.manifestSHA256, registryLicensePolicy: "https://github.com/openclaw/clawhub/blob/main/docs/skill-format.md",
    explicitLicense: inspected.version.license, hasWarnings: inspected.version.security.hasWarnings } };
}
