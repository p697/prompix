-- Versioned directory ordering is stable during paging; live counts exclude removals.
create table prompix.release_creators (
  release_id text not null references prompix.releases(id),
  creator_id text not null,
  creator jsonb not null check (creator->>'id' = creator_id),
  item_count integer not null check (item_count between 1 and 100000),
  search_text text not null,
  primary key (release_id,creator_id)
);
create index release_creators_order on prompix.release_creators(release_id,item_count desc,creator_id);
create index release_creators_search on prompix.release_creators using gin(search_text extensions.gin_trgm_ops);
alter table prompix.release_creators enable row level security;
grant select on prompix.release_creators to prompix_reader;
grant select,insert on prompix.release_creators to prompix_writer;
create policy writer on prompix.release_creators to prompix_writer using(true) with check(true);
create policy reader on prompix.release_creators for select to prompix_reader using(
  exists(select 1 from prompix.releases r where r.id=release_id and r.published_at is not null)
  and exists(select 1 from prompix.release_entries e join prompix.revisions v on v.id=e.revision_id
    where e.release_id=release_creators.release_id and v.creator_id=release_creators.creator_id)
);

insert into prompix.release_creators(release_id,creator_id,creator,item_count,search_text)
select release_id,creator_id,creator,item_count,
  lower(normalize(concat_ws(' ',creator->>'displayName',creator->>'username',creator->>'platform'),NFKC))
from (
  select e.release_id,v.creator_id,v.card->'creator' as creator,
    count(*) over(partition by e.release_id,v.creator_id)::integer as item_count,
    row_number() over(partition by e.release_id,v.creator_id order by
      (v.card->'creator' ? 'externalID') desc,
      ((v.card->'creator' ? 'bio')::integer + (v.card->'creator' ? 'avatarURL')::integer) desc,e.position) as preference
  from prompix.release_entries e join prompix.revisions v on v.id=e.revision_id
  where v.creator_id is not null
) ranked where preference=1;
