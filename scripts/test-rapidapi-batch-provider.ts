import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { contentRoot, json, lockContent, repo } from "../ingest/publication.ts";
import { pilotIdentity } from "../ingest/x-pilot.ts";
import { RapidAPIPilotClient } from "../ingest/rapidapi-pilot.ts";
import { immutablePilotJSON, rapidAPICapturePlanSchema, replayRapidAPIRequest, runRapidAPIRequest } from "../ingest/rapidapi-pilot-run.ts";
import { configuredXSpendBudget } from "../ingest/x-spend.ts";

process.umask(0o077);
const [directory, command, name, ...extra] = process.argv.slice(2);
if (!directory || !["prepare", "reserve-fee", "confirm-fee", "fetch", "replay"].includes(command) || extra.length ||
    ((command === "fetch" || command === "replay") !== !!name))
  throw new Error("Usage: test:x-rapidapi-provider <existing-external-directory> prepare|reserve-fee|confirm-fee|fetch <name>|replay <name>");
const root = await realpath(resolve(directory));
for (const parent of [await realpath(repo), await realpath(contentRoot)]) {
  const location = relative(parent, root);
  if (!location || (location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location)))
    throw new Error("Pilot evidence must be outside repository and production content");
}
const unlock = await lockContent(root);
try {
  const preflight = z.object({ provider: z.literal("rapidapi-twitter241"), sourceSnapshot: z.object({ path: z.string(),
    sha256: z.string(), originalPlanDigest: z.string() }), baselineIDs: z.array(z.string()).length(197),
    negativeControls: z.array(z.object({ id: z.string() })).length(3),
    userApproval: z.object({ amountUSD: z.literal(1) }) }).parse(await json(join(root, "preflight-plan.json"), null));
  const baselineBytes = await readFile(preflight.sourceSnapshot.path), baseline = JSON.parse(baselineBytes.toString());
  if (createHash("sha256").update(baselineBytes).digest("hex") !== preflight.sourceSnapshot.sha256 ||
      baseline.digest !== preflight.sourceSnapshot.originalPlanDigest || baseline.digest !== pilotIdentity(baseline.plan) ||
      pilotIdentity(baseline.plan.sample.ids) !== pilotIdentity(preflight.baselineIDs) ||
      pilotIdentity(baseline.plan.negatives.map((n: { id: string }) => n.id)) !== pilotIdentity(preflight.negativeControls.map(n => n.id)))
    throw new Error("Frozen official baseline changed");
  const negativeIDs = preflight.negativeControls.map(n => n.id);
  const batch = (size: number) => [...preflight.baselineIDs.slice(0, size - negativeIDs.length), ...negativeIDs];
  const plan = rapidAPICapturePlanSchema.parse({ version: 1, provider: "rapidapi-twitter241",
    baselineSHA256: preflight.sourceSnapshot.sha256, baselineDigest: baseline.digest, negativeIDs,
    requests: [{ name: "controls", ids: batch(8), afterHours: 0 }, { name: "batch50", ids: batch(50), afterHours: 0 },
      { name: "batch100", ids: batch(100), afterHours: 0 }, { name: "batch200", ids: batch(200), afterHours: 0 },
      { name: "repeat200-a", ids: batch(200), afterHours: 12 }, { name: "repeat200-b", ids: batch(200), afterHours: 24 }] });
  const digest = pilotIdentity(plan);
  if (command === "prepare") {
    await immutablePilotJSON(join(root, "capture-plan.json"), { plan, digest });
    console.log(JSON.stringify({ state: "prepared", plannedRequests: plan.requests.length, maximumRequests: 8, fixedFeeUSD: 1,
      productionSwitchAllowed: false }));
  } else {
    const stored = await json<{ digest: string; plan: unknown } | null>(join(root, "capture-plan.json"), null);
    if (!stored || stored.digest !== digest || pilotIdentity(stored.plan) !== digest) throw new Error("Missing or changed capture plan; prepare first");
    const budget = command === "replay" ? undefined : configuredXSpendBudget();
    if (command !== "replay" && !budget) throw new Error("Existing shared X spend configuration is required");
    if (command === "reserve-fee") {
      const existing = await json(join(root, "fee.json"), null);
      const fee = existing ? z.object({ planDigest: z.literal(digest), reservationID: z.string().uuid(), amountUSD: z.literal(1) }).parse(existing)
        : { planDigest: digest, reservationID: (await budget!.reserve("rapidapi", "subscription", `rapidapi:first-month:${digest}`, 1)).id, amountUSD: 1 };
      // Never create a renewal when the same directory is revisited in another month.
      await immutablePilotJSON(join(root, "fee.json"), fee);
      console.log(JSON.stringify({ state: "fee-reservation-recorded-payment-separate", amountUSD: 1, reservationID: fee.reservationID }));
    } else if (command === "confirm-fee") {
      // Run ONLY after verifying the actual $1 payment receipt. This command does not pay or renew.
      const fee = z.object({ planDigest: z.literal(digest), reservationID: z.string().uuid(), amountUSD: z.literal(1) })
        .parse(await json(join(root, "fee.json"), null));
      await budget!.confirmRapidAPIPilotFee(fee.reservationID);
      const previous = await json<{ planDigest: string; reservationID: string; confirmedAt: string } | null>(join(root, "receipt.json"), null);
      if (previous && (previous.planDigest !== digest || previous.reservationID !== fee.reservationID)) throw new Error("Pilot receipt changed");
      await immutablePilotJSON(join(root, "receipt.json"), previous ?? { planDigest: digest, reservationID: fee.reservationID, confirmedAt: new Date().toISOString() });
      console.log(JSON.stringify({ state: "fee-confirmed", amountUSD: 1 }));
    } else if (command === "replay") {
      console.log(JSON.stringify(await replayRapidAPIRequest(root, plan, name)));
    } else {
      const receipt = z.object({ planDigest: z.literal(digest), confirmedAt: z.iso.datetime() }).parse(await json(join(root, "receipt.json"), null));
      const client = new RapidAPIPilotClient(process.env.RAPIDAPI_KEY ?? "", budget!);
      console.log(JSON.stringify(await runRapidAPIRequest(root, plan, name, client, receipt.confirmedAt)));
    }
  }
} finally { await unlock(); }
