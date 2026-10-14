import { join } from "node:path";
import { z } from "zod";
import type { Catalog } from "../packages/schema/catalog.ts";
import { atomic, json, moderationSchema } from "./publication.ts";
import { defaultReleaseTransport, PendingRemovalsError, publicationIdentity, readPublicationTarget, type PublicationHooks } from "./release-publication.ts";

export async function verifyRecoveryMedia(catalog: Catalog) {
  const urls = new Set(catalog.prompts.flatMap(p => [p.media?.imageURL, p.media?.videoURL, ...(p.media?.imageURLs ?? [])]).filter((url): url is string => !!url));
  for (const url of urls) {
    z.string().regex(/^https:\/\/api\.prompix\.dev\/media\/[a-f0-9]{64}\.(jpg|mp4)$/).parse(url);
    const response = await fetch(url, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(15000) });
    if (response.status !== 200 || Number(response.headers.get("content-length")) <= 0) throw new Error("Rollback media is unavailable");
  }
}

/** Shared by explicit rollback and daily recovery of an interrupted rollback. Caller owns daily.lock. */
export function recoveryPublicationHooks(root: string, verifyMedia: typeof verifyRecoveryMedia = verifyRecoveryMedia, transport = defaultReleaseTransport): PublicationHooks {
  return {
    async beforeActivation(intent) {
      if (intent.operation !== "rollback") throw new Error("Rollback hold hook requires a rollback intent");
      const catalog = await readPublicationTarget(root, intent, transport);
      // Resumption can happen long after the initial media check; verify again before activation.
      await verifyMedia(catalog);
      const moderation = moderationSchema.parse(await json(join(root, "moderation.json"), { removedIDs: [] }));
      const removed = new Set(catalog.removedIDs ?? []);
      // A new local removal must be included in the immutable target before either pointer changes.
      if (moderation.removedIDs.some(id => !removed.has(id))) throw new PendingRemovalsError();
      moderation.removedIDs = [...removed].sort();
      await atomic(join(root, "moderation.json"), moderation);
      const path = join(root, "publication-hold.json"), existing = await json<unknown>(path, null);
      // Any existing hold already blocks automatic publishing. Preserve its identity,
      // including a newer operator hold written after an interrupted activation.
      if (existing !== null) return;
      await atomic(path, { reason: "rollback", version: catalog.version, previous: intent.observed,
        targetPointers: { v1: publicationIdentity(intent.targets.v1), v2: publicationIdentity(intent.targets.v2) },
        createdAt: new Date().toISOString() });
    },
  };
}
