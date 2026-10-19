import { historyAllowanceIDs, type HistoryAllowance } from "./history-allowance.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import { catalogSchema, localizationLanguages, type Prompt } from "../../packages/schema/catalog.ts";
import { contentID, feedCardSchema, detailResponseByteLimit, type FeedCard, type FeedLocale } from "../../packages/schema/feed.ts";
import { canonicalArtifact, validateArtifact } from "../../ingest/language-packs.ts";
import { translationFingerprint } from "../../ingest/translation.ts";
import { FeedError, type Database, type TransactionalDatabase } from "./database.ts";

export const databaseLibraryLimit = 100000;
const inputSchema = z.object({ ...catalogSchema.shape, prompts: z.array(catalogSchema.shape.prompts.element).min(1).max(databaseLibraryLimit) }).strict();
export type PublicationInput = z.infer<typeof inputSchema>;
export function preservePublicationInput(input: PublicationInput): PublicationInput {
  validateArtifact(inputSchema, input);
  const ids = new Set<string>(), removed = new Set(input.removedIDs ?? []);
  for (const item of input.prompts) {
    if (ids.has(item.id) || removed.has(item.id)) throw new Error("Duplicate or removed content ID");
    ids.add(item.id);
  }
  return input;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonicalArtifact(value))).digest("hex");

function cardFor(item: Prompt, revision: string, locale: FeedLocale, languages: string[]): FeedCard {
  const translated = locale === "original" ? undefined : item.localization?.translations[locale];
  const card = feedCardSchema.parse({
    id: item.id, revision, kind: item.kind, contentType: item.contentType ?? "prompt",
    title: translated?.title ?? item.title, summary: translated?.summary ?? item.summary,
    tags: item.tags, model: item.model, artwork: item.artwork,
    previewLabel: translated?.previewLabel ?? item.previewLabel,
    creator: item.creator, media: item.media, presentation: item.presentation,
    cover: item.cover ? { ...item.cover, ...(translated?.cover ?? {}) } : undefined,
    language: translated ? locale : "original", availableLanguages: languages,
  });
  // Fifty cards plus cursor and envelope must always fit the public byte budget.
  if (Buffer.byteLength(JSON.stringify(card)) > 18000) throw new Error(`Feed card exceeds byte limit: ${item.id}`);
  return card;
}

export function preparePublication(input: PublicationInput) {
  preservePublicationInput(input);
  const ids = new Set<string>(), removed = [...new Set(input.removedIDs ?? [])].sort();
  removed.forEach(id => contentID.parse(id));
  const removedSet = new Set(removed);
  const records = input.prompts.map((item, position) => {
    contentID.parse(item.id);
    if (item.presentation === "explicit") throw new Error(`Explicit visual content cannot be published: ${item.id}`);
    if (ids.has(item.id) || removedSet.has(item.id)) throw new Error("Duplicate or removed content ID");
    ids.add(item.id);
    if (item.localization && item.localization.sourceFingerprint !== translationFingerprint(item))
      throw new Error(`Original source fingerprint mismatch: ${item.id}`);
    const revision = hash(item);
    const languages = localizationLanguages.filter(locale => item.localization?.translations[locale]);
    const original = { ...item, ...(item.localization ? { localization: { ...item.localization, translations: {} } } : {}) };
    if (Buffer.byteLength(JSON.stringify(item)) > detailResponseByteLimit - 4096)
      throw new Error(`Content exceeds detail byte limit: ${item.id}`);
    const translations = languages.map(locale => ({
      revision_id: revision, locale, content: item.localization!.translations[locale]!,
      card: cardFor(item, revision, locale, languages),
    }));
    return {
      id: revision, content_id: item.id, original, card: cardFor(item, revision, "original", languages),
      kind: item.kind, content_type: item.contentType ?? "prompt", creator_id: item.creator?.id ?? null,
      tags: item.tags, model: item.model, languages, search_text: "",
      position, translations,
    };
  });
  const digest = hash({ entries: records.map(row => row.id), removed });
  return { id: `feed-${digest}`, digest, sourceVersion: input.version, removed, records };
}

/** Stage is atomic and idempotent; an interrupted import exposes no partial data. */
export async function stagePublication(db: TransactionalDatabase, input: PublicationInput): Promise<string> {
  const release = preparePublication(input);
  await db.transaction(async tx => {
    // Serialize staging the same immutable release, without blocking live reads.
    await tx.query("select pg_advisory_xact_lock(hashtext($1))", [release.id]);
    const existing = await tx.query("select id from prompix.releases where id = $1", [release.id]);
    if (existing.rows.length) return;
    await tx.query(`insert into prompix.releases(id, source_version, digest, item_count, removed_ids)
      values($1,$2,$3,$4,$5)`, [release.id, release.sourceVersion, release.digest, release.records.length, release.removed]);
    await tx.query("insert into prompix.content(id) select unnest($1::text[]) on conflict do nothing", [[...release.records.map(row => row.content_id), ...release.removed]]);
    for (let start = 0; start < release.records.length; start += 50) {
      const batch = release.records.slice(start, start + 50);
      // Revision IDs hash complete original + translations. Existing immutable rows
      // need only a new release entry, not another transfer of their large bodies.
      const existingIDs = new Set((await tx.query<{ id: string }>("select id from prompix.revisions where id=any($1::text[])", [batch.map(row => row.id)])).rows.map(row => row.id));
      const fresh = batch.filter(row => !existingIDs.has(row.id));
      if (fresh.length) await tx.query(`insert into prompix.revisions(id,content_id,original,card,kind,content_type,creator_id,tags,model,languages,search_text)
        select id,content_id,original,card,kind,content_type,creator_id,tags,model,languages,search_text
        from jsonb_to_recordset($1::jsonb) as x(id text,content_id text,original jsonb,card jsonb,kind text,
          content_type text,creator_id text,tags text[],model text,languages text[],search_text text)
        on conflict(id) do nothing`, [JSON.stringify(fresh)]);
      const translations = fresh.flatMap(row => row.translations);
      if (translations.length) await tx.query(`insert into prompix.translations(revision_id,locale,content,card)
        select revision_id,locale,content,card from jsonb_to_recordset($1::jsonb)
        as x(revision_id text,locale text,content jsonb,card jsonb) on conflict do nothing`, [JSON.stringify(translations)]);
      if (fresh.length) await tx.query(`with prepared as (
        select v.id,fields.* from prompix.revisions v cross join lateral prompix.search_fields(v.original,
          (select jsonb_object_agg(t.locale,t.content) from prompix.translations t where t.revision_id=v.id)) fields
        where v.id=any($1::text[])
      ) update prompix.revisions v set search_titles=p.search_titles,search_creator=p.search_creator,
        search_metadata=p.search_metadata,search_text=p.search_text from prepared p where p.id=v.id`, [fresh.map(row => row.id)]);
      await tx.query(`insert into prompix.release_entries(release_id,position,content_id,revision_id)
        select $1,position,content_id,id from jsonb_to_recordset($2::jsonb) as x(position integer,content_id text,id text)`,
        [release.id, JSON.stringify(batch.map(({ position, content_id, id }) => ({ position, content_id, id })))]);
    }
    await tx.query(`insert into prompix.release_creators(release_id,creator_id,creator,item_count,search_text)
      select $1,creator_id,creator,item_count,
        prompix.normalize_search(concat_ws(' ',creator->>'displayName',creator->>'username',
          '@' || ltrim(creator->>'username','@'),creator->>'platform'))
      from (
        select v.creator_id,v.card->'creator' as creator,
          count(*) over(partition by v.creator_id)::integer as item_count,
          row_number() over(partition by v.creator_id order by
            (v.card->'creator' ? 'externalID') desc,
            ((v.card->'creator' ? 'bio')::integer + (v.card->'creator' ? 'avatarURL')::integer) desc,e.position) as preference
        from prompix.release_entries e join prompix.revisions v on v.id=e.revision_id
        where e.release_id=$1 and v.creator_id is not null
      ) ranked where preference=1`, [release.id]);
  });
  return release.id;
}

async function removeLocked(tx: Database, ids: string[], reason: string): Promise<void> {
  if (!ids.length) return;
  await tx.query("insert into prompix.content(id) select unnest($1::text[]) on conflict do nothing", [ids]);
  await tx.query("update prompix.content set removed_at = coalesce(removed_at,now()) where id = any($1::text[])", [ids]);
  await tx.query(`insert into prompix.removals(content_id,reason)
    select unnest($1::text[]),$2 on conflict(content_id) do nothing`, [ids, reason]);
}

export async function removeContent(db: TransactionalDatabase, ids: string[], reason: string): Promise<void> {
  if (!ids.length || ids.length > 10000 || !reason.trim() || reason.length > 2000) throw new Error("Invalid removal request");
  ids.forEach(id => contentID.parse(id));
  await db.transaction(async tx => {
    await tx.query("select singleton from prompix.state where singleton for update");
    await removeLocked(tx, ids, reason);
    await tx.query("update prompix.state set generation = generation + 1, updated_at = now() where singleton");
  });
}

/** The generation protects against stale writers, including an A -> B -> A race. */
export async function activatePublication(db: TransactionalDatabase, id: string, expectedGeneration: string, historical?: HistoryAllowance): Promise<void> {
  contentID.parse(id);
  if (!/^(0|[1-9][0-9]{0,17})$/.test(expectedGeneration)) throw new Error("Invalid generation");
  await db.transaction(async tx => {
    const state = (await tx.query<{ active_release: string | null; generation: string }>(
      "select active_release, generation::text from prompix.state where singleton for update")).rows[0];
    if (state.active_release === id) return;
    if (state.generation !== expectedGeneration) throw new FeedError("conflict", 409);
    const release = (await tx.query<{ item_count: number; removed_ids: string[] }>(
      "select item_count,removed_ids from prompix.releases where id=$1", [id])).rows[0];
    if (!release) throw new FeedError("not_found", 404);
    const count = (await tx.query<{ count: number }>(
      "select count(*)::integer as count from prompix.release_entries where release_id=$1", [id])).rows[0].count;
    if (count !== release.item_count) throw new FeedError("conflict", 409);
    const historicalIDs = historyAllowanceIDs(historical);
    // The state row lock serializes the daily ceiling across concurrent writers and rollback.
    if (state.active_release) {
      const quota = (await tx.query<{ used: number; incoming: number }>(`select
        (select count(*)::integer from prompix.content where counts_toward_daily_limit
          and first_published_at >= (date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')) as used,
        (select count(*)::integer from prompix.release_entries e join prompix.content c on c.id=e.content_id
          where e.release_id=$1 and c.first_published_at is null and c.removed_at is null and not(c.id=any($2::text[]))) as incoming`, [id, historicalIDs])).rows[0];
      if (quota.used + quota.incoming > 100) throw new Error("Daily new-publication ceiling exceeded");
    }
    await tx.query(`update prompix.content c set first_published_at=now(),counts_toward_daily_limit=($2 and not(c.id=any($3::text[])))
      from prompix.release_entries e where e.release_id=$1 and e.content_id=c.id and c.first_published_at is null and c.removed_at is null`,
      [id, !!state.active_release, historicalIDs]);
    // Assign once per immutable release. Rollback keeps its original pagination order.
    await tx.query(`with ranked as (
      select e.position,(row_number() over(order by c.first_published_at desc nulls last,e.position)-1)::integer as latest_position
      from prompix.release_entries e join prompix.content c on c.id=e.content_id where e.release_id=$1
    ) update prompix.release_entries e set latest_position=r.latest_position from ranked r
      where e.release_id=$1 and e.position=r.position and e.latest_position is null`, [id]);
    await removeLocked(tx, release.removed_ids, "Publication removal");
    await tx.query("update prompix.releases set published_at=coalesce(published_at,now()) where id=$1", [id]);
    const next = (await tx.query<{ generation: string }>(`update prompix.state set active_release=$1,
      generation=generation+1,updated_at=now() where singleton returning generation::text`, [id])).rows[0];
    await tx.query("insert into prompix.publication_events(release_id,previous_release,generation) values($1,$2,$3)",
      [id, state.active_release, next.generation]);
  });
}

/** Internal publisher export; keyset batches also bound verification/backup queries. */
export async function exportRelease(db: Database, release: string): Promise<PublicationInput> {
  contentID.parse(release);
  const metadata = (await db.query<{ removed_ids: string[] }>("select removed_ids from prompix.releases where id=$1", [release])).rows[0];
  if (!metadata) throw new FeedError("not_found", 404);
  const prompts: Prompt[] = [];
  let position = -1;
  while (true) {
    const rows = (await db.query<{ position: number; original: Prompt; translations: NonNullable<Prompt["localization"]>["translations"]; has_more: boolean }>(`
      with page as materialized (
        select e.position, v.original, coalesce((select jsonb_object_agg(t.locale,t.content)
          from prompix.translations t where t.revision_id=v.id),'{}'::jsonb) as translations
        from prompix.release_entries e join prompix.revisions v on v.id=e.revision_id
        join prompix.content c on c.id=e.content_id
        where e.release_id=$1 and e.position>$2 and c.removed_at is null order by e.position limit 25
      ), sized as (
        select *, sum(octet_length(original::text)+octet_length(translations::text)) over(order by position) as bytes,
          row_number() over(order by position) as ordinal from page
      ) select position,original,translations,
        ((select count(*) from page)=25 or position<(select max(position) from page)) as has_more
        from sized where bytes<=262144 or ordinal=1 order by position`, [release, position])).rows;
    for (const { original, translations } of rows) prompts.push({ ...original,
      ...(original.localization ? { localization: { ...original.localization, translations } } : {}) });
    if (!rows.length || !rows.at(-1)!.has_more) break;
    position = rows.at(-1)!.position;
  }
  const removals = await db.query<{ content_id: string }>("select content_id from prompix.removals order by sequence");
  const removed = new Set([...metadata.removed_ids, ...removals.rows.map(row => row.content_id)]);
  // A removal committed during a multi-batch export must not remain in its body.
  return { schemaVersion: 1, version: release, prompts: prompts.filter(item => !removed.has(item.id)), removedIDs: [...removed] };
}

/** Publisher baseline includes all approved translations, independent of legacy export limits. */
export async function exportPublication(db: Database): Promise<PublicationInput> {
  const active = (await db.query<{ active_release: string | null }>("select active_release from prompix.state where singleton")).rows[0]?.active_release;
  if (!active) throw new FeedError("unavailable", 503);
  return exportRelease(db, active);
}
