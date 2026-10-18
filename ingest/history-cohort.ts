import { z } from "zod";
import { catalogSchema, promptSchema, type Catalog, type Prompt } from "../packages/schema/catalog.ts";
import type { XSearchLead } from "./x-search-admission.ts";
import { fingerprint } from "./sources.ts";
import { translationFingerprint, translationLocales, validLocalizedText } from "./translation.ts";
import { originalBaseSchema } from "../packages/schema/language-packs.ts";
import { nativeXSourceIssue } from "./x-source.ts";

export const historyLimits = { target: 500, sources: 1500, searches: 750, batch: 50, editorial: 64, visual: 64, translation: 200 } as const;
export const historyLeadSchema = z.object({ id: z.string().regex(/^\d{1,19}$/), authorID: z.string().regex(/^\d{1,19}$/),
  reason: z.enum(["prompt", "reply", "skill-link"]), kind: z.enum(["text", "image", "video", "web"]).nullable(), visual: z.boolean(),
  sourceDate: z.iso.datetime(), evidence: z.string().min(1), planID: z.string().optional(), directory: z.string().optional() }).strict();
export const historyBatchSchema = z.object({ version: z.literal(1), id: z.string().regex(/^batch-\d{4}$/), createdAt: z.iso.datetime(),
  leads: z.array(historyLeadSchema).min(1).max(historyLimits.batch) }).strict().refine(b => new Set(b.leads.map(l => l.id)).size === b.leads.length);
export const historyCatalogSchema = catalogSchema.safeExtend({ prompts: z.array(promptSchema).max(historyLimits.target) });
export type HistoryBatch = z.infer<typeof historyBatchSchema>;
/** Immutable assignment, including rejected/uncertain acquisitions, prevents recharging them under a new batch. */
export function chooseHistoryLeads(leads: readonly XSearchLead[], used: ReadonlySet<string>, limit: number): XSearchLead[] {
  if (!Number.isInteger(limit) || limit < 0 || limit > historyLimits.batch) throw new Error("Invalid history batch bound");
  const seen = new Set(used), authors = new Map<string, XSearchLead[]>();
  for (const lead of leads) {
    historyLeadSchema.parse(lead);
    if (seen.has(lead.id) || !lead.visual || lead.reason !== "prompt") continue;
    seen.add(lead.id); const group = authors.get(lead.authorID) ?? []; group.push(lead); authors.set(lead.authorID, group);
  }
  const chosen: XSearchLead[] = [];
  // Up to three per creator in a cohort batch, with a fair first pass across creators.
  for (let row = 0; row < 3 && chosen.length < limit; row++) for (const group of authors.values()) {
    if (group[row] && chosen.length < limit) chosen.push(group[row]);
  }
  return chosen;
}
export function uniqueHistoryItems(items: readonly Prompt[], previous: readonly Prompt[]): Prompt[] {
  const ids = new Set(previous.map(p => p.id)), hashes = new Set(previous.map(p => fingerprint(p.prompt)));
  return items.filter(item => { const hash = fingerprint(item.prompt); if (ids.has(item.id) || hashes.has(hash)) return false;
    ids.add(item.id); hashes.add(hash); return true; });
}
export function completeHistoryItem(item: Prompt, now = Date.now()): boolean {
  if (item.source.acquiredVia !== "twitterapi" || nativeXSourceIssue(item, now) ||
      !["general", "suggestive"].includes(item.presentation ?? "") || !item.media?.imageURL ||
      !/^https:\/\/api\.prompix\.dev\/media\/[a-f0-9]{64}\.jpg$/.test(item.media.imageURL) ||
      item.localization?.sourceFingerprint !== translationFingerprint(item)) return false;
  return translationLocales.every(locale => {
    const text = item.localization?.translations[locale]; return !!text && validLocalizedText(item, locale, text);
  });
}

/** Original v2 baselines have language availability, not embedded translated bodies. */
export function historyBaseline(input: unknown): Catalog {
  const base = originalBaseSchema.safeParse(input);
  if (!base.success) return catalogSchema.parse(input);
  return catalogSchema.parse({ ...base.data, schemaVersion: 1, prompts: base.data.prompts.map(({ localization, ...item }) => item) });
}
