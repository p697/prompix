import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { catalogSchema } from "../packages/schema/catalog.ts";
import { atomic, json, base, lockContent, upload, manifestSchema, digest, remoteCatalog, currentManifest, rollbackCatalog, moderationSchema } from "./publication.ts";

export interface RecoveryTransport {
  currentManifest: typeof currentManifest;
  remoteCatalog: typeof remoteCatalog;
  upload: typeof upload;
  verifyMedia: typeof verifyMedia;
}
async function verifyMedia(catalog: import("../packages/schema/catalog.ts").Catalog) {
  const urls = new Set(catalog.prompts.flatMap(p => [p.media?.imageURL, p.media?.videoURL, ...(p.media?.imageURLs ?? [])]).filter((url): url is string => !!url));
  for (const url of urls) {
    z.string().regex(/^https:\/\/api\.prompix\.dev\/media\/[a-f0-9]{64}\.(jpg|mp4)$/).parse(url);
    const response = await fetch(url, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(15000) });
    if (response.status !== 200 || Number(response.headers.get("content-length")) <= 0) throw new Error("Rollback media is unavailable");
  }
}
export async function recoverRelease(root: string, version: string, publishing: boolean, transport: RecoveryTransport = { currentManifest, remoteCatalog, upload, verifyMedia }) {
  z.string().regex(/^(edition|rollback)-[a-f0-9]{16}$/).parse(version);
  const unlock = await lockContent(root);
  const report: Record<string, unknown> = { target: version, startedAt: new Date().toISOString(), published: false };
  try {
    const before = await transport.currentManifest();
    const current = await transport.remoteCatalog(before);
    const targetManifest = manifestSchema.parse(await json(join(root, "releases", version, "manifest.json"), null));
    if (targetManifest.version !== version) throw new Error("Target version mismatch");
    const target = await transport.remoteCatalog(targetManifest);
    const moderation = moderationSchema.parse(await json(join(root, "moderation.json"), { removedIDs: [] }));
    const catalog = rollbackCatalog(target, [...(current.removedIDs ?? []), ...moderation.removedIDs]);
    const release = join(root, "releases", catalog.version);
    const catalogPath = join(release, "catalog.json");
    const existing = await json<unknown | null>(catalogPath, null);
    if (existing) {
      const stored = catalogSchema.parse(existing);
      if (stored.version !== catalog.version || JSON.stringify(stored.prompts) !== JSON.stringify(catalog.prompts) || JSON.stringify(stored.removedIDs) !== JSON.stringify(catalog.removedIDs))
        throw new Error("Existing rollback version has different content");
    } else await atomic(catalogPath, catalog);
    const bytes = await readFile(catalogPath);
    const stored = catalogSchema.parse(JSON.parse(bytes.toString()));
    const manifest = manifestSchema.parse({ schemaVersion: 1, version: stored.version, publishedAt: stored.publishedAt, count: stored.prompts.length, sha256: digest(bytes), catalog: `${base}/releases/${stored.version}/catalog.json` });
    const manifestPath = join(release, "manifest.json");
    await atomic(manifestPath, manifest);
    Object.assign(report, { from: before.version, version: stored.version, count: stored.prompts.length, removedIDs: stored.removedIDs });
    if (!publishing) return;
    // Fail before changing latest if the older release has missing remote previews.
    await transport.verifyMedia(stored);
    await transport.upload(`releases/${stored.version}/catalog.json`, catalogPath, "application/json");
    await transport.remoteCatalog(manifest);
    const active = await transport.currentManifest();
    if (active.version !== before.version || active.sha256 !== before.sha256) throw new Error("Active edition changed during rollback");
    // Persist removals and the hold before activation, including on an ambiguous upload response.
    moderation.removedIDs = stored.removedIDs ?? [];
    await atomic(join(root, "moderation.json"), moderation);
    await atomic(join(root, "publication-hold.json"), { reason: "rollback", version: stored.version, previous: before.version, createdAt: new Date().toISOString() });
    await transport.upload("v1/latest.json", manifestPath, "application/json");
    const verified = await transport.currentManifest();
    if (verified.version !== manifest.version || verified.sha256 !== manifest.sha256) throw new Error("Rollback activation verification failed; publication remains held");
    await atomic(join(root, "latest.json"), manifest);
    report.published = true;
  } catch (error) { report.error = String(error); throw error; }
  finally {
    try {
      report.finishedAt = new Date().toISOString();
      await atomic(join(root, "rollback-status.json"), report);
      await atomic(join(root, "operations", `rollback-${Date.now()}.json`), report);
      console.log(JSON.stringify(report));
    } finally { await unlock(); }
  }
}
