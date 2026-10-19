/** Restore metadata from retained exact media evidence; never collect or call a model. */
import { isAbsolute, join } from "node:path";
import { atomic, contentRoot } from "../ingest/publication.ts";
import { withDailyStatus } from "../ingest/daily-status.ts";
import { historyPublicationRun } from "../ingest/history-publication.ts";
import { adoptHistoryVisualEvidence } from "../ingest/history-visual-evidence.ts";
import { applyVisualPresentation } from "../ingest/visual-review.ts";
import { prepareDailyStaging, publishDailyCatalog, readPublicationHold } from "../ingest/daily-publication.ts";
import { languagePackEditionVersion } from "../ingest/release-publication.ts";
import { preservePublicationInput } from "../services/feed/publication.ts";
process.umask(0o077);
const campaign = process.argv[2];
if (!campaign || !isAbsolute(campaign) || process.argv.length !== 3) throw new Error("Usage: repair-history-presentation /absolute/campaign-root");
const run = await historyPublicationRun(contentRoot, campaign);
const report = { startedAt: new Date().toISOString(), published: false, changed: 0, total: 0, version: "" };
await withDailyStatus(contentRoot, report, async () => {
  if (await readPublicationHold(contentRoot)) throw new Error("Publication is held");
  const prepared = await prepareDailyStaging(contentRoot);
  if (!prepared.previous?.database) throw new Error("Initialized database required");
  const previous = prepared.previous.authoritative;
  const cache = await adoptHistoryVisualEvidence(campaign, contentRoot, run, previous.prompts);
  const prompts = applyVisualPresentation(previous.prompts, cache);
  if (prompts.some(p => p.presentation === "explicit")) throw new Error("Explicit evidence found; use removal publication instead");
  report.changed = prompts.filter((p, i) => p.presentation !== previous.prompts[i].presentation).length;
  report.total = prompts.length;
  if (report.changed) {
    const catalog = preservePublicationInput({ ...previous, prompts, publishedAt: new Date().toISOString(),
      version: languagePackEditionVersion(prompts, previous.removedIDs ?? []) });
    const result = await publishDailyCatalog(contentRoot, catalog, prepared);
    report.published = true; report.version = result.authoritative.version;
  }
  await atomic(join(campaign, "presentation-repair-report.json"), report);
});
