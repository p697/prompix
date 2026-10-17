import { contentTopics } from "../../packages/schema/interests.ts";
import { collectionDefinitions, contentID, feedLocale, revisionID, type FeedCard, type FeedFilters, type FeedLocale, type FeedPage } from "../../packages/schema/feed.ts";
import type { Prompt } from "../../packages/schema/catalog.ts";
import { cursorLifetimeSeconds, decodeCursor, encodeCursor, decodeCreatorCursor, encodeCreatorCursor, encodeVisualFeedCursor, decodeVisualFeedCursor, encodeRecommendedCursor, decodeRecommendedCursor } from "./cursor.ts";
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
  const page = await getRawFeed(db, query, secret, now);
  return { ...page, items: page.items.map(card => ({ ...card, topics: contentTopics(card) })) };
}
async function getRawFeed(db: Database, query: { filters: FeedFilters; limit: number; cursor?: string }, secret: string, now: number): Promise<FeedPage> {
  const { filters, limit } = query;
  if (filters.sort === "discovery" || filters.sort === "recommended") return getVisualFeed(db, query, secret, now);
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
  where.push(...feedConditions(filters, parameter));
  for (const pattern of patterns) where.push(`v.search_text like ${parameter(pattern)}`);
  // Broad ranked searches otherwise underestimate rows and can rescan content for every
  // match. Resolve visibility once before ranking; ordinary keyset pages remain inlined.
  // Fetch card/translation payloads only after the bounded page has been selected.
  const rows = (await db.query<{ position: number; rank: number; card: FeedCard }>(`with visible_entries as ${patterns.length ? "materialized" : "not materialized"} (
    select ${filters.sort === "latest" ? "e.latest_position" : "e.position"} as position,e.revision_id from prompix.release_entries e
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


function feedConditions(filters: FeedFilters, parameter: (value: unknown) => string): string[] {
  const where: string[] = [];
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
  return where;
}

/** Real media determines visual eligibility, not a tag, title or generated cover. */
async function getVisualFeed(db: Database, query: { filters: FeedFilters; limit: number; cursor?: string }, secret: string, now: number): Promise<FeedPage> {
  const { filters, limit } = query;
  const recommended = filters.sort === "recommended";
  if (filters.q || (recommended && !/^[a-f0-9]{32}$/.test(filters.seed ?? ""))) throw new FeedError("invalid_request", 400);
  let visualRemaining: number | undefined, textRemaining: number | undefined, plainRun = 0;
  let release: string, visual: number | string = recommended ? "" : -1, text: number | string = visual;
  let slot = 0, expires = Math.floor(now / 1000) + cursorLifetimeSeconds;
  if (query.cursor) {
    try { ({ release, visual, text, slot, expires, visualRemaining, textRemaining, plainRun } = (recommended ? decodeRecommendedCursor : decodeVisualFeedCursor)(query.cursor, filters, secret, now)); }
    catch { throw new FeedError("invalid_request", 400); }
    if (!(await db.query("select id from prompix.releases where id=$1 and published_at is not null", [release])).rows.length)
      throw new FeedError("snapshot_expired", 410);
  } else release = (await getState(db)).release;
  const parameters: unknown[] = [release, visual, filters.locale, text];
  const parameter = (value: unknown) => { parameters.push(value); return `$${parameters.length}`; };
  const where = feedConditions(filters, parameter);
  const bound = parameter(limit + 1);
  const countLanes = visualRemaining === undefined || textRemaining === undefined;
  // Small fresh-content exploration lane, then a session permutation of the
  // whole filtered catalog. Hashing is for ranking, not authentication. Only
  // metadata is scanned; cards and translations are loaded after the page bound.
  const seed = recommended ? parameter(filters.seed) : undefined;
  const hash = `md5(${seed}::text || e.content_id)`;
  const position = recommended
    ? `(case when e.latest_position<120 and left(${hash},1)='0' then '0' else '1' end) || ${hash} || lpad(e.latest_position::text,7,'0')`
    : "e.latest_position";
  const rows = (await db.query<{ position: number | string; visual: boolean; total: number; card: FeedCard }>(`
    with candidates as not materialized (
      select ${position} as position,e.revision_id,
        (coalesce(nullif(v.card#>>'{media,imageURL}',''),nullif(v.card#>>'{media,image}','')) is not null) as visual
      from prompix.release_entries e join prompix.releases r on r.id=e.release_id
      join prompix.content c on c.id=e.content_id join prompix.revisions v on v.id=e.revision_id
      where e.release_id=$1 and r.published_at is not null and c.removed_at is null
        ${where.length ? `and ${where.join(" and ")}` : ""}
    ), remaining as not materialized (
      select * from candidates where (visual and position>$2) or (not visual and position>$4)
    ), counted as not materialized (
      select *,${countLanes ? "(count(*) over(partition by visual))::integer" : "0"} as total from remaining
    ), page as materialized (
      (select * from counted where visual order by position limit ${bound})
      union all
      (select * from counted where not visual order by position limit ${bound})
    ) select p.position,p.visual,p.total,coalesce(t.card,v.card) as card from page p
      join prompix.revisions v on v.id=p.revision_id
      left join prompix.translations t on t.revision_id=p.revision_id and t.locale=$3
      order by p.visual desc,p.position`, parameters)).rows;
  const lanes = [rows.filter(row => row.visual), rows.filter(row => !row.visual)];
  visualRemaining ??= lanes[0][0]?.total ?? 0;
  textRemaining ??= lanes[1][0]?.total ?? 0;
  if (!lanes[0].length) visualRemaining = 0;
  if (!lanes[1].length) textRemaining = 0;
  const offsets = [0, 0], items: FeedCard[] = [];
  while (items.length < limit) {
    let preferred = slot < 4 ? 0 : 1;
    // Keep enough visual anchors for the historical text backlog instead of
    // exhausting every image and returning hundreds of text-only tail cards.
    if (visualRemaining <= Math.ceil(textRemaining / 2) && textRemaining > 0 && plainRun < 2) preferred = 1;
    if (plainRun >= 2 && visualRemaining > 0) preferred = 0;
    if (visual === (recommended ? "" : -1) && text === (recommended ? "" : -1) && visualRemaining > 0) preferred = 0;
    const lane = offsets[preferred] < lanes[preferred].length ? preferred : 1 - preferred;
    const row = lanes[lane][offsets[lane]];
    if (!row) break;
    offsets[lane]++; items.push(row.card);
    if (lane === 0) { visual = row.position; visualRemaining = Math.max(0, visualRemaining - 1); plainRun = 0; }
    else { text = row.position; textRemaining = Math.max(0, textRemaining - 1); plainRun = Math.min(2, plainRun + 1); }
    slot = (slot + 1) % 5;
  }
  const hasMore = lanes.some((lane, index) => offsets[index] < lane.length);
  const common = { v: 1 as const, release, slot, visualRemaining, textRemaining, plainRun, filters, expires };
  return { schemaVersion: 3, release, items,
    nextCursor: !hasMore ? null : recommended
      ? encodeRecommendedCursor({ ...common, scope: "recommended-feed", visual: String(visual), text: String(text) }, secret)
      : encodeVisualFeedCursor({ ...common, scope: "visual-feed", visual: Number(visual), text: Number(text) }, secret) };
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
      select e.latest_position as position,e.revision_id from prompix.release_entries e
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
