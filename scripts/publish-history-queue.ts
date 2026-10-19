/** Drain verified history through the normal publication quota, independently of collection. */
import { isAbsolute, join } from "node:path";
import { contentRoot, atomic } from "../ingest/publication.ts";
import { withDailyStatus } from "../ingest/daily-status.ts";
import { historyPublicationRun, publishQualifiedHistory, type HistoryPublicationReport } from "../ingest/history-publication.ts";
process.umask(0o077);
const campaign = process.argv[2];
if (!campaign || !isAbsolute(campaign) || process.argv.length !== 3) throw new Error("Usage: publish-history-queue /absolute/campaign-root");
const run = await historyPublicationRun(contentRoot, campaign);
const report: HistoryPublicationReport = { startedAt: new Date().toISOString(), published: false };
await withDailyStatus(contentRoot, report, async () => {
  await publishQualifiedHistory(contentRoot, campaign, run, report);
  await atomic(join(campaign, "publication-report.json"), report);
});
