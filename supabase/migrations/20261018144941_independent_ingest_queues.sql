-- Private, durable stage queues. No content, secrets or public enqueue endpoint.
create table prompix.queue_controls (
  id text primary key check(id='ingest'), max_active integer not null check(max_active between 1 and 6)
);
insert into prompix.queue_controls values ('ingest',3);
create table prompix.queue_jobs (
  id text primary key check(length(id) between 1 and 200),
  run_id text not null check(length(run_id) between 1 and 100),
  stage text not null check(stage in ('collect','review','translate','semantic','locale')),
  identity text not null check(identity ~ '^[a-f0-9]{64}$'),
  payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=64000),
  dependency text references prompix.queue_jobs(id),
  priority integer not null default 0 check(priority between 0 and 10),
  state text not null default 'queued' check(state in ('queued','leased','succeeded','retry','reconcile','rejected')),
  attempts integer not null default 0 check(attempts>=0),
  max_attempts integer not null default 3 check(max_attempts between 1 and 5),
  available_at timestamptz not null default now(),
  lease_token uuid, lease_until timestamptz,
  output jsonb check(octet_length(output::text)<=64000),
  created_at timestamptz not null default now(), finished_at timestamptz,
  check ((state='leased' and lease_token is not null and lease_until is not null) or (state<>'leased' and lease_token is null and lease_until is null)),
  check (dependency is null or dependency<>id),
  unique(run_id,stage,identity)
);
create index queue_claim on prompix.queue_jobs(stage,priority desc,available_at,created_at) where state in ('queued','retry');
create index queue_expired on prompix.queue_jobs(lease_until) where state='leased';
create index queue_dependency on prompix.queue_jobs(dependency) where dependency is not null;
create index queue_run on prompix.queue_jobs(run_id,state);
create table prompix.queue_attempts (
  job_id text not null references prompix.queue_jobs(id), attempt integer not null,
  token uuid not null unique, started_at timestamptz not null default now(), finished_at timestamptz,
  outcome text not null default 'reserved' check(outcome in ('reserved','succeeded','retry','reconcile','rejected')),
  evidence jsonb not null default '{}' check(octet_length(evidence::text)<=64000),
  primary key(job_id,attempt)
);
alter table prompix.queue_controls enable row level security;
alter table prompix.queue_jobs enable row level security;
alter table prompix.queue_attempts enable row level security;
revoke all on prompix.queue_controls,prompix.queue_jobs,prompix.queue_attempts from public;
grant select,update on prompix.queue_controls to prompix_writer;
grant select,insert,update on prompix.queue_jobs,prompix.queue_attempts to prompix_writer;
create policy writer_queue_controls on prompix.queue_controls to prompix_writer using(true) with check(true);
create policy writer_queue_jobs on prompix.queue_jobs to prompix_writer using(true) with check(true);
create policy writer_queue_attempts on prompix.queue_attempts to prompix_writer using(true) with check(true);
