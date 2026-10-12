import { join } from "node:path";
import { z } from "zod";
import { atomic, json, base, lockContent, upload, manifestSchema, digest, remoteCatalog, currentManifest, rollbackCatalog, moderationSchema, writeCatalog } from "./publication.ts";
import { assertPublicationReconciled, defaultReleaseTransport, loadPublicationState, preservedRollbackCatalog, publishRelease, readLocalRelease,
  readPublishedState, resumePublication, stageRelease, type ReleaseTransport } from "./release-publication.ts";
import { languagePackPublishingEnabled } from "./daily-publication.ts";
import { recoveryPublicationHooks, verifyRecoveryMedia as verifyMedia } from "./recovery-publication.ts";

export interface RecoveryTransport {
  currentManifest: typeof currentManifest;
  remoteCatalog: typeof remoteCatalog;
  upload: typeof upload;
  verifyMedia: typeof verifyMedia;
}
const defaultRecoveryTransport: RecoveryTransport = { currentManifest, remoteCatalog, upload, verifyMedia };

async function recoverLanguagePackRelease(root: string, version: string, publishing: boolean, transport: RecoveryTransport,
  releaseTransport: ReleaseTransport, report: Record<string, unknown>) {
  const previous = await readPublishedState(root, { allowBootstrap: true }, releaseTransport);
  const pending = previous.state.pending;
  if (pending) assertPublicationReconciled(pending, previous.observed);
  const target = await readLocalRelease(root, version);
  const pendingTarget = pending ? await readLocalRelease(root, pending.targets.v2.version, pending.targets.v2) : null;
  const moderation = moderationSchema.parse(await json(join(root, "moderation.json"), { removedIDs: [] }));
  const catalog = preservedRollbackCatalog(target, [...(previous.v1.catalog.removedIDs ?? []), ...(previous.v2?.catalog.removedIDs ?? []),
    ...(pendingTarget?.removedIDs ?? []), ...moderation.removedIDs]);
  const sameIntent = pending?.operation === "rollback" && pending.targets.v2.version === catalog.version;
  const staged = sameIntent ? { targets: pending.targets, freezeV1: pending.freezeV1 } : await stageRelease(root, catalog, previous);
  const stored = await readLocalRelease(root, staged.targets.v2.version, staged.targets.v2);
  Object.assign(report, { from: { v1: previous.v1.manifest.version, v2: previous.v2?.manifest.version ?? null },
    version: stored.version, count: stored.prompts.length, removedIDs: stored.removedIDs, channels: { v1: staged.targets.v1.version, v2: staged.targets.v2.version } });
  if (!publishing) return;
  await transport.verifyMedia(stored);
  const hooks = { ...recoveryPublicationHooks(root, transport.verifyMedia), requiredRemovedIDs: stored.removedIDs ?? [] };
  const published = sameIntent ? await resumePublication(root, hooks, releaseTransport)
    : await publishRelease(root, staged, previous.observed, { ...hooks, operation: "rollback", supersedePending: true }, releaseTransport);
  if (!published) throw new Error("Rollback intent disappeared before activation");
  report.published = true;
  report.channels = { v1: published.v1.manifest.version, v2: published.v2?.manifest.version ?? null };
}

export async function recoverRelease(root: string, version: string, publishing: boolean, transport: RecoveryTransport = defaultRecoveryTransport,
  releaseTransport?: ReleaseTransport, env: NodeJS.ProcessEnv = process.env) {
  z.string().regex(/^(edition|rollback)-[a-f0-9]{16}$/).parse(version);
  const unlock = await lockContent(root);
  const report: Record<string, unknown> = { target: version, startedAt: new Date().toISOString(), published: false };
  try {
    // Preserve existing injected v1-only transports without creating an implicit production read.
    // Real operations and explicitly injected v2 transports also discover remote initialization.
    const state = await loadPublicationState(root);
    const legacyInjection = transport !== defaultRecoveryTransport && !releaseTransport && env.PROMPIX_LANGUAGE_PACKS_ENABLED !== "true"
      && !state.v2Initialized && !state.pending;
    if (!legacyInjection && await languagePackPublishingEnabled(root, env, releaseTransport ?? defaultReleaseTransport)) {
      await recoverLanguagePackRelease(root, version, publishing, transport, releaseTransport ?? defaultReleaseTransport, report);
      return;
    }
    const before = await transport.currentManifest();
    const current = await transport.remoteCatalog(before);
    const targetManifest = manifestSchema.parse(await json(join(root, "releases", version, "manifest.json"), null));
    if (targetManifest.version !== version) throw new Error("Target version mismatch");
    const target = await transport.remoteCatalog(targetManifest);
    const moderation = moderationSchema.parse(await json(join(root, "moderation.json"), { removedIDs: [] }));
    const catalog = rollbackCatalog(target, [...(current.removedIDs ?? []), ...moderation.removedIDs]);
    const release = join(root, "releases", catalog.version);
    const catalogPath = join(release, "catalog.json");
    // Check actual immutable bytes before media probes, uploads, hold or latest changes.
    const { bytes, catalog: stored } = await writeCatalog(catalogPath, catalog, { reuseExistingPublishedAt: true });
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
