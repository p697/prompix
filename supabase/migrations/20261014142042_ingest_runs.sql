-- Internal operational history. Never expose source logs or secrets through the feed role.
create table prompix.ingest_runs (
  id uuid primary key,
  started_at timestamptz not null,
  finished_at timestamptz,
  state text not null check (state in ('running','succeeded','failed')),
  published boolean not null default false,
  release_id text references prompix.releases(id),
  counts jsonb not null default '{}' check (jsonb_typeof(counts) = 'object' and octet_length(counts::text) <= 64000),
  sources jsonb not null default '{}' check (jsonb_typeof(sources) = 'object' and octet_length(sources::text) <= 64000),
  failure_code text check (failure_code in ('run_failed','status_persistence_failed')),
  check ((state='running' and finished_at is null) or (state<>'running' and finished_at is not null)),
  check (finished_at is null or finished_at >= started_at)
);
create index ingest_runs_started on prompix.ingest_runs(started_at desc);
create index ingest_runs_release on prompix.ingest_runs(release_id) where release_id is not null;
alter table prompix.ingest_runs enable row level security;
grant select, insert, update on prompix.ingest_runs to prompix_writer;
create policy writer_ingest_runs on prompix.ingest_runs to prompix_writer using (true) with check (true);
