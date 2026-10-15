-- Staging is not publication. Keep first publication identity across edits, rollback and removal.
alter table prompix.content add column first_published_at timestamptz;
alter table prompix.content add column counts_toward_daily_limit boolean not null default false;
alter table prompix.release_entries add column latest_position integer check (latest_position between 0 and 99999);
grant update(latest_position) on prompix.release_entries to prompix_writer;

-- Historical import dates are the earliest retained publication evidence, not the original internet post date.
update prompix.content c set first_published_at=p.first_published_at from (
  select e.content_id,min(r.published_at) as first_published_at
  from prompix.release_entries e join prompix.releases r on r.id=e.release_id
  where r.published_at is not null group by e.content_id
) p where p.content_id=c.id;
with ranked as (
  select e.release_id,e.position,(row_number() over(partition by e.release_id order by c.first_published_at desc nulls last,e.position)-1)::integer as latest_position
  from prompix.release_entries e join prompix.content c on c.id=e.content_id
  join prompix.releases r on r.id=e.release_id where r.published_at is not null
) update prompix.release_entries e set latest_position=r.latest_position from ranked r
where e.release_id=r.release_id and e.position=r.position;
create index release_entries_latest on prompix.release_entries(release_id,latest_position) include(revision_id,content_id);
create index content_daily_publications on prompix.content(first_published_at) where counts_toward_daily_limit;
