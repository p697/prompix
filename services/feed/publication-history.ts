import { z } from "zod";
import { contentID } from "../../packages/schema/feed.ts";
import type { Database } from "./database.ts";
const historySchema = z.array(z.object({ id: contentID, firstPublishedAt: z.iso.datetime(), counted: z.boolean() }).strict()).max(200000)
  .refine(rows => new Set(rows.map(r => r.id)).size === rows.length, "Duplicate history identity");
export type PublicationHistory = z.infer<typeof historySchema>;
/** Include inactive and removed identities so restoration cannot replenish today's quota. */
export async function exportPublicationHistory(db: Database): Promise<PublicationHistory> {
  const result: PublicationHistory = []; let after = "";
  for (;;) {
    const rows = (await db.query<{ id: string; firstPublishedAt: string; counted: boolean }>(`select id,
      to_char(first_published_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "firstPublishedAt",counts_toward_daily_limit as counted
      from prompix.content where first_published_at is not null and id>$1 order by id limit 500`, [after])).rows;
    result.push(...rows); if (rows.length < 500) break; after = rows.at(-1)!.id;
  }
  return historySchema.parse(result);
}
/** Only for an isolated, not-yet-activated restoration. Never overwrite existing first-publication history. */
export async function restorePublicationHistory(db: Database, raw: unknown): Promise<void> {
  const rows = historySchema.parse(raw);
  const state = (await db.query<{ active_release: string | null }>("select active_release from prompix.state where singleton")).rows[0];
  if (state.active_release) throw new Error("Publication history restore requires an uninitialized database");
  for (let offset = 0; offset < rows.length; offset += 500) {
    const batch = rows.slice(offset, offset + 500);
    await db.query(`insert into prompix.content(id,first_published_at,counts_toward_daily_limit)
      select id,"firstPublishedAt",counted from jsonb_to_recordset($1::jsonb) as x(id text,"firstPublishedAt" timestamptz,counted boolean)
      on conflict(id) do update set first_published_at=excluded.first_published_at,counts_toward_daily_limit=excluded.counts_toward_daily_limit
      where prompix.content.first_published_at is null`, [JSON.stringify(batch)]);
  }
}
