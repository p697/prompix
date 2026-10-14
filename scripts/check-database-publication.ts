import assert from "node:assert/strict";
import { contentRoot, lockContent } from "../ingest/publication.ts";
import { prepareDailyStaging } from "../ingest/daily-publication.ts";
import { defaultReleaseTransport, languagePackEditionVersion, publicationIdentity, readPublicationTarget, stageRelease } from "../ingest/release-publication.ts";
import { configuredDatabasePublisher } from "../ingest/database-publication.ts";

/** Explicit migration preflight: no collection, paid models, pointer activation or mode changes. */
const unlock = await lockContent(contentRoot);
try {
  const transport = { ...defaultReleaseTransport, database: configuredDatabasePublisher() };
  const preparation = await prepareDailyStaging(contentRoot, process.env, transport), previous = preparation.previous!;
  if (!previous.database || !previous.v2) throw new Error("Both verified database and v2 baselines are required");
  // First cutover must compare the entire legacy source, never just its first page.
  assert.equal(publicationIdentity(previous.authoritative.prompts), publicationIdentity(previous.v2.catalog.prompts), "Database does not match the current full legacy library");
  assert.deepEqual([...(previous.authoritative.removedIDs ?? [])].sort(), [...(previous.v2.catalog.removedIDs ?? [])].sort());
  const catalog = { ...previous.authoritative, publishedAt: previous.v2.catalog.publishedAt,
    version: languagePackEditionVersion(previous.authoritative.prompts, previous.authoritative.removedIDs ?? []) };
  const staged = await stageRelease(contentRoot, catalog, previous, transport);
  assert.equal(staged.database!.release, previous.database.release, "Staging changed the verified content identity");
  assert.equal(publicationIdentity(staged.targets.v2), publicationIdentity(previous.v2.manifest), "Compatibility projection changed the active legacy manifest");
  const retained = await readPublicationTarget(contentRoot, staged, transport);
  assert.equal(publicationIdentity(retained.prompts), publicationIdentity(catalog.prompts));
  assert.deepEqual(await transport.database.pointer(), previous.database, "Preflight changed the database pointer");
  console.log(JSON.stringify({ verified: true, activated: false, release: previous.database.release,
    generation: previous.database.generation, items: retained.prompts.length,
    translations: retained.prompts.reduce((count, item) => count + Object.keys(item.localization?.translations ?? {}).length, 0),
    legacyVersion: previous.v2.manifest.version, compatibilityCount: staged.targets.v2.count }));
} finally { await unlock(); }
