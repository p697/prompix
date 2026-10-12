import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Catalog } from "../packages/schema/catalog.ts";
import { verifyLanguagePackManifest } from "./language-packs.ts";
import { atomic, base, editionVersion, json, moderationSchema } from "./publication.ts";
import { recoveryPublicationHooks } from "./recovery-publication.ts";
import {
  assertPublicationReconciled, defaultReleaseTransport, loadPublicationState, publicationIdentity,
  PendingRemovalsError, preserveCatalogText, preservedRollbackCatalog, publishRelease, readLocalRelease, readPublishedState, resumePublication, stageRelease,
  type PublicationIntent, type PublishedState, type ReleaseTransport,
} from "./release-publication.ts";

const holdPath = (root: string) => join(root, "publication-hold.json");
export const readPublicationHold = (root: string) => json<unknown | null>(holdPath(root), null);

/** A disabled bootstrap flag must never move an initialized publisher back to v1. */
export async function languagePackPublishingEnabled(root: string, env: NodeJS.ProcessEnv = process.env, transport = defaultReleaseTransport): Promise<boolean> {
  const state = await loadPublicationState(root);
  if (env.PROMPIX_LANGUAGE_PACKS_ENABLED === "true" || state.v2Initialized || state.pending) return true;
  // Also recover the authoritative channel after a lost local state file.
  const result = await transport.read(`${base}/v2/latest.json`, 32_000);
  if (result.status === 404) return false;
  verifyLanguagePackManifest(result.bytes);
  return true;
}

/** Called only under daily.lock, after successful remote activation. */
export async function clearMatchingPublicationHold(root: string, intent: Pick<PublicationIntent, "holdToClear">): Promise<void> {
  if (!intent.holdToClear) return;
  const hold = await readPublicationHold(root);
  if (hold === null) return; // The prior attempt may have cleared it before final state persistence.
  if (publicationIdentity(hold) !== intent.holdToClear) throw new Error("Publication hold changed; refusing to clear a different hold");
  await rm(holdPath(root), { force: true });
}

export interface DailyPublication {
  enabled: boolean;
  previous?: PublishedState;
  recovered?: PublishedState;
  held?: unknown;
  holdToClear?: string;
}

/** Read a complete baseline for staging without resuming or activating retained work. */
export async function prepareDailyStaging(root: string, env: NodeJS.ProcessEnv = process.env, transport = defaultReleaseTransport): Promise<DailyPublication> {
  const enabled = await languagePackPublishingEnabled(root, env, transport);
  if (!enabled) return { enabled };
  const previous = await readPublishedState(root, { allowBootstrap: true }, transport);
  if (previous.state.pending) throw new Error("Resume or roll back the pending publication before staging another edition");
  return { enabled, previous };
}

async function beforeDailyActivation(root: string, intent: PublicationIntent): Promise<void> {
  const hold = await readPublicationHold(root);
  if (hold !== null && publicationIdentity(hold) !== intent.holdToClear) throw new Error("Publication hold changed before activation");
  const moderation = moderationSchema.parse(await json(join(root, "moderation.json"), { removedIDs: [] }));
  const target = await readLocalRelease(root, intent.targets.v2.version, intent.targets.v2);
  if (moderation.removedIDs.some(id => !(target.removedIDs ?? []).includes(id))) throw new PendingRemovalsError();
}

/** Run before collection, paid preparation or media work while holding daily.lock. */
export async function beginDailyPublication(root: string, options: { resumePublishing: boolean; env?: NodeJS.ProcessEnv }, transport: ReleaseTransport = defaultReleaseTransport): Promise<DailyPublication> {
  const enabled = await languagePackPublishingEnabled(root, options.env, transport);
  const hold = await readPublicationHold(root);
  const state = await loadPublicationState(root);
  if (hold !== null && !options.resumePublishing && !state.pending) return { enabled, held: hold };
  if (!enabled) return { enabled, ...(hold !== null ? { holdToClear: publicationIdentity(hold) } : {}) };

  const previous = await readPublishedState(root, { allowBootstrap: true }, transport);
  const moderation = moderationSchema.parse(await json(join(root, "moderation.json"), { removedIDs: [] }));
  const pending = previous.state.pending;
  if (pending) {
    assertPublicationReconciled(pending, previous.observed);
    // An unrelated new hold is not permission to finish an ordinary pending release.
    if (pending.operation !== "rollback" && hold !== null && publicationIdentity(hold) !== pending.holdToClear)
      return { enabled, previous, held: hold };
    const target = await readLocalRelease(root, pending.targets.v2.version, pending.targets.v2);
    const requiredRemovedIDs = [...new Set([
      ...moderation.removedIDs, ...(previous.v1.catalog.removedIDs ?? []),
      ...(previous.v2?.catalog.removedIDs ?? []), ...(target.removedIDs ?? []),
    ])].sort();
    const hooks = {
      requiredRemovedIDs,
      beforeActivation: pending.operation === "rollback" ? recoveryPublicationHooks(root).beforeActivation
        : (intent: PublicationIntent) => beforeDailyActivation(root, intent),
      afterActivation: (intent: PublicationIntent) => clearMatchingPublicationHold(root, intent),
    };
    let recovered: PublishedState;
    if (requiredRemovedIDs.some(id => !(target.removedIDs ?? []).includes(id))) {
      // Keep every already-prepared source/translation; apply only newer tombstones.
      const prompts = target.prompts.filter(item => !requiredRemovedIDs.includes(item.id));
      const corrected = pending.operation === "rollback" ? preservedRollbackCatalog(target, requiredRemovedIDs) : preserveCatalogText({
        ...target, version: editionVersion(prompts, requiredRemovedIDs), publishedAt: new Date().toISOString(),
        prompts, removedIDs: requiredRemovedIDs,
      });
      const staged = await stageRelease(root, corrected, previous);
      recovered = await publishRelease(root, staged, previous.observed, {
        ...hooks, operation: pending.operation, holdToClear: pending.holdToClear, supersedePending: true,
      }, transport);
    } else {
      recovered = (await resumePublication(root, hooks, transport))!;
    }
    // Resume exactly the retained work and stop this run; no new paid batches.
    const remainingHold = await readPublicationHold(root);
    return { enabled, previous, recovered, ...(remainingHold !== null ? { held: remainingHold } : {}) };
  }
  moderation.removedIDs = [...new Set([
    ...moderation.removedIDs, ...(previous.v1.catalog.removedIDs ?? []), ...(previous.v2?.catalog.removedIDs ?? []),
  ])].sort();
  await atomic(join(root, "moderation.json"), moderation);
  return { enabled, previous, ...(hold !== null ? { holdToClear: publicationIdentity(hold) } : {}) };
}

export async function publishDailyCatalog(root: string, catalog: Catalog, preparation: DailyPublication, transport = defaultReleaseTransport): Promise<PublishedState> {
  if (!preparation.enabled || !preparation.previous || preparation.held !== undefined || preparation.recovered)
    throw new Error("Daily publication has no prepared v2 baseline");
  const currentHold = await readPublicationHold(root);
  if (currentHold !== null && publicationIdentity(currentHold) !== preparation.holdToClear)
    throw new Error("Publication hold changed during preparation");
  const moderation = moderationSchema.parse(await json(join(root, "moderation.json"), { removedIDs: [] }));
  const staged = await stageRelease(root, catalog, preparation.previous);
  return publishRelease(root, staged, preparation.previous.observed, {
    operation: preparation.holdToClear ? "resume" : "daily", holdToClear: preparation.holdToClear,
    requiredRemovedIDs: moderation.removedIDs,
    beforeActivation: intent => beforeDailyActivation(root, intent),
    afterActivation: intent => clearMatchingPublicationHold(root, intent),
  }, transport);
}
