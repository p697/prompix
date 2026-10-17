import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { atomic, json } from "./publication.ts";
import { selectXSearchLeads, admitXLeadSelection, type XSearchLead, type XAdmissionOptions } from "./x-search-admission.ts";
import { searchPlanSchema } from "./x-search-plan.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const lane = z.enum(["live", "history"]);
const leadSchema = z.object({ id: z.string().regex(/^\d{1,19}$/), authorID: z.string().regex(/^\d{1,19}$/),
  reason: z.enum(["prompt", "reply", "skill-link"]), kind: z.enum(["text", "image", "video", "web"]).nullable(),
  visual: z.boolean(), sourceDate: z.iso.datetime(), evidence: z.string().regex(/^response-\d{5}\.json$/),
  planID: z.string().regex(/^[a-f0-9]{64}$/), directory: z.string().refine(isAbsolute), lane,
  firstSeen: z.iso.datetime() }).strict();
const queueSchema = z.object({ version: z.literal(1), entries: z.array(leadSchema).max(50_000),
  plans: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) }).strict()
  .refine(q => new Set(q.entries.map(e => e.id)).size === q.entries.length, "Duplicate queue identity");
const queuePath = (root: string) => join(root, "x-lead-queue.json");
const readQueue = async (root: string) => queueSchema.parse(await json(queuePath(root), { version: 1, entries: [], plans: {} }));

/** Caller holds the content lock. Only validated immutable captures can add queue entries. */
export async function stageXLeadQueue(root: string, inputs: { directory: string; lane: "live" | "history" }[], now = new Date().toISOString()) {
  z.iso.datetime().parse(now);
  const queue = await readQueue(root), entries = new Map(queue.entries.map(e => [e.id, e]));
  let changedPlans = 0, added = 0;
  for (const input of inputs) {
    const directory = resolve(input.directory);
    const plan = searchPlanSchema.parse(await json(join(directory, "plan.json"), null));
    const progress = await readFile(join(directory, "progress.json"), "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return "";
    });
    const digest = hash(JSON.stringify(plan) + progress + input.lane);
    if (queue.plans[directory] === digest) continue;
    const selected = await selectXSearchLeads(directory, plan);
    for (const lead of selected.leads) {
      const previous = entries.get(lead.id);
      if (previous && previous.authorID !== lead.authorID) throw new Error("X lead author identity changed");
      // Repeated discovery cannot renew queue age or replace a complete prompt with a teaser.
      if (previous?.reason === "prompt" && lead.reason !== "prompt") continue;
      entries.set(lead.id, { ...lead, planID: selected.report.planID, directory,
        lane: previous?.lane === "live" ? "live" : input.lane, firstSeen: previous?.firstSeen ?? now });
      if (!previous) added++;
    }
    queue.plans[directory] = digest; changedPlans++;
  }
  queue.entries = [...entries.values()];
  if (changedPlans) await atomic(queuePath(root), queueSchema.parse(queue));
  return { added, changedPlans, total: queue.entries.length };
}

/** Import every completed earlier search window once, including the cutover's unpaid remaining leads. */
export async function syncLiveXLeadQueue(root: string, now: string) {
  const base = join(root, "x-search-plans");
  let names: string[];
  try { names = await readdir(base); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; names = []; }
  const inputs = names.filter(name => /^\d{4}-\d{2}-\d{2}-[0-3]$/.test(name)).sort()
    .map(name => ({ directory: join(base, name), lane: "live" as const }));
  return stageXLeadQueue(root, inputs, now);
}

/** Three fresh leads, then one oldest pending lead; apply independently to visual and text pools. */
export function fairXLeadOrder(leads: XSearchLead[], firstSeen: ReadonlyMap<string, string>): XSearchLead[] {
  const output: XSearchLead[] = [];
  for (const visual of [true, false]) {
    const pool = leads.filter(l => l.visual === visual);
    const fresh = [...pool].sort((a, b) => b.sourceDate.localeCompare(a.sourceDate) || a.id.localeCompare(b.id));
    const old = [...pool].sort((a, b) => (firstSeen.get(a.id) ?? a.sourceDate).localeCompare(firstSeen.get(b.id) ?? b.sourceDate)
      || a.sourceDate.localeCompare(b.sourceDate) || a.id.localeCompare(b.id));
    const used = new Set<string>(); let freshIndex = 0, oldIndex = 0, index = 0;
    while (used.size < pool.length) {
      while (freshIndex < fresh.length && used.has(fresh[freshIndex].id)) freshIndex++;
      while (oldIndex < old.length && used.has(old[oldIndex].id)) oldIndex++;
      const item = index++ % 4 === 3 ? old[oldIndex] : fresh[freshIndex];
      used.add(item.id); output.push(item);
    }
  }
  return output;
}

export async function acquireXLeadQueue(root: string, options: XAdmissionOptions) {
  const queue = await readQueue(root), scope = options.lane ?? "live";
  const entries = queue.entries.filter(e => e.lane === scope);
  const report = await admitXLeadSelection(root, entries, hash(JSON.stringify(entries)), { ...options,
    order: leads => fairXLeadOrder(leads, new Map(entries.map(e => [e.id, e.firstSeen]))) });
  await atomic(join(root, `x-lead-queue-${scope}-status.json`), { at: options.now ?? new Date().toISOString(), lane: scope, ...report });
  return report;
}
