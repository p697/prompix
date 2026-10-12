import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { catalogSchema, localizationLanguages, type Catalog } from "../packages/schema/catalog.ts";
import { languagePackManifestSchema, languagePackManifestByteLimit, languagePackByteLimit, type LanguagePackManifest } from "../packages/schema/language-packs.ts";
import { joinLanguagePacks, splitLanguagePacks, verifyLanguagePackManifest, type LocaleBytes } from "./language-packs.ts";
import { atomic, base, digest, editionVersion, manifestSchema, upload, verifyCatalog, verifyManifest, writeImmutableBytes, type Manifest } from "./publication.ts";
import { readResponseBytes } from "./network.ts";

const versionSchema = z.string().regex(/^[a-z0-9-]+$(?![\s\S])/);
const hashSchema = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const legacyManifestSchema = manifestSchema.safeExtend({ version: versionSchema, sha256: hashSchema }).strict();
const observedSchema = z.object({ v1: hashSchema, v2: hashSchema.nullable() }).strict();
const targetsSchema = z.object({ v1: legacyManifestSchema, v2: languagePackManifestSchema }).strict();
const intentSchema = z.object({
  operation: z.enum(["daily", "rollback", "resume"]), observed: observedSchema, targets: targetsSchema,
  freezeV1: z.boolean(), holdToClear: hashSchema.optional(),
}).strict();
const stateSchema = z.object({ schemaVersion: z.literal(1), v2Initialized: z.boolean(), v1Frozen: z.boolean(), pending: intentSchema.optional() }).strict();
export type PublicationIntent = z.infer<typeof intentSchema>;
export type PublicationState = z.infer<typeof stateSchema>;
export type ObservedPointers = z.infer<typeof observedSchema>;
export type StagedRelease = Pick<PublicationIntent, "targets" | "freezeV1">;
export type ContentRead = { status: 200; bytes: Buffer } | { status: 404 };
export interface ReleaseTransport {
  read(url: string, maximum: number): Promise<ContentRead>;
  upload: typeof upload;
}
export interface PublishedState {
  state: PublicationState;
  v1: { manifest: Manifest; catalog: Catalog };
  v2: { manifest: LanguagePackManifest; catalog: Catalog } | null;
  authoritative: Catalog;
  observed: ObservedPointers;
}
export interface PublicationHooks {
  requiredRemovedIDs?: readonly string[];
  /** Rollbacks require this durable hold callback before any pointer activation. */
  beforeActivation?: (intent: PublicationIntent) => Promise<void>;
  /** Required when holdToClear is present; caller checks that exact hold identity. */
  afterActivation?: (intent: PublicationIntent) => Promise<void>;
}
export interface PublishOptions extends PublicationHooks {
  operation: PublicationIntent["operation"];
  holdToClear?: string;
  /** Explicit rollback or removal-corrected replanning, never an ordinary retry. */
  supersedePending?: boolean;
}
const statePath = (root: string) => join(root, "publication-state.json");
const releasePath = (root: string, version: string) => join(root, "releases", versionSchema.parse(version));
const v1ManifestPath = (root: string, version: string) => join(releasePath(root, version), "manifest.json");
const v2ManifestPath = (root: string, version: string) => join(releasePath(root, version), "v2", "manifest.json");
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => [key, stable(v)]));
  return value;
}
/** Formatting-independent identity, also usable for an authorized hold snapshot. */
export function publicationIdentity(value: unknown): string { return digest(Buffer.from(JSON.stringify(stable(value)))); }
function originalValues(raw: unknown, parsed: unknown): unknown {
  if (Array.isArray(parsed)) return parsed.map((value, index) => originalValues((raw as unknown[])[index], value));
  if (parsed && typeof parsed === "object") return Object.fromEntries(Object.entries(parsed)
    .map(([key, value]) => [key, originalValues((raw as Record<string, unknown>)[key], value)]));
  return raw;
}
function schemaOrderedCatalog(raw: Catalog, parsed = catalogSchema.parse(raw)): Catalog {
  return originalValues(raw, parsed) as Catalog;
}
/** Validate the v2 contract, preserving text and the legacy publisher's schema key order. */
export function preserveCatalogText(input: Catalog): Catalog {
  splitLanguagePacks(input);
  return schemaOrderedCatalog(input);
}
/** V2 rollback keeps source/translation bytes and the existing rollback identity formula. */
export function preservedRollbackCatalog(target: Catalog, removedIDs: readonly string[], now = new Date().toISOString()): Catalog {
  const removed = [...new Set([...(target.removedIDs ?? []), ...removedIDs])].sort();
  const prompts = target.prompts.filter(item => !removed.includes(item.id));
  const version = `rollback-${digest(Buffer.from(JSON.stringify({ prompts, removedIDs: removed }))).slice(0, 16)}`;
  return preserveCatalogText({ schemaVersion: 1, version, publishedAt: now, prompts, removedIDs: removed });
}
function verifyLegacyCatalog(manifest: Manifest, bytes: Buffer): Catalog {
  return schemaOrderedCatalog(JSON.parse(bytes.toString()), verifyCatalog(manifest, bytes));
}
async function localBytes(path: string, maximum: number): Promise<Buffer | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > maximum) throw new Error("Invalid or oversized local publication artifact");
    const bytes = await readFile(path);
    if (bytes.length > maximum) throw new Error("Oversized local publication artifact");
    return bytes;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}
async function requiredLocal(path: string, maximum: number): Promise<Buffer> {
  const bytes = await localBytes(path, maximum);
  if (!bytes) throw new Error("Missing local publication artifact");
  return bytes;
}
/** V2 compatibility snapshots retain source bytes too; the legacy v1 writer is unchanged. */
async function writeCompatibilityCatalog(path: string, input: Catalog) {
  const existing = await localBytes(path, 10_000_000);
  if (existing) {
    const catalog = schemaOrderedCatalog(JSON.parse(existing.toString()));
    if (publicationIdentity(catalog) !== publicationIdentity({ ...input, publishedAt: catalog.publishedAt }))
      throw new Error("Version already exists with different content; use a new version");
    return { bytes: existing, catalog };
  }
  const bytes = Buffer.from(JSON.stringify(input) + "\n");
  if (bytes.length > 10_000_000) throw new Error("Compatibility catalog exceeds the client download limit");
  await writeImmutableBytes(path, bytes);
  return { bytes, catalog: input };
}
export async function loadPublicationState(root: string): Promise<PublicationState> {
  const bytes = await localBytes(statePath(root), 128_000);
  return bytes ? stateSchema.parse(JSON.parse(bytes.toString())) : { schemaVersion: 1, v2Initialized: false, v1Frozen: false };
}
async function saveState(root: string, state: PublicationState) { await atomic(statePath(root), stateSchema.parse(state)); }
export const defaultReleaseTransport: ReleaseTransport = {
  async read(url, maximum) {
    const parsed = new URL(url);
    if (parsed.origin !== base || parsed.username || parsed.password) throw new Error("Untrusted publication URL");
    const response = await fetch(url, { redirect: "error", headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(60_000) });
    if (response.status === 404) { await response.body?.cancel(); return { status: 404 }; }
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`Content HTTP ${response.status}`); }
    return { status: 200, bytes: await readResponseBytes(response, maximum) };
  }, upload,
};
async function remoteBytes(transport: ReleaseTransport, url: string, maximum: number, optional = false): Promise<Buffer | undefined> {
  const result = await transport.read(url, maximum);
  if (result.status === 404) {
    if (optional) return;
    throw new Error("Missing remote publication artifact");
  }
  if (result.bytes.length > maximum) throw new Error("Oversized remote publication artifact");
  return result.bytes;
}
async function readPointers(transport: ReleaseTransport) {
  const v1 = verifyManifest((await remoteBytes(transport, `${base}/v1/latest.json`, 32_000))!);
  const v2Bytes = await remoteBytes(transport, `${base}/v2/latest.json`, languagePackManifestByteLimit, true);
  const v2 = v2Bytes ? verifyLanguagePackManifest(v2Bytes) : null;
  return { v1, v2, observed: { v1: publicationIdentity(v1), v2: v2 ? publicationIdentity(v2) : null } };
}
async function readV2(manifest: LanguagePackManifest, read: (url: string, maximum: number) => Promise<Buffer>): Promise<Catalog> {
  const baseBytes = await read(manifest.base.url, languagePackByteLimit), localeBytes: LocaleBytes = {};
  for (const locale of localizationLanguages) {
    const descriptor = manifest.locales[locale];
    if (descriptor) localeBytes[locale] = await read(descriptor.url, languagePackByteLimit);
  }
  // The codec has validated all raw fields; restore legacy key order without trimming text.
  return schemaOrderedCatalog(joinLanguagePacks(Buffer.from(JSON.stringify(manifest)), baseBytes, localeBytes));
}
export async function readPublishedState(root: string, options: { allowBootstrap?: boolean } = {}, transport = defaultReleaseTransport): Promise<PublishedState> {
  let state = await loadPublicationState(root);
  const pointers = await readPointers(transport);
  if (!pointers.v2 && (state.v2Initialized || !options.allowBootstrap)) throw new Error("V2 latest is missing; refusing legacy fallback");
  const v1 = { manifest: pointers.v1, catalog: verifyLegacyCatalog(pointers.v1, (await remoteBytes(transport, pointers.v1.catalog, 10_000_000))!) };
  const v2 = pointers.v2 ? { manifest: pointers.v2, catalog: await readV2(pointers.v2, async (url, maximum) => (await remoteBytes(transport, url, maximum))!) } : null;
  if (v2 && !state.v2Initialized && !state.pending) {
    // Lost state cannot prove v1 was never frozen, even if channel versions now match.
    // Return a conservative policy after full verification; staging/activation persists it.
    state = { ...state, v2Initialized: true, v1Frozen: true };
  }
  return { state, v1, v2, authoritative: v2?.catalog ?? v1.catalog, observed: pointers.observed };
}
function artifactPath(root: string, url: string): string {
  const path = new URL(url).pathname;
  // This helper receives only already schema-validated release descriptors.
  return join(root, ...path.slice(1).split("/"));
}
export async function readLocalRelease(root: string, version: string, expectedManifest?: LanguagePackManifest): Promise<Catalog> {
  if (expectedManifest && expectedManifest.version !== version) throw new Error("Expected release version mismatch");
  const bytes = await localBytes(v2ManifestPath(root, version), languagePackManifestByteLimit);
  if (bytes) {
    const manifest = verifyLanguagePackManifest(bytes);
    if (manifest.version !== version) throw new Error("Local release version mismatch");
    if (expectedManifest && publicationIdentity(manifest) !== publicationIdentity(expectedManifest)) throw new Error("Pending local manifest mismatch");
    return readV2(manifest, (url, maximum) => requiredLocal(artifactPath(root, url), maximum));
  }
  if (expectedManifest) throw new Error("Missing expected local v2 manifest");
  const manifest = verifyManifest(await requiredLocal(v1ManifestPath(root, version), 32_000));
  if (manifest.version !== version) throw new Error("Local release version mismatch");
  return verifyLegacyCatalog(manifest, await requiredLocal(artifactPath(root, manifest.catalog), 10_000_000));
}
function assertRemovals(catalog: Catalog, required: readonly string[] = []) {
  const removed = new Set(catalog.removedIDs ?? []);
  if (required.some(id => !removed.has(id))) throw new PendingRemovalsError();
}
export class PendingRemovalsError extends Error {
  constructor() { super("New removals require rebuilding the retained pending target without new preparation"); this.name = "PendingRemovalsError"; }
}

/** Caller holds daily.lock. Staging never activates remote pointers or changes publication state. */
export async function stageRelease(root: string, input: Catalog, previous: PublishedState): Promise<StagedRelease> {
  const catalog = preserveCatalogText(input);
  assertRemovals(catalog, [...(previous.v1.catalog.removedIDs ?? []), ...(previous.v2?.catalog.removedIDs ?? [])]);
  // Measure only after full schema validation; arbitrary failures must not freeze v1.
  const fullBytes = Buffer.from(JSON.stringify(catalog) + "\n");
  const freezeV1 = previous.state.v1Frozen || previous.state.pending?.freezeV1 === true || fullBytes.length > 10_000_000;
  let legacy = catalog;
  if (freezeV1) {
    const removedIDs = [...new Set([...(previous.v1.catalog.removedIDs ?? []), ...(catalog.removedIDs ?? [])])].sort();
    const prompts = previous.v1.catalog.prompts.filter(item => !removedIDs.includes(item.id));
    legacy = preserveCatalogText({ schemaVersion: 1, version: editionVersion(prompts, removedIDs), publishedAt: catalog.publishedAt, prompts, removedIDs });
  }
  let v1: Manifest;
  if (publicationIdentity({ prompts: legacy.prompts, removedIDs: legacy.removedIDs ?? [] }) === publicationIdentity({ prompts: previous.v1.catalog.prompts, removedIDs: previous.v1.catalog.removedIDs ?? [] })) {
    v1 = previous.v1.manifest;
    // Retain remote original serialization; readPublishedState has verified it.
    const existing = await localBytes(artifactPath(root, v1.catalog), 10_000_000);
    if (existing) verifyCatalog(v1, existing);
  } else {
    const path = join(releasePath(root, legacy.version), "catalog.json");
    const stored = await writeCompatibilityCatalog(path, legacy);
    v1 = legacyManifestSchema.parse({ schemaVersion: 1, version: stored.catalog.version, publishedAt: stored.catalog.publishedAt,
      count: stored.catalog.prompts.length, sha256: digest(stored.bytes), catalog: `${base}/releases/${stored.catalog.version}/catalog.json` });
    await atomic(v1ManifestPath(root, v1.version), v1);
  }
  const existingManifest = await localBytes(v2ManifestPath(root, catalog.version), languagePackManifestByteLimit);
  const prior = existingManifest ? verifyLanguagePackManifest(existingManifest) : undefined;
  const timestamp = prior?.publishedAt ?? (catalog.version === previous.v2?.manifest.version ? previous.v2.manifest.publishedAt
    : catalog.version === previous.v1.manifest.version ? previous.v1.manifest.publishedAt : catalog.publishedAt);
  const split = splitLanguagePacks({ ...catalog, publishedAt: timestamp });
  if (prior && publicationIdentity(prior) !== publicationIdentity(split.manifest)) throw new Error("Immutable v2 release already exists with different content");
  await writeImmutableBytes(v2ManifestPath(root, catalog.version), existingManifest ?? split.manifestBytes);
  await writeImmutableBytes(artifactPath(root, split.manifest.base.url), split.baseBytes);
  for (const locale of localizationLanguages) if (split.localeBytes[locale])
    await writeImmutableBytes(artifactPath(root, split.manifest.locales[locale]!.url), Buffer.from(split.localeBytes[locale]!));
  await readLocalRelease(root, catalog.version);
  return { targets: { v1, v2: prior ?? split.manifest }, freezeV1 };
}

export function assertPublicationReconciled(intent: PublicationIntent, live: ObservedPointers) {
  for (const channel of ["v1", "v2"] as const) {
    const target = publicationIdentity(intent.targets[channel]);
    if (live[channel] !== intent.observed[channel] && live[channel] !== target) throw new Error(`Publication conflict: ${channel} latest changed`);
  }
}
async function ensureRemoteArtifact(root: string, url: string, maximum: number, transport: ReleaseTransport, expected: (bytes: Buffer) => void) {
  const remote = await remoteBytes(transport, url, maximum, true);
  if (remote) { expected(remote); return; }
  const path = artifactPath(root, url), bytes = await requiredLocal(path, maximum);
  expected(bytes);
  try { await transport.upload(new URL(url).pathname.slice(1), path, "application/json"); }
  catch (error) {
    const recovered = await remoteBytes(transport, url, maximum, true);
    if (!recovered) throw error;
    expected(recovered); return;
  }
  expected((await remoteBytes(transport, url, maximum))!);
}
async function activate(root: string, channel: "v1" | "v2", intent: PublicationIntent, transport: ReleaseTransport) {
  const live = await readPointers(transport); assertPublicationReconciled(intent, live.observed);
  if (channel === "v1" && live.observed.v2 !== publicationIdentity(intent.targets.v2)) throw new Error("V2 activation changed before v1 activation");
  if (live.observed[channel] === publicationIdentity(intent.targets[channel])) return;
  const path = channel === "v1" ? v1ManifestPath(root, intent.targets.v1.version) : v2ManifestPath(root, intent.targets.v2.version);
  let uploadError: unknown;
  try { await transport.upload(`${channel}/latest.json`, path, "application/json"); } catch (error) { uploadError = error; }
  const after = await readPointers(transport); assertPublicationReconciled(intent, after.observed);
  if (after.observed[channel] !== publicationIdentity(intent.targets[channel])) throw uploadError ?? new Error(`${channel} activation verification failed`);
}

/** Finish only the persisted target. No collectors, editorial or translation calls occur here. */
export async function resumePublication(root: string, hooks: PublicationHooks = {}, transport = defaultReleaseTransport): Promise<PublishedState | null> {
  const state = await loadPublicationState(root), intent = state.pending;
  if (!intent) return null;
  const live = await readPointers(transport); assertPublicationReconciled(intent, live.observed);
  const catalog = await readLocalRelease(root, intent.targets.v2.version, intent.targets.v2);
  assertRemovals(catalog, hooks.requiredRemovedIDs);
  const descriptors = [intent.targets.v2.base, ...Object.values(intent.targets.v2.locales)];
  for (const descriptor of descriptors) await ensureRemoteArtifact(root, descriptor.url, languagePackByteLimit, transport, bytes => {
    if (bytes.length !== descriptor.byteCount || digest(bytes) !== descriptor.sha256) throw new Error("Remote immutable artifact conflicts with target");
  });
  await ensureRemoteArtifact(root, intent.targets.v1.catalog, 10_000_000, transport, bytes => { verifyCatalog(intent.targets.v1, bytes); });
  // Reassemble every advertised remote pack before changing either pointer.
  await readV2(intent.targets.v2, async (url, maximum) => (await remoteBytes(transport, url, maximum))!);
  if (intent.operation === "rollback" && !hooks.beforeActivation) throw new Error("Rollback requires a durable hold callback");
  if (intent.holdToClear && !hooks.afterActivation) throw new Error("Resuming held publication requires a hold cleanup callback");
  await hooks.beforeActivation?.(intent);
  await activate(root, "v2", intent, transport);
  await activate(root, "v1", intent, transport);
  const published = await readPublishedState(root, {}, transport);
  if (published.observed.v1 !== publicationIdentity(intent.targets.v1) || published.observed.v2 !== publicationIdentity(intent.targets.v2))
    throw new Error("Publication changed before final verification");
  await atomic(join(root, "latest.json"), intent.targets.v1);
  await atomic(join(root, "v2-latest.json"), intent.targets.v2);
  await hooks.afterActivation?.(intent);
  const completed: PublicationState = { schemaVersion: 1, v2Initialized: true, v1Frozen: state.v1Frozen || intent.freezeV1 };
  await saveState(root, completed);
  return { ...published, state: completed };
}
export async function publishRelease(root: string, staged: StagedRelease, observed: ObservedPointers, options: PublishOptions, transport = defaultReleaseTransport): Promise<PublishedState> {
  const state = await loadPublicationState(root);
  if (state.pending) {
    if (!options.supersedePending) throw new Error("A pending publication must be resumed before new preparation");
    assertPublicationReconciled(state.pending, (await readPointers(transport)).observed);
  }
  const live = await readPointers(transport);
  if (publicationIdentity(live.observed) !== publicationIdentity(observed)) throw new Error("Publication changed during preparation");
  const intent = intentSchema.parse({ ...staged, observed, operation: options.operation, ...(options.holdToClear ? { holdToClear: options.holdToClear } : {}) });
  await saveState(root, { ...state, pending: intent });
  return (await resumePublication(root, options, transport))!;
}
