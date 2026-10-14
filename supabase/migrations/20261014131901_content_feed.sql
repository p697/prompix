-- Private content service. Neither public Data API role receives schema access.
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
create schema prompix;
revoke all on schema prompix from public;

create role prompix_reader nologin nosuperuser nobypassrls;
create role prompix_writer nologin nosuperuser nobypassrls;
grant usage on schema prompix to prompix_reader, prompix_writer;

create table prompix.content (
  id text primary key check (id ~ '^[a-z0-9-]{1,200}$'),
  created_at timestamptz not null default now(),
  removed_at timestamptz
);
create table prompix.releases (
  id text primary key check (id ~ '^[a-z0-9-]{1,200}$'),
  source_version text not null,
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  item_count integer not null check (item_count between 1 and 100000),
  removed_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  published_at timestamptz
);
create table prompix.revisions (
  id text primary key check (id ~ '^[a-f0-9]{64}$'),
  content_id text not null references prompix.content(id),
  original jsonb not null check (jsonb_typeof(original) = 'object'),
  card jsonb not null check (jsonb_typeof(card) = 'object'),
  kind text not null check (kind in ('text','image','video','web')),
  content_type text not null check (content_type in ('prompt','skill')),
  creator_id text,
  tags text[] not null,
  model text not null,
  languages text[] not null,
  search_text text not null,
  created_at timestamptz not null default now(),
  unique (content_id, id),
  check (original->>'id' = content_id and card->>'id' = content_id and card->>'revision' = id)
);
create index revisions_content on prompix.revisions(content_id);
create index revisions_kind on prompix.revisions(kind, content_type);
create index revisions_creator on prompix.revisions(creator_id);
create index revisions_model on prompix.revisions(model);
create index revisions_tags on prompix.revisions using gin(tags);
create index revisions_search on prompix.revisions using gin(search_text extensions.gin_trgm_ops);

create table prompix.translations (
  revision_id text not null references prompix.revisions(id),
  locale text not null check (locale in ('en','zh-Hans','zh-Hant','ja','ko','es','pt-BR','fr','de')),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  card jsonb not null check (jsonb_typeof(card) = 'object'),
  primary key (revision_id, locale)
);
create table prompix.release_entries (
  release_id text not null references prompix.releases(id),
  position integer not null check (position between 0 and 99999),
  content_id text not null,
  revision_id text not null,
  primary key (release_id, position),
  unique (release_id, content_id),
  foreign key (content_id, revision_id) references prompix.revisions(content_id, id)
);
create index release_entries_revision on prompix.release_entries(revision_id);
create index release_entries_content on prompix.release_entries(content_id);

create table prompix.state (
  singleton boolean primary key default true check (singleton),
  active_release text references prompix.releases(id),
  generation bigint not null default 0 check (generation >= 0),
  updated_at timestamptz not null default now()
);
insert into prompix.state(singleton) values(true);
-- All writers serialize on state before appending; a client cannot miss a late
-- committed lower sequence number when advancing its removal checkpoint.
create table prompix.removals (
  sequence bigint generated always as identity primary key,
  content_id text not null unique references prompix.content(id),
  removed_at timestamptz not null default now(),
  reason text not null check (length(reason) between 1 and 2000)
);
create table prompix.publication_events (
  id bigint generated always as identity primary key,
  release_id text not null references prompix.releases(id),
  previous_release text references prompix.releases(id),
  generation bigint not null unique,
  occurred_at timestamptz not null default now()
);
create index publication_events_release on prompix.publication_events(release_id);
create index publication_events_previous on prompix.publication_events(previous_release);

grant select on prompix.content, prompix.releases, prompix.revisions,
  prompix.translations, prompix.release_entries, prompix.state to prompix_reader;
grant select (sequence, content_id, removed_at) on prompix.removals to prompix_reader;
grant select, insert on all tables in schema prompix to prompix_writer;
grant update on prompix.content, prompix.releases, prompix.state to prompix_writer;
grant usage, select on all sequences in schema prompix to prompix_writer;

alter table prompix.content enable row level security;
alter table prompix.releases enable row level security;
alter table prompix.revisions enable row level security;
alter table prompix.translations enable row level security;
alter table prompix.release_entries enable row level security;
alter table prompix.state enable row level security;
alter table prompix.removals enable row level security;
alter table prompix.publication_events enable row level security;

create policy writer on prompix.content to prompix_writer using(true) with check(true);
create policy writer on prompix.releases to prompix_writer using(true) with check(true);
create policy writer on prompix.revisions to prompix_writer using(true) with check(true);
create policy writer on prompix.translations to prompix_writer using(true) with check(true);
create policy writer on prompix.release_entries to prompix_writer using(true) with check(true);
create policy writer on prompix.state to prompix_writer using(true) with check(true);
create policy writer on prompix.removals to prompix_writer using(true) with check(true);
create policy writer on prompix.publication_events to prompix_writer using(true) with check(true);

create policy reader on prompix.content for select to prompix_reader using(true);
create policy reader on prompix.state for select to prompix_reader using(true);
create policy reader on prompix.removals for select to prompix_reader using(true);
create policy reader on prompix.releases for select to prompix_reader using(published_at is not null);
create policy reader on prompix.release_entries for select to prompix_reader using (
  exists(select 1 from prompix.releases r where r.id = release_id and r.published_at is not null)
  and exists(select 1 from prompix.content c where c.id = content_id and c.removed_at is null)
);
create policy reader on prompix.revisions for select to prompix_reader using (
  exists(select 1 from prompix.release_entries e where e.revision_id = revisions.id)
);
create policy reader on prompix.translations for select to prompix_reader using (
  exists(select 1 from prompix.revisions r where r.id = revision_id)
);

alter default privileges in schema prompix revoke all on tables from public;
alter default privileges in schema prompix revoke execute on functions from public;
comment on schema prompix is 'Private, versioned content service; accessed only by dedicated application roles.';
