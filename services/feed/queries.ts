import { collectionDefinitions, contentID, feedLocale, revisionID, type FeedCard, type FeedFilters, type FeedLocale, type FeedPage } from "../../packages/schema/feed.ts";
import type { Prompt } from "../../packages/schema/catalog.ts";
import { cursorLifetimeSeconds, decodeCursor, encodeCursor, decodeCreatorCursor, encodeCreatorCursor } from "./cursor.ts";
import { FeedError, type Database } from "./database.ts";

type StateRow = { release: string | null; generation: string; removalSequence: string; count: number; publishedAt: string | null };
export async function getState(db: Database) {
  const state = (await db.query<StateRow>(`select s.active_release as release, s.generation::text,
    coalesce((select max(sequence) from prompix.removals),0)::text as "removalSequence",
    (select count(*)::integer from prompix.release_entries e join prompix.content c on c.id=e.content_id
      where e.release_id=s.active_release and c.removed_at is null) as count,
    r.published_at::text as "publishedAt"
    from prompix.state s left join prompix.releases r on r.id=s.active_release where singleton`)).rows[0];
  if (!state?.release) throw new FeedError("unavailable", 503);
  return { schemaVersion: 3 as const, ...state, release: state.release };
}

export async function getFeed(db: Database, query: { filters: FeedFilters; limit: number; cursor?: string }, secret: string, now = Date.now()): Promise<FeedPage> {
  const { filters, limit } = query;
  let release: string, position = -1, rank = 5, expires = Math.floor(now / 1000) + cursorLifetimeSeconds;
  if (query.cursor) {
    try { ({ release, position, rank, expires } = decodeCursor(query.cursor, filters, secret, now)); }
    catch { throw new FeedError("invalid_request", 400); }
    const snapshot = await db.query("select id from prompix.releases where id=$1 and published_at is not null", [release]);
    if (!snapshot.rows.length) throw new FeedError("snapshot_expired", 410);
  } else release = (await getState(db)).release;
  const patterns = filters.q.split(" ").filter(Boolean).map(term => `%${term.replace(/[\\%_]/g, "\\$&")}%`);
  const parameters: unknown[] = [release, position, filters.locale, rank, filters.q, patterns];
  const where: string[] = [];
  const parameter = (value: unknown) => { parameters.push(value); return `$${parameters.length}`; };
  if (filters.kind === "skill") where.push("v.content_type='skill'");
  else if (filters.kind) where.push(`v.kind=${parameter(filters.kind)} and v.content_type<>'skill'`);
  if (filters.collection) {
    const collection = collectionDefinitions[filters.collection];
    if (collection.kind) where.push(`v.kind=${parameter(collection.kind)}`);
    if (collection.tags.length) where.push(`v.tags && ${parameter(collection.tags)}::text[]`);
  }
  if (filters.creator) where.push(`v.creator_id=${parameter(filters.creator)}`);
  if (filters.model) where.push(`v.model=${parameter(filters.model)}`);
  if (filters.tag) {
    const tagged = `v.tags @> array[${parameter(filters.tag)}]::text[]`;
    where.push(filters.tag === "创作灵感" ? `(v.kind<>'text' or ${tagged})` : tagged);
  }
  for (const pattern of patterns) where.push(`v.search_text like ${parameter(pattern)}`);
  // Broad ranked searches otherwise underestimate rows and can rescan content for every
  // match. Resolve visibility once before ranking; ordinary keyset pages remain inlined.
  // Fetch card/translation payloads only after the bounded page has been selected.
  const rows = (await db.query<{ position: number; rank: number; card: FeedCard }>(`with visible_entries as ${patterns.length ? "materialized" : "not materialized"} (
    select e.position,e.revision_id from prompix.release_entries e
    join prompix.releases r on r.id=e.release_id
    join prompix.content c on c.id=e.content_id
    where e.release_id=$1 and r.published_at is not null and c.removed_at is null
  ), matched as (
    select e.position,e.revision_id,case
      when $5='' then 0 when $5=any(v.search_titles) then 4
      when exists(select 1 from unnest(v.search_titles) title where title like all($6::text[])) then 3
      when v.search_creator like all($6::text[]) then 2
      when v.search_metadata like all($6::text[]) then 1 else 0 end as rank
    from visible_entries e join prompix.revisions v on v.id=e.revision_id
    ${where.length ? `where ${where.join(" and ")}` : ""}), page as materialized (
      select position,revision_id,rank from matched where rank<$4 or (rank=$4 and position>$2)
      order by rank desc,position limit ${parameter(limit + 1)}
    ) select p.position,p.rank,coalesce(t.card,v.card) as card from page p
    join prompix.revisions v on v.id=p.revision_id
    left join prompix.translations t on t.revision_id=p.revision_id and t.locale=$3
    order by p.rank desc,p.position`, parameters)).rows;
  const page = rows.slice(0, limit);
  return {
    schemaVersion: 3, release, items: page.map(row => row.card),
    nextCursor: rows.length > limit ? encodeCursor({ v: 2, release, position: page.at(-1)!.position, rank: page.at(-1)!.rank, filters, expires }, secret) : null,
  };
}

/** Explicit revision gives stable detail during paging; no revision means current release. */
export async function getDetail(db: Database, id: string, locale: FeedLocale, revision?: string) {
  contentID.parse(id); feedLocale.parse(locale); if (revision) revisionID.parse(revision);
  const removed = (await db.query<{ removed_at: unknown }>("select removed_at from prompix.content where id=$1", [id])).rows[0];
  if (removed?.removed_at) throw new FeedError("removed", 410);
  const row = (await db.query<{ revision: string; original: Prompt; content: NonNullable<Prompt["localization"]>["translations"]["en"] | null; languages: string[] }>(`
    select v.id as revision,v.original,t.content,v.languages
    from prompix.revisions v
    join prompix.content c on c.id=v.content_id and c.removed_at is null
    left join prompix.translations t on t.revision_id=v.id and t.locale=$2
    where v.content_id=$1 and exists(
      select 1 from prompix.release_entries e join prompix.releases r on r.id=e.release_id
      where e.revision_id=v.id and r.published_at is not null
        and ($3::text is not null or e.release_id=(select active_release from prompix.state where singleton)))
      and ($3::text is null or v.id=$3) limit 1`, [id, locale, revision ?? null])).rows[0];
  if (!row) throw new FeedError("not_found", 404);
  const item = { ...row.original, ...(row.original.localization ? {
    localization: { ...row.original.localization, translations: row.content ? { [locale]: row.content } : {} },
  } : {}) };
  return { schemaVersion: 3 as const, revision: row.revision, item, availableLanguages: row.languages };
}

export async function getRemovals(db: Database, after: string, limit = 500) {
  if (!/^(0|[1-9][0-9]{0,17})$/.test(after) || limit < 1 || limit > 500) throw new FeedError("invalid_request", 400);
  const rows = (await db.query<{ sequence: string; id: string }>(`
    select sequence::text,content_id as id from prompix.removals where sequence>$1::bigint
    order by sequence limit $2`, [after, limit + 1])).rows;
  const page = rows.slice(0, limit);
  return { schemaVersion: 3 as const, items: page, nextAfter: page.at(-1)?.sequence ?? after, hasMore: rows.length > limit };
}

/** Directory order is bound to the release, while counts always respect takedowns. */
export async function getCreators(db: Database, query: { q: string; limit: number; cursor?: string }, secret: string, now = Date.now()) {
  let release: string, count = 100001, after = "", expires = Math.floor(now / 1000) + cursorLifetimeSeconds;
  if (query.cursor) {
    try { ({ release, count, after, expires } = decodeCreatorCursor(query.cursor, query.q, secret, now)); }
    catch { throw new FeedError("invalid_request", 400); }
    if (!(await db.query("select id from prompix.releases where id=$1 and published_at is not null", [release])).rows.length)
      throw new FeedError("snapshot_expired", 410);
  } else release = (await getState(db)).release;
  const parameters: unknown[] = [release, count, after];
  const where = ["rc.release_id=$1", "(rc.item_count<$2 or (rc.item_count=$2 and rc.creator_id>$3))"];
  for (const term of query.q.split(" ").filter(Boolean)) {
    parameters.push(`%${term.replace(/[\\%_]/g, "\\$&")}%`);
    where.push(`rc.search_text like $${parameters.length}`);
  }
  parameters.push(query.limit + 1);
  const rows = (await db.query<{ creator: NonNullable<Prompt["creator"]>; count: number; item_count: number; creator_id: string }>(`
    select rc.creator,rc.item_count,rc.creator_id,live.count
    from prompix.release_creators rc
    cross join lateral (
      select count(*)::integer as count from prompix.release_entries e join prompix.revisions v on v.id=e.revision_id
      join prompix.content c on c.id=e.content_id
      where e.release_id=rc.release_id and v.creator_id=rc.creator_id and c.removed_at is null
    ) live
    where ${where.join(" and ")} and live.count>0
    order by rc.item_count desc,rc.creator_id limit $${parameters.length}`, parameters)).rows;
  const page = rows.slice(0, query.limit), last = page.at(-1);
  return { schemaVersion: 3 as const, release, items: page.map(({ creator, count }) => ({ creator, count })),
    nextCursor: rows.length > query.limit && last ? encodeCreatorCursor({ v: 1, scope: "creators", release,
      count: last.item_count, after: last.creator_id, q: query.q, expires }, secret) : null };
}

/** Global facets are computed over visible metadata, then only cover cards are loaded. */
export async function getBrowse(db: Database, locale: FeedLocale) {
  feedLocale.parse(locale);
  const release = (await getState(db)).release;
  const definitions = Object.entries(collectionDefinitions).map(([id, value]) => ({ id, ...value }));
  const result = (await db.query<{ collections: { id: string; count: number; covers: FeedCard[] }[];
    models: { name: string; count: number }[]; modelCount: number }>(`
    with visible_entries as materialized (
      select e.position,e.revision_id from prompix.release_entries e
      join prompix.releases r on r.id=e.release_id
      join prompix.content c on c.id=e.content_id
      where e.release_id=$1 and r.published_at is not null and c.removed_at is null
    ), metadata as materialized (
      select e.position,e.revision_id,v.kind,v.content_type,v.tags,v.model
      from visible_entries e join prompix.revisions v on v.id=e.revision_id
    ), definitions as (
      select * from jsonb_to_recordset($2::jsonb) as d(id text,kind text,tags text[])
    ), matches as materialized (
      select d.id,m.revision_id,
        row_number() over(partition by d.id order by (m.kind<>'text' and m.content_type<>'skill') desc,m.position) as ordinal,
        count(*) over(partition by d.id)::integer as count
      from definitions d join metadata m on (d.kind is null or d.kind=m.kind)
        and (cardinality(d.tags)=0 or d.tags && m.tags)
    ), covers as materialized (
      select id,revision_id,ordinal,count from matches where ordinal<=2
    ), model_counts as materialized (
      select model as name,count(*)::integer as count from metadata group by model
    ) select
      coalesce((select jsonb_agg(summary order by summary->>'id') from (
        select jsonb_build_object('id',d.id,'count',coalesce(max(p.count),0),
          'covers',coalesce(jsonb_agg(coalesce(t.card,v.card) order by p.ordinal) filter(where p.revision_id is not null),'[]'::jsonb)) as summary
        from definitions d left join covers p on p.id=d.id
        left join prompix.revisions v on v.id=p.revision_id
        left join prompix.translations t on t.revision_id=p.revision_id and t.locale=$3
        group by d.id) summaries),'[]'::jsonb) as collections,
      coalesce((select jsonb_agg(row_to_json(top_models)) from (
        select name,count from model_counts order by count desc,name limit 50
      ) top_models),'[]'::jsonb) as models,
      (select count(*)::integer from model_counts) as "modelCount"`, [release, JSON.stringify(definitions), locale])).rows[0];
  if (!result) throw new FeedError("unavailable", 503);
  return { schemaVersion: 3 as const, release, ...result };
}
