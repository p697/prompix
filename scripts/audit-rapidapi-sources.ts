import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { atomic, contentRoot, json, lockContent, repo } from "../ingest/publication.ts";
import { rapidAPICapturePlanSchema, replayRapidAPIRequest } from "../ingest/rapidapi-pilot-run.ts";
import { parseRapidAPISources } from "../ingest/rapidapi-sources.ts";
import { comparePilotExtraction, comparePilotSources, pilotIdentity } from "../ingest/x-pilot.ts";
import { unchangedXStandalone } from "../ingest/x-recheck.ts";
import { nativeXPostIDs } from "../ingest/x-source.ts";
import type { Candidate } from "../ingest/sources.ts";

process.umask(0o077);
const [directory, name, ...extra] = process.argv.slice(2);
if (!directory || !name || extra.length) throw new Error("Usage: audit-rapidapi-sources <external-pilot-directory> <capture-name>");
const root = await realpath(resolve(directory));
for (const parent of [await realpath(repo), await realpath(contentRoot)]) {
  const location = relative(parent, root);
  if (!location || (location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location)))
    throw new Error("Pilot evidence must be outside repository and production content");
}
const unlock = await lockContent(root);
try {
  const stored = await json<{ plan: unknown; digest: string }>(join(root, "capture-plan.json"), { plan: null, digest: "" });
  const plan = rapidAPICapturePlanSchema.parse(stored.plan);
  if (pilotIdentity(plan) !== stored.digest) throw new Error("Capture plan changed");
  const identity = await replayRapidAPIRequest(root, plan, name);
  const preflight = z.object({ sourceSnapshot: z.object({ path: z.string(), sha256: z.string(), originalPlanDigest: z.string() }) })
    .parse(await json(join(root, "preflight-plan.json"), null));
  const baselineBytes = await readFile(preflight.sourceSnapshot.path), baseline = JSON.parse(baselineBytes.toString());
  if (createHash("sha256").update(baselineBytes).digest("hex") !== plan.baselineSHA256 ||
      preflight.sourceSnapshot.sha256 !== plan.baselineSHA256 || baseline.digest !== plan.baselineDigest ||
      preflight.sourceSnapshot.originalPlanDigest !== baseline.digest || pilotIdentity(baseline.plan) !== baseline.digest)
    throw new Error("Official baseline changed");
  const request = plan.requests.find(r => r.name === name)!;
  const envelope = await json<any>(join(root, `${name}.raw.json`), null);
  const result = parseRapidAPISources(JSON.parse(envelope.capture.body), request.ids);
  const candidates: Candidate[] = baseline.plan.sample.candidates.filter((item: Candidate) => nativeXPostIDs(item).every(id => request.ids.includes(id)));
  const sources = comparePilotSources(candidates, result);
  const extraction = comparePilotExtraction(candidates, result, identity.at, baseline.plan.excerpts);
  const strict = candidates.map(item => {
    const eligible = !item.source.context && !!item.source.post && !item.source.post.parentID && !item.source.mediaPostID;
    const posts = result.posts.filter(post => post.id === item.source.post?.id);
    const single = { posts, creators: result.creators.filter(c => posts.some(p => p.author_id === c.externalID)),
      media: result.media.filter(m => posts.some(p => p.attachments?.media_keys?.includes(m.media_key))) };
    return { id: item.id, eligible, matched: eligible && unchangedXStandalone(item, single, identity.at, baseline.plan.excerpts) };
  });
  const issueCounts = Object.fromEntries([...new Set(sources.flatMap(s => s.issues.map(i => i.split(":")[0])))].map(issue =>
    [issue, sources.filter(s => s.issues.some(i => i.startsWith(`${issue}:`))).length]));
  const summary = { name, capturedAt: identity.at, requested: request.ids.length, returned: result.posts.length,
    identityControlsPassed: identity.identityControlsPassed, unknownIDs: result.unknownIDs,
    expectedNegatives: plan.negativeIDs, candidates: candidates.length, matchedSources: sources.filter(s => s.matched).length,
    extracted: extraction.filter(s => s.matched).length, strictEligible: strict.filter(s => s.eligible).length,
    strictMatched: strict.filter(s => s.matched).length, issueCounts,
    coverage: { longText: sources.filter(s => s.longText).length, galleries: sources.filter(s => s.gallery).length,
      threads: sources.filter(s => s.thread).length, video: sources.filter(s => s.kind === "video").length },
    productionSwitchAllowed: false, note: "Offline evidence only. Differences require diagnosis; no source freshness or publication is changed." };
  await atomic(join(root, `${name}.source-audit.json`), { summary, sources, extraction, strict });
  console.log(JSON.stringify(summary));
} finally { await unlock(); }
