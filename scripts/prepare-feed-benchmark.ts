import { randomBytes } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "../services/feed/database.ts";
import { encodeCursor } from "../services/feed/cursor.ts";
import { getCreators, getFeed } from "../services/feed/queries.ts";

// Generates a transaction-only hosted benchmark. Execution is an explicit operator step.
// All schema/data changes roll back; the production publication pointer is never changed.
const [destination] = process.argv.slice(2), root = fileURLToPath(new URL("../", import.meta.url));
const includePlans = process.argv[3] === "--plans", rounds = includePlans ? 1 : 3;
if (!destination || !isAbsolute(destination) || !relative(root, resolve(destination)).startsWith(".."))
  throw new Error("Provide an absolute SQL output path outside the repository");
const schema = "prompix_benchmark_" + randomBytes(6).toString("hex");
const release = "feed-" + "a".repeat(64), secret = "benchmark-only-cursor-0000000000000000000000000000000000000";
const literal = (value: unknown): string => value === null ? "null" : Array.isArray(value)
  ? `array[${value.map(literal).join(",")}]::text[]` : typeof value === "number" ? String(value) : "'" + String(value).replaceAll("'", "''") + "'";
const cases: { name: string; query: string }[] = [];
let caseName = "";
const capture: Database = { async query<T extends Record<string, unknown>>(sql: string, values: unknown[] = []) {
  if (sql.includes("from prompix.state s")) return { rows: [{ release, generation: "1", removalSequence: "0", count: 10000, publishedAt: null } as unknown as T] };
  if (sql.startsWith("select id from prompix.releases")) return { rows: [{ id: release } as unknown as T] };
  cases.push({ name: caseName, query: sql.replace(/\$(\d+)/g, (_, index) => literal(values[Number(index) - 1])).replaceAll("prompix.", schema + ".") });
  return { rows: [] };
} };
const filters = { locale: "original" as const, q: "" };
caseName = "first_page"; await getFeed(capture, { filters, limit: 30 }, secret);
caseName = "after_9000"; await getFeed(capture, { filters, limit: 30, cursor: encodeCursor({ v: 2, release, position: 9000, rank: 0, filters, expires: Math.floor(Date.now() / 1000) + 3600 }, secret) }, secret);
caseName = "type_and_tag"; await getFeed(capture, { filters: { ...filters, kind: "image", tag: "group-18" }, limit: 30 }, secret);
caseName = "search_relevance"; await getFeed(capture, { filters: { ...filters, q: "benchmark story" }, limit: 30 }, secret);
caseName = "creator_directory"; await getCreators(capture, { q: "", limit: 50 }, secret);

const directory = new URL("../supabase/migrations/", import.meta.url);
let sql = `begin;\nset local statement_timeout='60s';\nset local lock_timeout='3s';\nset local application_name='prompix-isolated-benchmark';\n`;
for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) {
  sql += (await readFile(new URL(name, directory), "utf8"))
    .replace(/^create role prompix_(reader|writer).*;\n/gm, "")
    .replace(/\bprompix\./g, schema + ".").replace(/\bschema prompix\b/g, "schema " + schema) + "\n";
}
sql += `
insert into ${schema}.releases(id,source_version,digest,item_count,published_at) values('${release}','synthetic-benchmark','${"a".repeat(64)}',10000,now());
insert into ${schema}.content(id) select 'bench-' || i from generate_series(1,10000) i;
with fixtures as (
  select i,'bench-' || i as id,md5(i::text) || md5(i::text) as revision,
    jsonb_build_object('id','bench-' || i,'kind',case when i%2=0 then 'image' else 'text' end,
      'title',case when i%11=0 then 'Benchmark story' else 'Synthetic original ' || i end,
      'summary','First-party load fixture','prompt',repeat('Write a benchmark story about a teacup. ',25),
      'example','A synthetic example','previewLabel','Preview','model','Model ' || (i%5),'artwork','test',
      'tags',jsonb_build_array('synthetic','group-' || (i%100)),'media',null,'toolURL',null,
      'source',jsonb_build_object('name','Prompix','license','Original','method','Synthetic benchmark','url',null),
      'creator',jsonb_build_object('id','creator-' || (i%500),'displayName','Creator ' || (i%500),'platform','web','profileURL','https://example.com/creator')) as original
  from generate_series(1,10000) i
) insert into ${schema}.revisions(id,content_id,original,card,kind,content_type,creator_id,tags,model,languages,search_text)
select revision,id,original,(original-'prompt'-'example'-'source'-'toolURL') || jsonb_build_object('revision',revision,'contentType','prompt','language','original','availableLanguages',jsonb_build_array('en','fr','ja')),
  original->>'kind','prompt',original->'creator'->>'id',array['synthetic','group-' || (i%100)],original->>'model',array['en','fr','ja'],'' from fixtures;
insert into ${schema}.translations(revision_id,locale,content,card)
select v.id,locale,jsonb_build_object('title','Translated ' || locale,'summary','Synthetic summary','prompt',repeat('A translated benchmark story. ',25),'example','Synthetic example','previewLabel','Preview'),v.card
from ${schema}.revisions v cross join unnest(array['en','fr','ja']) locale;
insert into ${schema}.release_entries(release_id,position,content_id,revision_id)
select '${release}',substring(content_id from 7)::integer-1,content_id,id from ${schema}.revisions;
with fields as (select v.id,f.* from ${schema}.revisions v cross join lateral ${schema}.search_fields(v.original,
  (select jsonb_object_agg(t.locale,t.content) from ${schema}.translations t where t.revision_id=v.id)) f)
update ${schema}.revisions v set search_text=f.search_text,search_titles=f.search_titles,search_creator=f.search_creator,search_metadata=f.search_metadata from fields f where f.id=v.id;
insert into ${schema}.release_creators(release_id,creator_id,creator,item_count,search_text)
select '${release}',creator_id,(array_agg(card->'creator'))[1],count(*)::integer,min(search_creator) from ${schema}.revisions group by creator_id;
update ${schema}.state set active_release='${release}',generation=1 where singleton;
analyze ${schema}.content; analyze ${schema}.releases; analyze ${schema}.revisions; analyze ${schema}.translations; analyze ${schema}.release_entries; analyze ${schema}.release_creators;
create function ${schema}.measure(query text) returns jsonb language plpgsql set search_path='' as $measure$
declare plan jsonb; begin execute 'explain (analyze,buffers,format json) ' || query into plan;
return jsonb_build_object('planningMs',plan->0->'Planning Time','executionMs',plan->0->'Execution Time','rows',plan->0->'Plan'->'Actual Rows',
  'sharedHits',plan->0->'Plan'->'Shared Hit Blocks','sharedReads',plan->0->'Plan'->'Shared Read Blocks'${includePlans ? ", 'plan',plan->0->'Plan'" : ""}); end $measure$;
revoke all on function ${schema}.measure(text) from public; grant execute on function ${schema}.measure(text) to prompix_reader;
grant prompix_reader to current_user;
set local role prompix_reader;
select jsonb_build_object('schema',${literal(schema)},'role',current_user,'rows',10000,'translations',30000,'measurements',jsonb_agg(result)) as benchmark
from (values ${Array.from({ length: rounds }, (_, repeat) => cases.map(item => `(jsonb_build_object('case',${literal(item.name)},'round',${repeat + 1},'measurement',${schema}.measure(${literal(item.query)})))`)).flat().join(",\n")}) results(result);
reset role;
rollback;
`;
await writeFile(destination, sql, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ prepared: true, executed: false, schema, rows: 10000, translations: 30000, queryCases: cases.length, rounds, destination }));
