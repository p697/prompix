import { creatorFiltersSchema, type CreatorFilters } from "./creator-filters.ts";
import { type FeedCard } from "../../packages/schema/feed.ts";
import type { Prompt } from "../../packages/schema/catalog.ts";
import { decodeDiscoveryCursor, encodeDiscoveryCursor, cursorLifetimeSeconds } from "./cursor.ts";
import { FeedError, type Database } from "./database.ts";
import { getState } from "./queries.ts";

/** Sort immutable release metadata before applying live takedowns, so paging
 * remains stable across midnight, new publications and removals. Read one small
 * card per selected creator only; never load bodies or the whole catalog. */
export async function getCreatorDiscovery(db: Database,
  query: { filters: CreatorFilters; limit: number; cursor?: string }, secret: string, now = Date.now()) {
  const filters = creatorFiltersSchema.parse(query.filters);
  let release: string, key = "", after = "", day = new Date(now).toISOString().slice(0, 10);
  let expires = Math.floor(now / 1000) + cursorLifetimeSeconds;
  if (query.cursor) {
    try { ({ release, key, after, day, expires } = decodeDiscoveryCursor(query.cursor, filters, secret, now)); }
    catch { throw new FeedError("invalid_request", 400); }
    if (!(await db.query("select id from prompix.releases where id=$1 and published_at is not null", [release])).rows.length)
      throw new FeedError("snapshot_expired", 410);
  } else release = (await getState(db)).release;
  const patterns = filters.q.split(" ").filter(Boolean).map(term => `%${term.replace(/[\\%_]/g, "\\$&")}%`);
  // Fixed sort expressions over immutable publication summaries. Takedowns
  // cannot move surviving creators across a keyset boundary.
  const rows = (await db.query<{ creator: NonNullable<Prompt["creator"]>; count: number; key: string; creator_id: string; preview: FeedCard | null }>(`
    with summaries as (
      select rc.creator_id,rc.creator,
        (rc.discovery->coalesce($2,'all')->>'total')::integer as total,
        (rc.discovery->coalesce($2,'all')->>'latest')::integer as latest,
        (rc.discovery->coalesce($2,'all')->>'visual')::integer as visual
      from prompix.release_creators rc where rc.release_id=$1 and rc.search_text like all($4::text[])
    ), ranked as (
      select *, (case $8::text
        when 'recommended' then (case when visual*2>=total then '0' when visual>0 then '1' else '2' end) || ':' || md5($3::text || ':' || creator_id)
        when 'latest' then lpad(latest::text,6,'0')
        when 'count' then lpad((100000-total)::text,6,'0')
        when 'name' then lower(creator->>'displayName') end) collate "C" as key from summaries where total>0
    ), visible as materialized (
      select v.creator_id,v.id as revision_id,e.latest_position,
        (v.kind in ('image','video','web') and v.content_type<>'skill'
          and (v.card->'media'->>'imageURL' is not null or v.card->'media'->>'image' is not null
            or (v.kind='web' and v.card->'media'->>'demoURL' is not null))) as visual
      from prompix.release_entries e join prompix.revisions v on v.id=e.revision_id
      join prompix.content c on c.id=e.content_id
      where e.release_id=$1 and c.removed_at is null and v.creator_id is not null
        and ($2::text is null or ($2='skill' and v.content_type='skill') or (v.kind=$2 and v.content_type<>'skill'))
    ), live as (
      select creator_id,count(*)::integer as count,bool_or(visual) as visual from visible group by creator_id
    ), page as materialized (
      select r.*,l.count from ranked r join live l using(creator_id)
      where (r.key,r.creator_id collate "C")>($5 collate "C",$6 collate "C")
        and ($8<>'recommended' or r.visual=0 or l.visual)
      order by r.key,r.creator_id collate "C" limit $7
    ) select p.creator,p.creator_id,p.count,p.key,v.card as preview from page p
    left join lateral (
      select revision_id from visible m where m.creator_id=p.creator_id
      order by m.visual desc,m.latest_position limit 1
    ) cover on true
    left join prompix.revisions v on v.id=cover.revision_id
    order by p.key,p.creator_id collate "C"`, [release, filters.kind ?? null, day, patterns, key, after, query.limit + 1, filters.sort])).rows;
  const page = rows.slice(0, query.limit), last = page.at(-1);
  return { schemaVersion: 3 as const, release, items: page.map(({ creator, count, preview }) => ({ creator, count, preview })),
    nextCursor: rows.length > query.limit && last ? encodeDiscoveryCursor({ v: 2, scope: "creator-discovery", release,
      key: last.key, after: last.creator_id, day, filters, expires }, secret) : null };
}
