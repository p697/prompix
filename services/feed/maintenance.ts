import type { Database } from "./database.ts";

/** Internal, read-only operations report; never expose it through the public API. */
export async function databaseReport(db: Database) {
  const storage = (await db.query(`select
    (select count(*)::integer from prompix.releases) as releases,
    (select count(*)::integer from prompix.revisions) as revisions,
    (select count(*)::integer from prompix.translations) as translations,
    (select count(*)::integer from prompix.removals) as removals,
    (select count(*)::integer from prompix.releases where published_at is null and created_at<now()-interval '7 days') as "oldUnpublishedReleases",
    (select count(*)::integer from prompix.ingest_runs where state='running') as "runningIngest",
    (select count(*)::integer from prompix.ingest_runs where state='failed' and started_at>now()-interval '7 days') as "failedRuns7Days",
    (select coalesce(sum(pg_total_relation_size(c.oid)),0)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='prompix' and c.relkind='r') as "schemaBytes"`)).rows[0];
  const distribution = (await db.query(`select v.kind,v.content_type as "contentType",count(*)::integer as count,
    count(*) filter(where v.creator_id is not null)::integer as "attributedCount",
    coalesce(sum(cardinality(v.languages)),0)::integer as translations
    from prompix.release_entries e join prompix.revisions v on v.id=e.revision_id
    join prompix.content c on c.id=e.content_id
    where e.release_id=(select active_release from prompix.state where singleton) and c.removed_at is null
    group by v.kind,v.content_type order by v.kind,v.content_type`)).rows;
  const latestRun = (await db.query(`select id,started_at as "startedAt",finished_at as "finishedAt",state,published,
    release_id as release,counts from prompix.ingest_runs order by started_at desc limit 1`)).rows[0] ?? null;
  return { storage, distribution, latestRun };
}
