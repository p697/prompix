import { adoptHistoryPublicationChecks } from "./history-publication-checks.ts";
import { adoptHistoryVisualEvidence } from "./history-visual-evidence.ts";
import { publicationHistoryInventory } from "./history-publication-inventory.ts";
import { readHistoryAllowance } from "./history-allowance.ts";
import { historyPublicationSources } from "./history-publication-sources.ts";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { Prompt } from "../packages/schema/catalog.ts";
import { preservePublicationInput } from "../services/feed/publication.ts";
import { atomic, json, moderationSchema, upload } from "./publication.ts";
import { beginDailyPublication, publishDailyCatalog } from "./daily-publication.ts";
import { languagePackEditionVersion, type PublishedState } from "./release-publication.ts";
import { applyQualityHolds, readQualityHolds, registerQualityHoldScope } from "./quality-holds.ts";
import { uniqueHistoryItems } from "./history-cohort.ts";
import { withPublisherDatabase } from "./database-publication.ts";
import { limitNewPublications } from "./publication-quota.ts";
import { adoptFreshXDiscoveries, filterXAvailability } from "./x-availability.ts";
import { mirrorCreatorAvatars } from "./creators.ts";
import { publishAvatar } from "./creator-images.ts";

export async function historyPublicationRun(shared: string, campaign: string) {
  if (!isAbsolute(campaign)) throw new Error("History campaign root must be absolute");
  const config = z.object({ run: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), sharedRoot: z.string() })
    .parse(await json(join(campaign, "configuration.json"), null));
  if (config.sharedRoot !== shared) throw new Error("Campaign and publisher roots differ");
  return config.run;
}

export interface HistoryPublicationReport {
  startedAt: string;
  published: boolean;
  status?: "held" | "recovered" | "deferred" | "published";
  verifiedReady?: number;
  uniqueUnpublished?: number;
  unavailable?: number;
  selected?: number;
  publishedTotal?: number;
  version?: string;
  quota?: Awaited<ReturnType<typeof limitNewPublications>>["report"];
  avatarErrors?: string[];
}
const dependencies = {
  begin: beginDailyPublication,
  sources: historyPublicationSources,
  ready: publicationHistoryInventory,
  evidence: adoptHistoryVisualEvidence,
  limit: async (items: Prompt[]) => { const historical = await readHistoryAllowance(); return withPublisherDatabase(db => limitNewPublications(db, items, new Date(), historical)); },
  publish: publishDailyCatalog,
  mirror: async (items: Prompt[], shared: string, errors: string[]) => {
    const cache = await json<Record<string, string>>(join(shared, "media-map.json"), {});
    const pending = new Map<string, Promise<string>>();
    let persisted = Promise.resolve(), next = 0;
    const result: Prompt[] = new Array(items.length);
    // Bound avatar IO independently of models. Serialize cache writes and reuse
    // one in-flight request per URL, preserving order and the optional-avatar policy.
    const worker = async () => {
      while (next < items.length) {
        const index = next++;
        [result[index]] = await mirrorCreatorAvatars([items[index]], url => {
          if (!pending.has(url)) pending.set(url, (async () => {
            const mirrored = await publishAvatar(url, shared, cache, upload);
            persisted = persisted.then(() => atomic(join(shared, "media-map.json"), cache));
            await persisted; return mirrored;
          })());
          return pending.get(url)!;
        }, (id, error) => errors.push(`${id}: ${String(error)}`));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
    return result;
  },
};

/** Caller owns shared daily.lock. No collector, model request or source recheck is invoked.
 * The immutable queue is reread, never trusted via a cached exported count. Pending releases
 * recover before new work; shared activation preserves its existing quota and rollback rules. */
export async function publishQualifiedHistory(shared: string, campaign: string, run: string,
  report: HistoryPublicationReport, overrides: Partial<typeof dependencies> = {}) {
  const io = { ...dependencies, ...overrides };
  await registerQualityHoldScope(shared, campaign);
  const preparation = await io.begin(shared, { resumePublishing: false });
  const finished = (state: PublishedState, status: "recovered" | "published") => {
    report.status = status; report.published = true;
    report.publishedTotal = state.authoritative.prompts.length; report.version = state.authoritative.version;
  };
  if (preparation.recovered) { finished(preparation.recovered, "recovered"); return; }
  if (preparation.held !== undefined) { report.status = "held"; return; }
  if (!preparation.previous?.database) throw new Error("Historical publication requires the initialized database publisher");
  const previous = preparation.previous.authoritative;
  const ready = await io.ready(campaign, shared, run);
  report.verifiedReady = ready.length;
  await io.evidence(campaign, shared, run, [...previous.prompts, ...ready]);
  const moderation = moderationSchema.parse(await json(join(shared, "moderation.json"), { removedIDs: [] }));
  const removedIDs = [...new Set([...(previous.removedIDs ?? []), ...moderation.removedIDs])].sort();
  const holds = await readQualityHolds(shared);
  const candidates = uniqueHistoryItems(applyQualityHolds(ready, holds).prompts.filter(p => !removedIDs.includes(p.id)), previous.prompts);
  report.uniqueUnpublished = candidates.length;
  const sources = await io.sources(campaign, run, candidates);
  const checks = await adoptHistoryPublicationChecks(campaign, shared, sources.candidates);
  const availability = await adoptFreshXDiscoveries(shared, sources.candidates, checks.state);
  const visible = filterXAvailability(candidates, availability.state);
  report.unavailable = visible.withheldIDs.length;
  // Keep the original source/translation bytes. Availability was checked above and
  // stage/activation recheck the shared record; its timestamp is not an edit to the source.
  const visibleIDs = new Set(visible.prompts.map(p => p.id));
  const quota = await io.limit(candidates.filter(p => visibleIDs.has(p.id)));
  report.quota = quota.report; report.selected = quota.prompts.length;
  const retained = applyQualityHolds(previous.prompts, holds).prompts.filter(p => !removedIDs.includes(p.id));
  if (!quota.prompts.length && retained.length === previous.prompts.length) { report.status = "deferred"; return; }
  await sources.persist(shared, quota.prompts);
  report.avatarErrors = [];
  const additions = await io.mirror(quota.prompts, shared, report.avatarErrors);
  const prompts = [...retained, ...additions];
  const catalog = preservePublicationInput({ schemaVersion: 1, version: languagePackEditionVersion(prompts, removedIDs),
    publishedAt: new Date().toISOString(), removedIDs, prompts });
  const result = await io.publish(shared, catalog, preparation);
  finished(result, "published");
  return result;
}
