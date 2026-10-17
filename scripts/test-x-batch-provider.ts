import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomic, json, lockContent, contentRoot, repo } from "../ingest/publication.ts";
import { readAllXIntake } from "../ingest/x-thread-intake.ts";
import { readXAvailability } from "../ingest/x-availability.ts";
import { readXExcerptReviews } from "../ingest/x-excerpts.ts";
import { pilotIdentity, pilotSample } from "../ingest/x-pilot.ts";
import { TweetAPIPilotClient, inspectTweetAPILookup } from "../ingest/tweetapi-pilot.ts";
import { configuredXSpendBudget } from "../ingest/x-spend.ts";

process.umask(0o077);
const args = process.argv.slice(2), fetchEnabled = args.length === 1 && args[0] === "--fetch";
const replay = args.length === 2 && args[0] === "--replay" ? resolve(args[1]) : undefined;
if (args.length && !fetchEnabled && !replay) throw new Error("Usage: test:x-batch-provider [--fetch | --replay <directory>]");
const output = resolve(process.env.PROMPIX_X_BATCH_PILOT_DIR ?? join(homedir(), ".local/share/prompix/tweetapi-pilot"));
await mkdir(output, { recursive: true, mode: 0o700 });
for (const parent of [await realpath(repo), await realpath(contentRoot)]) {
  const location = relative(parent, await realpath(output));
  if (!location || (location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location)))
    throw new Error("Pilot evidence must be outside repository and production content");
}
const unlock = await lockContent(output);
try {
  // A plan and its source baseline are frozen even during the dry run.
  const directory = replay ?? join(output, new Date().toISOString().slice(0, 10));
  if (replay && relative(output, await realpath(replay)) !== replay.split(sep).at(-1))
    throw new Error("Replay must be an existing direct child of the pilot output");
  const path = join(directory, "plan.json");
  let saved = await json<any>(path, null);
  if (!saved) {
    if (replay) throw new Error("Missing frozen pilot plan");
    const intake = await readAllXIntake(contentRoot), availability = await readXAvailability(contentRoot);
    const negatives = Object.entries(availability).filter(([, record]) => record.removed && record.checkedBy !== "twitterapi")
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, 5).map(([id, record]) => ({ id: id.slice(7), checkedAt: record.checkedAt }));
    const removed = new Set(Object.entries(availability).filter(([, record]) => record.removed).map(([id]) => id));
    const sample = pilotSample(intake.candidates.filter(item => !removed.has(item.id)), 200 - negatives.length);
    if (!sample.ids.length) throw new Error("No official baseline for a batch pilot");
    const ids = [...sample.ids, ...negatives.map(item => item.id)];
    const plan = { version: 1, provider: "tweetapi", createdAt: new Date().toISOString(), sample,
      excerpts: await readXExcerptReviews(contentRoot), negatives,
      requests: [{ name: "controls", ids: [...sample.ids.slice(0, 3), ...negatives.map(item => item.id)] }, { name: "batch", ids }] };
    saved = { plan, digest: pilotIdentity(plan) }; await atomic(path, saved);
  }
  if (saved.digest !== pilotIdentity(saved.plan) || saved.plan.provider !== "tweetapi") throw new Error("Frozen pilot plan changed");
  const plan = saved.plan;
  if (!fetchEnabled && !replay) {
    console.log(JSON.stringify({ state: "planned", directory, sourceIDs: plan.requests[1].ids.length,
      negativeControls: plan.negatives.length, calls: plan.requests.length, maximumAccountedUSD: plan.requests.length * 0.0005, productionSwitchAllowed: false }));
  } else {
    const budget = fetchEnabled ? configuredXSpendBudget() : undefined;
    if (fetchEnabled && !budget) throw new Error("Pilot requires the existing shared X spend configuration");
    const client = fetchEnabled ? new TweetAPIPilotClient(process.env.TWEETAPI_KEY ?? "", budget!) : undefined;
    const requests = [];
    for (const request of plan.requests) {
      const attemptPath = join(directory, `${request.name}.json`), rawPath = join(directory, `${request.name}.raw.json`);
      const previous = await json<any>(attemptPath, null), captured = await json<any>(rawPath, null);
      if (previous && previous.planDigest !== saved.digest) throw new Error("Pilot attempt belongs to another plan");
      if (captured) {
        if (!previous || captured.planDigest !== saved.digest || captured.digest !== pilotIdentity(captured.raw)) throw new Error("Pilot raw evidence changed");
        requests.push({ name: request.name, at: captured.at, replayed: true, ...inspectTweetAPILookup(captured.raw, request.ids) });
        continue;
      }
      if (previous) throw new Error("Existing attempt has no captured response; no paid retry allowed");
      if (!client) throw new Error("Offline replay cannot fetch missing evidence");
      await atomic(attemptPath, { planDigest: saved.digest, state: "reserved", at: new Date().toISOString() });
      try {
        // Trial is10requests/minute. Wait before every call, including a resumed run.
        await delay(6500);
        const result = await client.lookup(request.ids, raw => atomic(rawPath, { planDigest: saved.digest,
          at: new Date().toISOString(), digest: pilotIdentity(raw), raw }));
        const record = { name: request.name, planDigest: saved.digest, state: "completed", at: new Date().toISOString(), ...result.inspection };
        await atomic(attemptPath, record); requests.push(record);
      } catch {
        await atomic(attemptPath, { planDigest: saved.digest, state: "failed", at: new Date().toISOString() });
        throw new Error(`TweetAPI ${request.name} pilot failed; inspect evidence without another paid call`);
      }
    }
    const report = { at: new Date().toISOString(), directory, requests, productionSwitchAllowed: false,
      remaining: ["full source and attribution comparison", "full gallery/video/reply dependencies", "negative-control diagnosis", "actual unit debit", "multi-run reliability"] };
    await atomic(join(directory, "capture-report.json"), report); console.log(JSON.stringify(report));
  }
} finally { await unlock(); }
