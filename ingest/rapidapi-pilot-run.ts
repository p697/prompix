import { join } from "node:path";
import { z } from "zod";
import { atomic, json, writeImmutableBytes } from "./publication.ts";
import { pilotIdentity } from "./x-pilot.ts";
import { inspectRapidAPILookup, type RapidAPIPilotClient } from "./rapidapi-pilot.ts";

const id = z.string().regex(/^\d{1,19}$/);
const ids = z.array(id).min(1).max(200).refine(values => new Set(values).size === values.length);
export const rapidAPICapturePlanSchema = z.object({
  version: z.literal(1), provider: z.literal("rapidapi-twitter241"), baselineSHA256: z.string().regex(/^[a-f0-9]{64}$/),
  baselineDigest: z.string().regex(/^[a-f0-9]{64}$/), negativeIDs: ids,
  requests: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/), ids,
    afterHours: z.number().int().min(0).max(24) }).strict()).min(1).max(8),
}).strict().refine(plan => new Set(plan.requests.map(r => r.name)).size === plan.requests.length &&
  plan.requests.every(r => plan.negativeIDs.every(id => r.ids.includes(id)) && r.ids.some(id => !plan.negativeIDs.includes(id))));
export type RapidAPICapturePlan = z.infer<typeof rapidAPICapturePlanSchema>;
const captureSchema = z.object({ status: z.number().int(), quota: z.record(z.string(), z.string().nullable()),
  bytes: z.number().int().nonnegative().max(16_000_000), body: z.string() }).strict();
const envelopeSchema = z.object({ planDigest: z.string(), at: z.iso.datetime(), digest: z.string(), capture: captureSchema }).strict();

export async function immutablePilotJSON(path: string, value: unknown) {
  await writeImmutableBytes(path, Buffer.from(JSON.stringify(value, null, 2) + "\n"));
}

/** Replays only captured bytes. Identity agreement is a prerequisite, not a
 * source-integrity, availability, billing, or production acceptance result. */
export async function replayRapidAPIRequest(root: string, plan: RapidAPICapturePlan, name: string) {
  const request = plan.requests.find(r => r.name === name);
  if (!request) throw new Error("Unknown RapidAPI pilot request");
  const attempt = await json<{ planDigest: string } | null>(join(root, `${name}.attempt.json`), null);
  const envelope = envelopeSchema.parse(await json(join(root, `${name}.raw.json`), null));
  if (!attempt || attempt.planDigest !== pilotIdentity(plan) || envelope.planDigest !== attempt.planDigest ||
      envelope.digest !== pilotIdentity(envelope.capture) || Buffer.byteLength(envelope.capture.body) !== envelope.capture.bytes)
    throw new Error("RapidAPI pilot evidence changed");
  if (envelope.capture.status !== 200) throw new Error(`RapidAPI captured HTTP ${envelope.capture.status}; do not retry`);
  const inspection = inspectRapidAPILookup(JSON.parse(envelope.capture.body), request.ids);
  const missingPositiveIDs = inspection.missingIDs.filter(id => !plan.negativeIDs.includes(id));
  const returnedNegativeIDs = inspection.returnedIDs.filter(id => plan.negativeIDs.includes(id));
  const remaining = envelope.capture.quota["x-ratelimit-requests-remaining"];
  return { name, at: envelope.at, ...inspection, missingPositiveIDs, returnedNegativeIDs,
    identityControlsPassed: !missingPositiveIDs.length && !returnedNegativeIDs.length,
    quotaExhausted: remaining !== null && remaining !== undefined && /^\d+$/.test(remaining) && Number(remaining) === 0,
    quota: envelope.capture.quota };
}

/** Caller holds the evidence-directory lock. Attempts are immutable, including
 * crashes without captures. Re-running an existing capture never calls HTTP. */
export async function runRapidAPIRequest(root: string, plan: RapidAPICapturePlan, name: string,
  client: RapidAPIPilotClient, confirmedAt: string, now = new Date()) {
  rapidAPICapturePlanSchema.parse(plan);
  const index = plan.requests.findIndex(r => r.name === name);
  if (index < 0) throw new Error("Unknown RapidAPI pilot request");
  const request = plan.requests[index], digest = pilotIdentity(plan);
  if (await json(join(root, `${name}.raw.json`), null)) return replayRapidAPIRequest(root, plan, name);
  if (await json(join(root, `${name}.attempt.json`), null))
    throw new Error("Existing RapidAPI attempt has no captured response; no paid retry allowed");
  const elapsed = now.getTime() - Date.parse(z.iso.datetime().parse(confirmedAt));
  if (elapsed < request.afterHours * 3600_000 || elapsed >= 72 * 3600_000)
    throw new Error("RapidAPI request is outside its planned time window");
  for (const previous of plan.requests.slice(0, index)) {
    const result = await replayRapidAPIRequest(root, plan, previous.name);
    if (!result.identityControlsPassed || result.quotaExhausted)
      throw new Error("RapidAPI earlier controls or quota require investigation; no expansion allowed");
  }
  await immutablePilotJSON(join(root, `${name}.attempt.json`), { planDigest: digest, at: now.toISOString() });
  // No catch/retry: either raw evidence is reusable or the immutable attempt blocks another charge.
  await client.lookup(request.ids, async capture => {
    const validated = captureSchema.parse(capture);
    await immutablePilotJSON(join(root, `${name}.raw.json`), { planDigest: digest,
      at: new Date().toISOString(), digest: pilotIdentity(validated), capture: validated });
  });
  const report = await replayRapidAPIRequest(root, plan, name);
  await atomic(join(root, `${name}.report.json`), report);
  return report;
}
