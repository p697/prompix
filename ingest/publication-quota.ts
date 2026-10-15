import type { Prompt } from "../packages/schema/catalog.ts";
import type { Database } from "../services/feed/database.ts";
import { windowBudget } from "./discovery-budget.ts";
/** Apply after quality/media gates and before translation; activation rechecks the hard ceiling under a DB lock. */
export async function limitNewPublications(db: Database, items: Prompt[], now = new Date()) {
  const start = now.toISOString().slice(0, 10) + "T00:00:00Z";
  const used = (await db.query<{ count: number }>(`select count(*)::integer as count from prompix.content
    where counts_toward_daily_limit and first_published_at >= $1::timestamptz and first_published_at < $1::timestamptz + interval '1 day'`, [start])).rows[0].count;
  const prior = new Set<string>();
  for (let offset = 0; offset < items.length; offset += 500) {
    const rows = await db.query<{ id: string }>("select id from prompix.content where id=any($1::text[]) and first_published_at is not null", [items.slice(offset, offset + 500).map(i => i.id)]);
    for (const row of rows.rows) prior.add(row.id);
  }
  const allowance = Math.max(0, windowBudget(100, now) - used);
  let selected = 0;
  const prompts = items.filter(item => prior.has(item.id) || selected++ < allowance);
  return { prompts, report: { dailyCeiling: 100, windowAllowance: windowBudget(100, now), alreadyPublished: used,
    selected: Math.min(selected, allowance), deferred: Math.max(0, selected - allowance) } };
}
