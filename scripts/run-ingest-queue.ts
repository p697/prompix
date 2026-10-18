import { historyBaseline } from "../ingest/history-cohort.ts";
import { readFile } from "node:fs/promises";
import { StageQueue, queueStages, workStage } from "../ingest/stage-queue.ts";
import { withPublisherDatabase } from "../ingest/database-publication.ts";
import { enqueueHistoryPipeline, exportQueueReady, processHistoryStage } from "../ingest/history-queue.ts";
import { atomic } from "../ingest/publication.ts";
import { join } from "node:path";
import type { TransactionalDatabase } from "../services/feed/database.ts";

const [command, root, shared, run, argument, baselinePath] = process.argv.slice(2);
if (!root || !shared || !run || !["enqueue", "drain", "status", "export"].includes(command)) throw new Error("Usage: run-ingest-queue enqueue|drain|status|export ROOT SHARED RUN [MANIFEST|MAX_JOBS]");
// Each short transaction has a separate TLS-verified connection; model waits never hold a connection.
const db: TransactionalDatabase = { query: (sql, params) => withPublisherDatabase(db => db.query(sql, params)), transaction: op => withPublisherDatabase(db => db.transaction(op)) };
const queue = new StageQueue(db);
if (command === "enqueue") {
  if (!argument || !baselinePath) throw new Error("Explicit manifest and frozen baseline required; this command never discovers new leads");
  await enqueueHistoryPipeline(queue, root, run, JSON.parse(await readFile(argument, "utf8")), historyBaseline(JSON.parse(await readFile(baselinePath, "utf8"))).prompts);
} else if (command === "drain") {
  const max = Number(argument ?? "10");
  if (!Number.isInteger(max) || max < 1 || max > 500) throw new Error("Invalid bounded worker limit");
  for (let i = 0; i < max; i++) {
    try { if (!await workStage(queue, run, [...queueStages], job => processHistoryStage(queue, root, shared, job))) break; }
    catch (error) { console.error(JSON.stringify({ isolated: true, error: error instanceof Error ? error.message : "Stage failed" })); }
  }
} else if (command === "export") {
  const ready = await exportQueueReady(queue, root, shared, run);
  await atomic(join(root, run, "ready.json"), ready);
  console.log(JSON.stringify({ ready: ready.length, published: 0 }));
}
console.log(JSON.stringify(await queue.counts(run)));
