import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { atomic, contentRoot, lockContent, repo } from "../ingest/publication.ts";
import { stageXLeadQueue, acquireXLeadQueue } from "../ingest/x-lead-queue.ts";
import { configuredXSpendBudget } from "../ingest/x-spend.ts";

process.umask(0o077);
const args = process.argv.slice(2);
const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const scope = value("--scope") ?? "history";
if (!["live", "history"].includes(scope)) throw new Error("Invalid acquisition scope");
const lane = scope as "live" | "history", directory = value("--directory"), acquire = args.includes("--acquire");
const maxPosts = Number(value("--max-posts") ?? 0);
// Backfill can use at most 60 additional originals per day; live discovery retains its independent 40 slots.
if (!Number.isInteger(maxPosts) || maxPosts < 0 || maxPosts > (lane === "history" ? 60 : 40)) throw new Error("Invalid acquisition limit");
if (acquire && (!maxPosts || (process.env.PROMPIX_X_DISCOVERY_PROVIDER === "third-party" ? !process.env.TWITTERAPI_IO_KEY : !process.env.X_BEARER_TOKEN) || !configuredXSpendBudget()))
  throw new Error("Acquisition requires explicit --max-posts, source credentials and the shared dollar budget");
if (directory) {
  const rel = relative(await realpath(repo), await realpath(resolve(directory)));
  if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("Search evidence must remain outside Git");
}
const unlock = await lockContent(contentRoot);
try {
  const stage = directory ? await stageXLeadQueue(contentRoot, [{ directory: resolve(directory), lane }]) : undefined;
  const admission = await acquireXLeadQueue(contentRoot, { enabled: acquire, bearer: process.env.X_BEARER_TOKEN,
    lane, maxPosts });
  const report = { at: new Date().toISOString(), stage, admission, published: false };
  await atomic(join(contentRoot, "x-lead-queue-operation.json"), report);
  console.log(JSON.stringify(report));
} finally { await unlock(); }
