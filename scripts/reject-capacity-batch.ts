/** Operator-only terminal disposition; never retries or approves content. */
import { isAbsolute } from "node:path";
import { lockContent } from "../ingest/publication.ts";
import { StageQueue } from "../ingest/stage-queue.ts";
import { queueDatabase } from "../ingest/queue-database.ts";
import { rejectVerifiedCapacityBatch } from "../ingest/history-isolation.ts";
const [root, run, batch] = process.argv.slice(2);
if (!root || !isAbsolute(root) || !run || !batch) throw Error("Usage: reject-capacity-batch /absolute/campaign run batch-NNNN");
process.umask(0o077);
const unlock = await lockContent(root);
try { console.log(JSON.stringify(await rejectVerifiedCapacityBatch(new StageQueue(queueDatabase()), root, run, batch))); }
finally { await unlock(); }
