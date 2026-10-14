-- Cover the composite revision FK for retained-release cleanup. This also
-- serves lookups that previously used the content-only index.
create index release_entries_content_revision on prompix.release_entries(content_id,revision_id);
drop index prompix.release_entries_content;
