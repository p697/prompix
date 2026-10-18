import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { z } from "zod";
import { atomic, json } from "./publication.ts";
import { convertXDiscovery, readXIntake } from "./x-intake.ts";
import { readXSearchPlan, type XSearchPlan } from "./x-search-plan.ts";
import { githubRepositoryLink } from "./discovered-skills.ts";
import { thirdPartyOnly, thirdPartySourceLookup, type XSourceLookup } from "./x-third-party.ts";
import { checkXAvailability } from "./x.ts";
import { mergeCreatorCache, type CreatorCache } from "./creators.ts";
import { XBudgetExceeded } from "./x-spend.ts";

/** Search bodies identify leads; selected originals pass separate acquisition and review. */
export async function selectXSearchLeads(directory: string, plan: XSearchPlan) {
  const search = await readXSearchPlan(directory, plan);
  const snapshots = [...search.unique.values()].map(({ result, page }) => ({ name: `${page.response}-${result.posts[0].id}`,
    data: { ...result, capturedAt: page.at } }));
  const intake = convertXDiscovery(snapshots);
  const candidates = new Map(intake.candidates.map(c => [c.source.post!.id, c]));
  const replies = new Set(intake.replyLeads.map(lead => lead.post.id));
  const leads = intake.records.flatMap(record => {
    const candidate = candidates.get(record.postID);
    const kind = candidate?.kind;
    // Permission to inspect a public repository is not permission to mirror its package.
    const skill = record.expandedLinks?.some(link => !!githubRepositoryLink(link));
    const post = search.unique.get(record.postID)?.result.posts[0];
    if (!post || post.referenced_tweets?.length || !record.hasCreatorProfile || !record.authorID) return [];
    const reason: "prompt" | "reply" | "skill-link" | undefined = candidate ? "prompt" : replies.has(record.postID) ? "reply" : skill ? "skill-link" : undefined;
    if (!reason) return [];
    return [{ id: record.postID, authorID: record.authorID, reason, kind: kind ?? null,
      visual: kind === "image" || kind === "video" || kind === "web" || (record.mediaItems ?? 0) > 0,
      sourceDate: post.created_at!, evidence: search.unique.get(record.postID)!.page.response }];
  }).sort((a, b) => Number(b.visual) - Number(a.visual) || Date.parse(b.sourceDate) - Date.parse(a.sourceDate) || a.id.localeCompare(b.id));
  return { leads, report: { ...search.report, candidateLeads: leads.length,
    visualLeads: leads.filter(l => l.visual).length, replyLeads: leads.filter(l => l.reason === "reply").length,
    skillLeads: leads.filter(l => l.reason === "skill-link").length, intakeReasons: intake.report.reasons } };
}
export type XSearchLead = Awaited<ReturnType<typeof selectXSearchLeads>>["leads"][number] & { planID?: string; directory?: string };
export type XAdmissionOptions = {
  enabled: boolean; bearer?: string; maxPosts: number; now?: string; lookup?: XSourceLookup; environment?: NodeJS.ProcessEnv;
  lane?: "live" | "history"; order?: (leads: XSearchLead[]) => XSearchLead[];
};

const id = z.string().regex(/^\d{1,19}$/);
const attemptSchema = z.object({ at: z.iso.datetime(), ids: z.array(id).min(1).max(100),
  state: z.enum(["reserved", "completed", "failed", "budget-blocked"]), lane: z.enum(["live", "history"]).optional(),
  provider: z.enum(["twitterapi", "rapidapi"]).optional(), unknownIDs: z.array(id).optional(),
  accepted: z.array(id).optional(), unavailable: z.array(id).optional() }).strict();
const ledgerSchema = z.array(attemptSchema).max(100);

/** Bounded source acquisition after discovery, before editorial/media gates. */
export async function admitXSearchLeads(root: string, directory: string, plan: XSearchPlan, options: XAdmissionOptions) {
  const selected = await selectXSearchLeads(directory, plan);
  return admitXLeadSelection(root, selected.leads, selected.report.planID, options);
}

/** Caller holds the content lock. All historical attempts remain deduplication evidence across UTC days. */
export async function admitXLeadSelection(root: string, leads: XSearchLead[], planID: string, options: XAdmissionOptions) {
  if (!Number.isInteger(options.maxPosts) || options.maxPosts < 0 || options.maxPosts > 100) throw new Error("Invalid X acquisition limit");
  const now = options.now ?? new Date().toISOString(), day = z.iso.datetime().parse(now).slice(0, 10);
  const lane = options.lane ?? "live";
  const report = { status: "dry-run", requests: 0, acquired: 0, unavailable: 0, known: 0, pending: leads.length, needsInspection: 0 };
  const env = options.environment ?? process.env, thirdParty = thirdPartyOnly(env);
  if (!options.enabled || (!thirdParty && !options.bearer)) return report;
  const ledgerPath = join(root, "x-lead-acquisitions", `${day}.json`);
  const ledger = ledgerSchema.parse(await json(ledgerPath, []));
  if (ledger.some(a => a.state === "reserved" || a.state === "failed")) return { ...report, status: "unresolved" };
  const prior = [] as z.infer<typeof attemptSchema>[];
  let files: string[];
  try { files = await readdir(join(root, "x-lead-acquisitions")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; files = []; }
  for (const file of files.filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name !== `${day}.json`))
    prior.push(...ledgerSchema.parse(await json(join(root, "x-lead-acquisitions", file), null)));
  const uncertain = new Set(prior.filter(a => a.state === "reserved" || a.state === "failed").flatMap(a => a.ids));
  report.needsInspection = leads.filter(lead => uncertain.has(lead.id)).length;
  const intake = await readXIntake(root);
  const known = new Set([...intake.records.filter(r => r.state === "draft").map(r => r.postID),
    ...[...prior, ...ledger].filter(a => a.state !== "budget-blocked").flatMap(a => a.ids)]);
  // A previously incomplete teaser may now contain the full prompt. Do not suppress that repaired source.
  for (const lead of leads.filter(l => l.reason !== "prompt"))
    if (intake.records.some(record => record.postID === lead.id)) known.add(lead.id);
  report.known = leads.filter(l => known.has(l.id)).length;
  const pending = leads.filter(l => !known.has(l.id));
  const remaining = options.order ? options.order(pending) : pending;
  const allowance = Math.max(0, options.maxPosts - ledger.filter(a => a.state !== "budget-blocked" && (a.lane ?? "live") === lane)
    .reduce((sum, a) => sum + a.ids.length, 0));
  // Preserve a small slot for useful text/Skill leads without allowing text to dominate the visual pool.
  const visual = remaining.filter(l => l.visual), other = remaining.filter(l => !l.visual);
  const chosen = [...visual.slice(0, Math.max(0, allowance - Math.min(other.length, Math.floor(allowance / 5)))),
    ...other.slice(0, Math.floor(allowance / 5))].slice(0, allowance);
  report.pending = remaining.length - chosen.length;
  if (!chosen.length) return { ...report, status: remaining.length ? "daily-limit" : "ok" };
  const attempt: z.infer<typeof attemptSchema> = { at: now, ids: chosen.map(l => l.id), state: "reserved", lane };
  ledger.push(attempt); await atomic(ledgerPath, ledger); report.requests++;
  try {
    const lookup: XSourceLookup = options.lookup ?? (thirdParty ? thirdPartySourceLookup(root, env) : checkXAvailability);
    const result = await lookup(options.bearer ?? "", attempt.ids);
    const observed = [...result.posts.map(p => p.id), ...result.unavailable, ...(result.restricted ?? []), ...(result.unknownIDs ?? [])];
    if (observed.length !== chosen.length || new Set(observed).size !== chosen.length || observed.some(id => !attempt.ids.includes(id)) ||
        result.posts.some(post => chosen.find(l => l.id === post.id)?.authorID !== post.author_id))
      throw new Error("Source acquisition did not preserve identities");
    if (thirdParty && !result.provider) throw new Error("Third-party acquisition must retain its provider");
    // Persist the real provider; acquisition is still only an unapproved draft.
    await atomic(join(root, "x-discovery", `${day}-feed-${String(ledger.length).padStart(3, "0")}-${randomUUID()}.json`),
      { ...result, capturedAt: now, reviewStatus: "draft", acquisition: result.provider ? `${result.provider}-lookup` : "official-lookup", discoveredBy: "twitterapi",
        leadPlan: planID, leadEvidence: chosen.map(lead => ({ id: lead.id, planID: lead.planID ?? planID,
          directory: lead.directory, response: lead.evidence })) });
    const creatorPath = join(root, "creators.json");
    await atomic(creatorPath, mergeCreatorCache(await json<CreatorCache>(creatorPath, {}), result.creators));
    attempt.state = "completed"; attempt.accepted = result.posts.map(p => p.id); attempt.unavailable = result.unavailable; attempt.unknownIDs = result.unknownIDs; attempt.provider = result.provider;
    await atomic(ledgerPath, ledger);
    return { ...report, status: "ok", acquired: result.posts.length, unavailable: result.unavailable.length };
  } catch (error) {
    attempt.state = error instanceof XBudgetExceeded ? "budget-blocked" : "failed";
    await atomic(ledgerPath, ledger);
    return { ...report, status: error instanceof XBudgetExceeded ? "budget-limit" : "failed" };
  }
}
