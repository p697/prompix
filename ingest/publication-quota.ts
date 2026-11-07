import { historyAllowanceIDs, type HistoryAllowance } from "../services/feed/history-allowance.ts";
import type { Prompt } from "../packages/schema/catalog.ts";
import { hasVisualPreview } from "../packages/schema/visual.ts";
import type { Database } from "../services/feed/database.ts";

const visualsPerText = 4;

/** Caller owns the global publication lock. Apply after all quality and media gates, before
 * translation. There is no daily ceiling on visual works (2026-11-07): acquisition bounds the
 * volume, and everything that passed review is published. Plain text keeps the owner's ratio,
 * one new text item per four visual works published the same UTC day. */
export async function limitNewPublications(db: Database, items: Prompt[], now = new Date(), historical?: HistoryAllowance) {
  const historicalIDs = new Set(historyAllowanceIDs(historical, now.getTime()));
  const start = now.toISOString().slice(0, 10) + "T00:00:00Z";
  const usage = (await db.query<{ count: number; visual: number }>(`select count(*)::integer as count,
    count(*) filter(where exists(select 1 from prompix.revisions v
      join prompix.release_entries e on e.revision_id=v.id join prompix.releases r on r.id=e.release_id
      where v.content_id=c.id and r.published_at is not null
        and coalesce(nullif(v.card#>>'{media,imageURL}',''),nullif(v.card#>>'{media,image}','')) is not null))::integer as visual
    from prompix.content c where counts_toward_daily_limit and first_published_at >= $1::timestamptz
      and first_published_at < $1::timestamptz + interval '1 day'`, [start])).rows[0];
  const prior = new Set<string>();
  for (let offset = 0; offset < items.length; offset += 500) {
    const rows = await db.query<{ id: string }>("select id from prompix.content where id=any($1::text[]) and first_published_at is not null", [items.slice(offset, offset + 500).map(i => i.id)]);
    for (const row of rows.rows) prior.add(row.id);
  }
  const incoming = items.filter(item => !prior.has(item.id) && !historicalIDs.has(item.id));
  const visuals = incoming.filter(hasVisualPreview);
  const plainUsed = usage.count - usage.visual;
  // Existing overrepresented text never removes published works or grants fresh capacity.
  const plainAllowance = Math.max(0, Math.floor((usage.visual + visuals.length) / visualsPerText) - plainUsed);
  const plain = incoming.filter(item => !hasVisualPreview(item)).slice(0, plainAllowance);
  const chosen = new Set([...visuals, ...plain].map(item => item.id));
  const prompts = items.filter(item => prior.has(item.id) || chosen.has(item.id) || historicalIDs.has(item.id));
  return { prompts, report: { historicalSelected: items.filter(item => !prior.has(item.id) && historicalIDs.has(item.id)).length, alreadyPublished: usage.count,
    selected: chosen.size, deferred: incoming.length - chosen.size, visualSelected: visuals.length, plainSelected: plain.length,
    plainAlreadyPublished: plainUsed, visualsPerText } };
}
