import { join } from "node:path";
import { z } from "zod";
import { atomic, json } from "./publication.ts";
import { githubJSON, githubRepositoryLink, inspectDiscoveredRepository, collectDiscoveredPackage, discoveredSkillIssue } from "./discovered-skills.ts";
import { promptSchema } from "../packages/schema/catalog.ts";
import type { Candidate } from "./sources.ts";
import type { XIntakeRecord } from "./x-intake.ts";
import { skillPublishers } from "./publisher-skills.ts";
import { skillSources } from "./skills.ts";

const queries = ["agent skill image design", "agent skills video animation", "agent skills writing storytelling", "agent skills website presentation"];
const leadSchema = z.object({ repo: z.string(), foundAt: z.iso.datetime(), origin: z.enum(["x", "github"]), url: z.url(), priority: z.number().int().min(0).max(1).default(0),
  attemptedAt: z.iso.datetime().optional(), packageAttempts: z.record(z.string(), z.iso.datetime()).default({}), checked: z.record(z.string(), z.string()).default({}) });
const stateSchema = z.object({ nextQuery: z.number().int().nonnegative().default(0), searchedAt: z.iso.datetime().optional(),
  leads: z.array(leadSchema).max(200).default([]) });
const candidatesSchema = z.array(promptSchema.safeExtend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), featured: z.boolean(),
  reviewStatus: z.enum(["draft", "candidate"]), editorialRank: z.number().optional() })).max(2000);

/** Caller owns the daily content lock. New X leads have priority, with a bounded creative GitHub search as fallback. */
export async function prepareDiscoveredSkills(root: string, records: readonly XIntakeRecord[], options: {
  now?: string; enabled?: boolean; search?: typeof githubJSON; inspect?: typeof inspectDiscoveredRepository; collect?: typeof collectDiscoveredPackage;
} = {}) {
  const now = options.now ?? new Date().toISOString(), nowMS = Date.parse(now);
  if (!Number.isFinite(nowMS)) throw new Error("Invalid discovery time");
  const path = join(root, "skill-discovery", "state.json"), cachePath = join(root, "candidates", "discovered-skills.json");
  const state = stateSchema.parse(await json(path, {}));
  const cached = candidatesSchema.parse(await json(cachePath, []));
  for (const item of cached) { if (discoveredSkillIssue(item)) throw new Error("Invalid discovered Skill cache"); }
  const candidates = new Map<string, Candidate>(cached.map(item => [item.id, item]));
  const report = { status: options.enabled === false ? "dry-run" : "ok", leads: state.leads.length, xLeads: 0, searches: 0, repositories: 0,
    packages: 0, held: 0, failed: 0, cached: cached.length, issues: [] as { repo: string; directory?: string; reason: string }[] };
  if (options.enabled === false) return { candidates: cached, report };
  const known = new Set([...skillPublishers.map(s => s.repo.toLowerCase()), ...skillSources.map(s => s.repo.toLowerCase())]);
  const addLead = (repo: string, origin: "x" | "github", url: string) => {
    if (known.has(repo)) return;
    const old = state.leads.find(l => l.repo === repo);
    if (old) { if (origin === "x" && old.origin !== "x") { old.origin = origin; old.url = url; } return; }
    if (state.leads.length >= 200) {
      // Evict the oldest checked lead; candidates retain their immutable provenance.
      const remove = state.leads.map((l, index) => ({ l, index })).filter(({ l }) => l.attemptedAt)
        .sort((a, b) => Date.parse(a.l.attemptedAt!) - Date.parse(b.l.attemptedAt!))[0];
      if (!remove) return;
      state.leads.splice(remove.index, 1);
    }
    state.leads.push({ repo, foundAt: now, origin, url, priority: /image|video|design|motion|story|creative|writing|humanizer|diagram|poster|presentation|ppt|animation|artcraft|web/i.test(repo) ? 1 : 0, checked: {}, packageAttempts: {} });
  };
  for (const record of [...records].sort((a, b) => BigInt(a.postID) > BigInt(b.postID) ? -1 : 1)) {
    for (const link of record.expandedLinks ?? []) {
      const repo = githubRepositoryLink(link);
      if (repo && record.sourceURL) addLead(repo, "x", record.sourceURL);
    }
  }
  if (!state.searchedAt || nowMS - Date.parse(state.searchedAt) >= 6 * 3600000) {
    const query = queries[state.nextQuery % queries.length];
    state.nextQuery++; state.searchedAt = now; await atomic(path, state); // reserve before network
    try {
      report.searches++;
      const response = z.object({ incomplete_results: z.literal(false), items: z.array(z.object({ html_url: z.url(), priority: z.number().int().min(0).max(1).default(0), private: z.boolean(), archived: z.boolean().optional() })).max(10) })
        .parse(await (options.search ?? githubJSON)(`search/repositories?q=${encodeURIComponent(query + " license:mit archived:false fork:false")}&sort=updated&order=desc&per_page=10`));
      for (const entry of response.items) {
        const repo = githubRepositoryLink(entry.html_url);
        if (repo && !entry.private && !entry.archived) addLead(repo, "github", entry.html_url);
      }
    } catch { report.failed++; report.issues.push({ repo: "github-search", reason: "Search unavailable or incomplete" }); }
  }
  report.leads = state.leads.length; report.xLeads = state.leads.filter(l => l.origin === "x").length;
  const ready = state.leads.filter(l => !l.attemptedAt || nowMS - Date.parse(l.attemptedAt) >= 6 * 3600000)
    .sort((a, b) => Number(b.origin === "x") - Number(a.origin === "x")
      || b.priority - a.priority || Date.parse(a.attemptedAt ?? "1970-01-01T00:00:00Z") - Date.parse(b.attemptedAt ?? "1970-01-01T00:00:00Z") || b.foundAt.localeCompare(a.foundAt)).slice(0, 3);
  for (const lead of ready) {
    lead.attemptedAt = now; await atomic(path, state); report.repositories++;
    try {
      const result = await (options.inspect ?? inspectDiscoveredRepository)(lead.repo);
      report.held += result.held;
      // Revision changes invalidate all package checks; unchanged packages wait until others have had a turn.
      const pending = result.packages.filter(pack => lead.checked[pack.directory] !== result.revision).sort((a, b) => (lead.packageAttempts[a.directory] ?? "").localeCompare(lead.packageAttempts[b.directory] ?? "") || a.directory.localeCompare(b.directory)).slice(0, 5);
      for (const pack of pending) {
        lead.packageAttempts[pack.directory] = now; await atomic(path, state);
        try {
          const verified = await (options.collect ?? collectDiscoveredPackage)(lead.repo, result.revision, pack, lead.url);
          const item = verified.candidate;
          if (discoveredSkillIssue(item)) throw new Error("Invalid discovered package");
          await atomic(join(root, "skill-discovery", "evidence", `${item.id}-${result.revision}.json`), { capturedAt: now, ...verified });
          if (candidates.has(item.id) || candidates.size < 2000) {
            await atomic(cachePath, [...candidates.values()].filter(value => value.id !== item.id).concat(item));
            candidates.set(item.id, item); report.packages++; lead.checked[pack.directory] = result.revision;
          }
          else report.held++;
        } catch (error) { report.held++; report.issues.push({ repo: lead.repo, directory: pack.directory, reason: error instanceof Error ? error.message.slice(0, 160) : "Package unavailable" }); }
      }
      // Persist validated candidates before marking their checks complete so a crash cannot lose an accepted draft.
      await atomic(path, state);
    } catch (error) { report.failed++; report.issues.push({ repo: lead.repo, reason: error instanceof Error ? error.message.slice(0, 160) : "Repository unavailable" }); }
  }
  await atomic(path, state);
  report.status = report.failed ? "partial" : "ok";
  return { candidates: [...candidates.values()], report };
}
