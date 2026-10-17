import { mkdir, realpath } from "node:fs/promises";
import { join, relative, resolve, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { atomic, contentRoot, lockContent, repo, json } from "../ingest/publication.ts";
import { readAllXIntake } from "../ingest/x-thread-intake.ts";
import { xFeeds } from "../ingest/x-feed.ts";
import { TwitterAPIClient, parseTwitterAPI, type TwitterAPIResult } from "../ingest/twitterapi.ts";
import { XSpendBudget } from "../ingest/x-spend.ts";
import { pilotSample, comparePilotSources, comparePilotExtraction, pilotIdentity, auditPilotSearch } from "../ingest/x-pilot.ts";
import { readXExcerptReviews } from "../ingest/x-excerpts.ts";

const args = process.argv.slice(2);
const enabled = args.length === 1 && args[0] === "--fetch";
const replay = args.length === 2 && args[0] === "--replay" ? resolve(args[1]) : undefined;
if (args.length && !enabled && !replay) throw new Error("Usage: npm run test:x-provider -- [--fetch | --replay <plan-directory>]");
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
  let sample = pilotSample(candidates);
  let excerpts = await readXExcerptReviews(contentRoot);
  let baselineKind = "frozen-at-start";
  let queryPlan = [...xFeeds.map(feed => ({ id: feed.id, query: feed.query })),
    ...["2026-07", "2026-08"].map((month, index) => ({ id: `history-${month}`,
      query: `${xFeeds[0].query} since:${month}-01 until:2026-${String(index + 8).padStart(2, "0")}-01` }))];
  const day = new Date().toISOString().slice(0, 10);
  let plan = { version: 1, ids: sample.ids, queries: queryPlan, comparison: "cached-official-sources", maxSearchPages: 2 };
  let planID = pilotIdentity(plan);
  let directory = join(output, day, planID);
  if (replay) {
    const location = relative(output, await realpath(replay));
    if (!/^\d{4}-\d{2}-\d{2}[/\\][a-f0-9]{64}$/.test(location)) throw new Error("Replay must name an existing pilot plan inside the external output root");
    const saved = await json<any>(join(replay, "plan.json"), null);
    const { planID: savedID, ...savedPlan } = saved ?? {};
    if (pilotIdentity(savedPlan) !== savedID) throw new Error("Pilot plan checksum mismatch");
    plan = savedPlan; planID = savedID; directory = replay; queryPlan = plan.queries;
    // Legacy pilot evidence predates frozen baselines. Identify that limitation explicitly.
    const oldReport = await json<any>(join(directory, "report.json"), null);
    const selected = new Set<string>(oldReport?.checks?.map((check: any) => check.id) ?? []);
    sample = { ids: plan.ids, candidates: candidates.filter(item => selected.has(item.id)) };
    if (sample.candidates.length !== selected.size) throw new Error("Legacy replay baseline is incomplete");
    baselineKind = "current-revision-of-original-sample";
  }
  const baselinePath = join(directory, "baseline.json");
  const baseline = await json<any>(baselinePath, null);
  if (baseline) {
    if (baseline.planID !== planID || baseline.digest !== pilotIdentity([baseline.sample, baseline.excerpts])) throw new Error("Pilot baseline checksum mismatch");
    sample = baseline.sample; excerpts = baseline.excerpts; baselineKind = baseline.kind;
  } else if (enabled) {
    await atomic(baselinePath, { planID, kind: baselineKind, sample, excerpts, digest: pilotIdentity([sample, excerpts]) });
  }
  await atomic(join(directory, "plan.json"), { ...plan, planID });
  if (!enabled && !replay) {
    console.log(JSON.stringify({ status: "dry-run", output: directory, knownPosts: sample.ids.length, queries: queryPlan.length,
      maxThirdPartyUSD: Number(((sample.ids.length + queryPlan.length * 40) * 0.00015).toFixed(5)) }));
  } else {
    const client = enabled ? new TwitterAPIClient(process.env.TWITTERAPI_IO_KEY ?? "", new XSpendBudget(
      process.env.PROMPIX_X_SPEND_DIR ?? join(homedir(), ".local/share/prompix/x-spend"), 20, 0.25)) : undefined;
    const checks: unknown[] = [], searches: unknown[] = [], extraction: unknown[] = [];
    const activePath = join(output, day, "active-plan.json");
    const active = await json<{ planID: string } | null>(activePath, null);
    if (enabled && active && active.planID !== planID) throw new Error("Today's paid pilot plan changed; inspect the existing evidence before starting another plan");
    if (enabled) await atomic(activePath, { planID });
    let lastRequestAt = 0;
    const run = async (name: string, call: (capture: (raw: unknown) => Promise<void>) => Promise<{ raw: unknown; result: TwitterAPIResult }>,
      parse: (raw: unknown) => TwitterAPIResult) => {
      const path = join(directory, `${name}.json`);
      const previous = await json<any>(path, null);
      if (previous?.planID === planID) {
        if (previous.state === "completed") return { ...previous, result: parse(previous.raw) };
        // Replay successful HTTP evidence after a parser repair; never pay to reacquire it.
        const saved = await json<any>(join(directory, `${name}.raw.json`), null);
        if (previous.state === "failed" && saved?.raw) {
          const record = { planID, state: "completed", capturedAt: saved.capturedAt, elapsedMS: previous.elapsedMS ?? null,
            raw: saved.raw, result: parse(saved.raw), replayed: true, previousAttempt: previous };
          await atomic(path, record); return record;
        }
        throw new Error(`Pilot ${name} has an unresolved attempt; inspect it before retrying`);
      }
      if (!enabled) throw new Error(`Offline replay has no completed evidence for ${name}`);
      await atomic(path, { planID, state: "reserved", startedAt: new Date().toISOString() });
      const started = performance.now();
      try {
        // Never-paid accounts allow 0.2 QPS; do not burn trial credit on rate-limit retries.
        await delay(Math.max(0, 6500 - (Date.now() - lastRequestAt)));
        const result = await call(raw => atomic(join(directory, `${name}.raw.json`), { capturedAt: new Date().toISOString(), raw }));
        lastRequestAt = Date.now();
        const record = { planID, state: "completed", capturedAt: new Date().toISOString(), elapsedMS: Math.round(performance.now() - started), ...result };
        await atomic(path, record); return record;
      } catch (error) {
        await atomic(path, { planID, state: "failed", elapsedMS: Math.round(performance.now() - started), message: error instanceof Error ? error.message.replaceAll(process.env.TWITTERAPI_IO_KEY ?? "__missing__", "[redacted]").slice(0, 500) : "Failed" });
        throw error;
      }
    };
    if (sample.ids.length) {
      const lookup = await run("lookup", capture => client!.lookup(sample.ids, capture), raw => parseTwitterAPI(raw, { ids: sample.ids }));
      checks.push(...comparePilotSources(sample.candidates, lookup.result));
      extraction.push(...comparePilotExtraction(sample.candidates, lookup.result, lookup.capturedAt, excerpts));
    }
    for (const entry of queryPlan) {
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 1; page <= 2; page++) {
        const captured = await run(`${entry.id}-${page}`, capture => client!.search(entry.query, cursor, capture), raw => {
          const result = parseTwitterAPI(raw, { search: true });
          if (cursor && result.nextToken === cursor) throw new Error("TwitterAPI pagination did not advance");
          return result;
        });
        const result = captured.result as TwitterAPIResult;
        const duplicates = result.posts.filter(p => seen.has(p.id)).length;
        result.posts.forEach(p => seen.add(p.id));
        searches.push({ id: entry.id, page, count: result.posts.length, duplicates, elapsedMS: captured.elapsedMS,
          queryIssues: auditPilotSearch(entry.query, result),
          media: result.media.length, hasNextPage: !!result.nextToken, unknown: result.unknownIDs.length });
        cursor = result.nextToken;
        if (!cursor) break;
      }
    }
    const report = { capturedAt: new Date().toISOString(), planID, baselineKind, checks, extraction, searches,
      productionSwitchAllowed: false, remaining: ["live official same-window comparison", "deletion/protection/edited-source checks", "multi-run reliability", "provider acquisition and display terms"] };
    await atomic(join(directory, "report.json"), report);
    console.log(JSON.stringify({ output: directory, ...report }));
  }
} finally { await unlock(); }
