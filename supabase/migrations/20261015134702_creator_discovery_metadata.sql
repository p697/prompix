-- Immutable, small creator summaries keep discovery keysets stable even when
-- RLS hides a removed work or an entire creator during a browsing session.
alter table prompix.release_creators add column discovery jsonb;
grant update(discovery) on prompix.release_creators to prompix_writer;

create function prompix.prepare_creator_discovery(target_release text) returns void
language sql security invoker set search_path = '' as $$
  with works as (
    select v.creator_id,e.latest_position,
      case when v.content_type='skill' then 'skill' else v.kind end as kind,
      (v.kind in ('image','video','web') and v.content_type<>'skill' and
        (v.card->'media'->>'imageURL' is not null or v.card->'media'->>'image' is not null
         or (v.kind='web' and v.card->'media'->>'demoURL' is not null))) as visual
    from prompix.release_entries e join prompix.revisions v on v.id=e.revision_id
    where e.release_id=target_release and v.creator_id is not null
  ), summaries as (
    select creator_id,coalesce(kind,'all') as kind,count(*)::integer as total,
      min(latest_position) as latest,count(*) filter(where visual)::integer as visual
    from works group by grouping sets ((creator_id,kind),(creator_id))
  ), packed as (
    select creator_id,jsonb_object_agg(kind,jsonb_build_object('total',total,'latest',latest,'visual',visual)) as discovery
    from summaries group by creator_id
  ) update prompix.release_creators rc set discovery=p.discovery from packed p
    where rc.release_id=target_release and rc.creator_id=p.creator_id and rc.discovery is null;
$$;
revoke all on function prompix.prepare_creator_discovery(text) from public;
grant execute on function prompix.prepare_creator_discovery(text) to prompix_writer;

create function prompix.on_creator_discovery_publication() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  perform prompix.prepare_creator_discovery(new.id);
  return new;
end;
$$;
revoke all on function prompix.on_creator_discovery_publication() from public;
grant execute on function prompix.on_creator_discovery_publication() to prompix_writer;
create trigger creator_discovery_publication after update of published_at on prompix.releases
for each row when (old.published_at is null and new.published_at is not null)
execute function prompix.on_creator_discovery_publication();

select prompix.prepare_creator_discovery(id) from prompix.releases where published_at is not null;
