import { mkdir, realpath } from "node:fs/promises";
import { join, relative, resolve, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";
import { atomic, contentRoot, lockContent, repo, json } from "../ingest/publication.ts";
import { readAllXIntake } from "../ingest/x-thread-intake.ts";
import { xFeeds } from "../ingest/x-feed.ts";
import { TwitterAPIClient, type TwitterAPIResult } from "../ingest/twitterapi.ts";
import { XSpendBudget } from "../ingest/x-spend.ts";
import { pilotSample, comparePilotSources, pilotIdentity } from "../ingest/x-pilot.ts";

const enabled = process.argv.includes("--fetch");
if (process.argv.slice(2).some(arg => arg !== "--fetch")) throw new Error("Usage: npm run test:x-provider -- [--fetch]");
const output = resolve(process.env.PROMPIX_X_PILOT_DIR ?? join(homedir(), ".local/share/prompix/x-pilot"));
await mkdir(output, { recursive: true, mode: 0o700 });
const repository = await realpath(repo), source = await realpath(contentRoot), target = await realpath(output);
for (const parent of [repository, source]) {
  const location = relative(parent, target);
  if (!location || (location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location)))
    throw new Error("Pilot output must be outside repository and production content");
}
const unlock = await lockContent(output);
try {
  const { candidates } = await readAllXIntake(contentRoot);
  const sample = pilotSample(candidates);
  const queryPlan = [...xFeeds.map(feed => ({ id: feed.id, query: feed.query })),
    ...["2026-07", "2026-08"].map((month, index) => ({ id: `history-${month}`,
      query: `${xFeeds[0].query} since:${month}-01 until:2026-${String(index + 8).padStart(2, "0")}-01` }))];
  const day = new Date().toISOString().slice(0, 10);
  const plan = { version: 1, ids: sample.ids, queries: queryPlan, comparison: "cached-official-sources", maxSearchPages: 2 };
  const planID = pilotIdentity(plan);
  const directory = join(output, day, planID);
  await atomic(join(directory, "plan.json"), { ...plan, planID });
  if (!enabled) {
    console.log(JSON.stringify({ status: "dry-run", output: directory, knownPosts: sample.ids.length, queries: queryPlan.length,
      maxThirdPartyUSD: Number(((sample.ids.length + queryPlan.length * 40) * 0.00015).toFixed(5)) }));
  } else {
    const client = new TwitterAPIClient(process.env.TWITTERAPI_IO_KEY ?? "", new XSpendBudget(
      process.env.PROMPIX_X_SPEND_DIR ?? join(homedir(), ".local/share/prompix/x-spend"), 20, 0.25));
    const checks: unknown[] = [], searches: unknown[] = [];
    const activePath = join(output, day, "active-plan.json");
    const active = await json<{ planID: string } | null>(activePath, null);
    if (active && active.planID !== planID) throw new Error("Today's paid pilot plan changed; inspect the existing evidence before starting another plan");
    await atomic(activePath, { planID });
    const run = async (name: string, call: (capture: (raw: unknown) => Promise<void>) => Promise<{ raw: unknown; result: TwitterAPIResult }>) => {
      const path = join(directory, `${name}.json`);
      const previous = await json<any>(path, null);
      if (previous?.planID === planID) {
        if (previous.state !== "completed") throw new Error(`Pilot ${name} has an unresolved attempt; inspect it before retrying`);
        return previous;
      }
      await atomic(path, { planID, state: "reserved", startedAt: new Date().toISOString() });
      const started = performance.now();
      try {
        const result = await call(raw => atomic(join(directory, `${name}.raw.json`), { capturedAt: new Date().toISOString(), raw }));
        const record = { planID, state: "completed", capturedAt: new Date().toISOString(), elapsedMS: Math.round(performance.now() - started), ...result };
        await atomic(path, record); return record;
      } catch (error) {
        await atomic(path, { planID, state: "failed", message: error instanceof Error ? error.message.replaceAll(process.env.TWITTERAPI_IO_KEY ?? "__missing__", "[redacted]").slice(0, 500) : "Failed" });
        throw error;
      }
    };
    if (sample.ids.length) {
      const lookup = await run("lookup", capture => client.lookup(sample.ids, capture));
      checks.push(...comparePilotSources(sample.candidates, lookup.result));
    }
    for (const entry of queryPlan) {
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 1; page <= 2; page++) {
        const captured = await run(`${entry.id}-${page}`, capture => client.search(entry.query, cursor, capture));
        const result = captured.result as TwitterAPIResult;
        const duplicates = result.posts.filter(p => seen.has(p.id)).length;
        result.posts.forEach(p => seen.add(p.id));
        searches.push({ id: entry.id, page, count: result.posts.length, duplicates, elapsedMS: captured.elapsedMS,
          media: result.media.length, hasNextPage: !!result.nextToken, unknown: result.unknownIDs.length });
        cursor = result.nextToken;
        if (!cursor) break;
      }
    }
    const report = { capturedAt: new Date().toISOString(), planID, checks, searches,
      productionSwitchAllowed: false, remaining: ["live official same-window comparison", "deletion/protection/edited-source checks", "multi-run reliability", "provider acquisition and display terms"] };
    await atomic(join(directory, "report.json"), report);
    console.log(JSON.stringify({ output: directory, ...report }));
  }
} finally { await unlock(); }
