import { mkdir, readFile, writeFile, rename, rm, stat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { catalogSchema, type Catalog, type Prompt } from "../packages/schema/catalog.ts";
import { download } from "./network.ts";

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const contentRoot = resolve(process.env.PROMPIX_CONTENT_DIR ?? join(homedir(), ".local/share/prompix/content"));
export const base = "https://api.prompix.dev";
const exec = promisify(execFile);
export async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
  await rename(tmp, path);
}
export async function json<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw e; }
}
export async function lockContent(root: string) {
  await mkdir(root, { recursive: true });
  const rel = relative(await realpath(repo), await realpath(root));
  if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("Content must stay outside repository");
  const lock = join(root, "daily.lock");
  try { await mkdir(lock); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const owner = await json<{ pid: number } | null>(join(lock, "owner.json"), null);
    let alive = false;
    try { if (owner) { process.kill(owner.pid, 0); alive = true; } }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
    if (alive || Date.now() - (await stat(lock)).mtimeMs < 3600000) throw new Error("Another content operation is running");
    await rm(lock, { recursive: true });
    await mkdir(lock);
  }
  await atomic(join(lock, "owner.json"), { pid: process.pid });
  return () => rm(lock, { recursive: true });
}
export async function upload(key: string, path: string, type: string) {
  await exec(process.env.PROMPIX_WRANGLER ?? "wrangler", [
    "--config", join(repo, "services/content/wrangler.jsonc"), "r2", "object", "put",
    `prompix-content/${key}`, "--remote", "--file", path, "--content-type", type,
  ], { cwd: repo, timeout: 120000, maxBuffer: 100000, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" } });
}
export const manifestSchema = z.object({
  schemaVersion: z.literal(1), version: z.string().regex(/^[a-z0-9-]+$/),
  publishedAt: z.string().datetime(), count: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), catalog: z.string(),
}).refine(m => m.catalog === `${base}/releases/${m.version}/catalog.json`, "Invalid catalog location");
export type Manifest = z.infer<typeof manifestSchema>;
export function digest(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
export function editionVersion(prompts: Prompt[], removedIDs: string[]) {
  // Prompt deduplication normalizes text; publication identity must preserve every byte of meaning.
  const content = JSON.stringify({ prompts, removedIDs: [...new Set(removedIDs)].sort() });
  return `edition-${digest(Buffer.from(content)).slice(0, 16)}`;
}
export function verifyCatalog(manifest: Manifest, bytes: Buffer): Catalog {
  manifestSchema.parse(manifest);
  if (digest(bytes) !== manifest.sha256) throw new Error("Catalog checksum mismatch");
  const catalog = catalogSchema.parse(JSON.parse(bytes.toString()));
  if (catalog.version !== manifest.version || catalog.prompts.length !== manifest.count) throw new Error("Catalog metadata mismatch");
  return catalog;
}
export async function remoteCatalog(manifest: Manifest) {
  manifestSchema.parse(manifest);
  return verifyCatalog(manifest, (await download(manifest.catalog, ["api.prompix.dev"], 20_000_000, { "Cache-Control": "no-cache" })).bytes);
}
export async function currentManifest() {
  return manifestSchema.parse(JSON.parse((await download(`${base}/v1/latest.json`, ["api.prompix.dev"], 100_000, { "Cache-Control": "no-cache" })).bytes.toString()));
}
export function rollbackCatalog(target: Catalog, removedIDs: string[], now = new Date().toISOString()): Catalog {
  const removed = [...new Set([...(target.removedIDs ?? []), ...removedIDs])].sort();
  const prompts = target.prompts.filter(p => !removed.includes(p.id));
  const version = `rollback-${digest(Buffer.from(JSON.stringify({ prompts, removedIDs: removed }))).slice(0, 16)}`;
  return catalogSchema.parse({ schemaVersion: 1, version, publishedAt: now, prompts, removedIDs: removed });
}
export const moderationSchema = z.object({ removedIDs: z.array(z.string().regex(/^[a-z0-9-]+$/)), history: z.array(z.unknown()).optional() });
