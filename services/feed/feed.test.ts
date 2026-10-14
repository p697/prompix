import { createTestDatabase } from "./test-database.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFeedQuery, feedPageSchema, type FeedFilters } from "../../packages/schema/feed.ts";
import type { Prompt } from "../../packages/schema/catalog.ts";
import { translationFingerprint } from "../../ingest/translation.ts";
import { cursorLifetimeSeconds, encodeCursor, decodeCursor } from "./cursor.ts";
import type { Database, TransactionalDatabase } from "./database.ts";
import { activatePublication, exportPublication, exportRelease, preparePublication, removeContent, stagePublication } from "./publication.ts";
import { getCreators, getDetail, getFeed, getRemovals, getState } from "./queries.ts";
import { serveFeed } from "./http.ts";

const secret = "test-only-cursor-key-00000000000000000000000000000000";
const filters: FeedFilters = { locale: "original", q: "" };
function prompt(index: number): Prompt {
  return { id: `test-${index}`, kind: index % 2 ? "image" : "text", title: `Test ${index}`, summary: "Synthetic test content",
    prompt: `  Preserve whitespace ${index}\n`, example: "Example", tags: ["design"], model: "Test model", toolURL: null,
    artwork: "test", previewLabel: "Preview", source: { name: "Synthetic", url: null, license: "CC0", method: "test" },
    media: null, creator: { id: `author-${index % 5}`, platform: "web", displayName: `Author ${index % 5}`, profileURL: "https://example.com/author" } };
}
function localized(item: Prompt): Prompt {
  return { ...item, localization: { sourceLanguage: "en", sourceFingerprint: translationFingerprint(item), translations: {
    "zh-Hans": { title: "测试条目", summary: "中文版的摘要", prompt: "  独立数据库\n", example: "示例", previewLabel: "预览" },
  } } };
}

test("query validation rejects ambiguous, unbounded and malicious pagination", () => {
  for (const query of ["limit=0", "limit=-1", "limit=51", "limit=1e2", "limit=01", "limit=2&limit=3",
    "locale=xx", "kind=unknown", "sort=id", "cursor=", "q=a%00b", "creator=x%0a", "q=" + "x".repeat(121),
    "q=one+two+three+four+five+six+seven+eight+nine", "q=a%0Ab", "q=" + "ﬃ".repeat(100)])
    assert.throws(() => parseFeedQuery(new URL(`https://example.com/v3/feed?${query}`)), query);
  assert.equal(parseFeedQuery(new URL("https://example.com/v3/feed?q=ＡＢＣ%20%20DE")).filters.q, "abc de");
});

test("cursors bind filters, snapshots and expiry, reject tampering", () => {
  const now = 1_800_000_000_000;
  const cursor = { v: 2 as const, release: "test-release", position: 10, rank: 0, filters, expires: now / 1000 + cursorLifetimeSeconds };
  const token = encodeCursor(cursor, secret);
  assert.deepEqual(decodeCursor(token, filters, secret, now), cursor);
  for (const bad of [token + "x", "a" + token.slice(1), token.replace(".", ".."), "x".repeat(2049)])
    assert.throws(() => decodeCursor(bad, filters, secret, now));
  assert.throws(() => decodeCursor(token, { ...filters, q: "changed" }, secret, now));
  assert.throws(() => decodeCursor(token, filters, secret, now + cursorLifetimeSeconds * 1000));
  assert.throws(() => encodeCursor(cursor, "weak"));
});

test("PostgreSQL publication, permissions, paging and recovery", async t => {
  const { pg, writer, reader } = await createTestDatabase();
  t.after(() => pg.close());
  const input = { schemaVersion: 1 as const, version: "source-one", prompts: Array.from({ length: 121 }, (_, i) => i === 0 ? localized(prompt(i)) : prompt(i)) };
  const id = await stagePublication(writer, input);

  await t.test("staging is invisible and repeated import is idempotent", async () => {
    assert.equal(await stagePublication(writer, input), id);
    assert.equal((await reader.query("select id from prompix.revisions")).rows.length, 0);
    await assert.rejects(() => getState(reader), { message: "unavailable" });
    await assert.rejects(() => getDetail(reader, "test-0", "original"), { message: "not_found" });
    assert.equal((await writer.query("select id from prompix.revisions")).rows.length, 121);
    assert.equal((await reader.query("select creator_id from prompix.release_creators")).rows.length, 0);
    let batches = 0;
    const bounded: Database = { query: async <T extends Record<string, unknown>>(sql: string, values?: unknown[]) => {
      const result = await writer.query<T>(sql, values);
      if (sql.includes("limit 25")) { batches++; assert.ok(result.rows.length <= 25); }
      return result;
    } };
    assert.deepEqual((await exportRelease(bounded, id)).prompts, input.prompts);
    assert.equal(batches, 5);
    await activatePublication(writer, id, "0");
    await activatePublication(writer, id, "0");
    assert.equal((await getState(reader)).generation, "1");
  });

  let first: Awaited<ReturnType<typeof getFeed>>;
  await t.test("creator directory counts the full release and binds its own pagination", async () => {
    let page = await getCreators(reader, { q: "", limit: 2 }, secret);
    assert.equal(page.items[0].count, 25);
    const cursor = page.nextCursor!;
    const ids = page.items.map(item => item.creator.id);
    while (page.nextCursor) {
      page = await getCreators(reader, { q: "", limit: 2, cursor: page.nextCursor }, secret);
      ids.push(...page.items.map(item => item.creator.id));
    }
    assert.deepEqual(ids, ["author-0", "author-1", "author-2", "author-3", "author-4"]);
    assert.equal((await getCreators(reader, { q: "author 4", limit: 2 }, secret)).items[0].count, 24);
    assert.equal((await getCreators(reader, { q: "%", limit: 2 }, secret)).items.length, 0);
    await assert.rejects(() => getCreators(reader, { q: "other", limit: 2, cursor }, secret), { message: "invalid_request" });
    await assert.rejects(() => getFeed(reader, { filters, limit: 2, cursor }, secret), { message: "invalid_request" });
  });
  await t.test("every page is bounded, unique and in stable publication order", async () => {
    first = await getFeed(reader, { filters, limit: 17 }, secret);
    feedPageSchema.parse(first);
    let page = first;
    const seen: string[] = [];
    while (true) {
      seen.push(...page.items.map(item => item.id));
      assert.ok(page.items.length <= 17);
      assert.ok(page.items.every(item => !("prompt" in item) && !("source" in item) && !("skill" in item)));
      if (!page.nextCursor) break;
      page = await getFeed(reader, { filters, limit: 17, cursor: page.nextCursor }, secret);
    }
    assert.deepEqual(seen, input.prompts.map(item => item.id));
  });

  await t.test("filters, multilingual full-body search and literal wildcard input", async () => {
    const localizedPage = await getFeed(reader, { filters: { locale: "zh-Hans", q: "独立数据库" }, limit: 30 }, secret);
    assert.equal(localizedPage.items[0].title, "测试条目");
    assert.equal(localizedPage.items[0].language, "zh-Hans");
    assert.equal(localizedPage.items.length, 1);
    const images = await getFeed(reader, { filters: { ...filters, kind: "image", creator: "author-1", tag: "design", model: "Test model" }, limit: 50 }, secret);
    assert.ok(images.items.length > 0);
    assert.ok(images.items.every(item => item.kind === "image" && item.creator?.id === "author-1"));
    for (const q of ["%", "_", "' or 1=1 --", "\\", "不存在"])
      assert.equal((await getFeed(reader, { filters: { ...filters, q }, limit: 30 }, secret)).items.length, 0);
    assert.equal((await getFeed(reader, { filters: { ...filters, locale: "ja" }, limit: 1 }, secret)).items[0].language, "original");
  });

  await t.test("detail and export preserve exact original and approved translation bytes", async () => {
    const detail = await getDetail(reader, "test-0", "zh-Hans");
    assert.equal(detail.item.prompt, input.prompts[0].prompt);
    assert.equal(detail.item.localization?.translations["zh-Hans"]?.prompt, "  独立数据库\n");
    assert.deepEqual((await exportPublication(writer)).prompts, input.prompts);
    const emptyLocale = await getDetail(reader, "test-0", "ja");
    assert.deepEqual(emptyLocale.item.localization?.translations, {});
  });

  await t.test("an interrupted batched export is retryable without changing publication", async () => {
    const before = await getState(reader);
    let batches = 0;
    const fault: Database = { query: (sql, values) => {
      if (sql.includes("limit 25") && ++batches === 2) throw new Error("Interrupted export");
      return writer.query(sql, values);
    } };
    await assert.rejects(() => exportPublication(fault), /Interrupted export/);
    assert.deepEqual(await getState(reader), before);
    assert.deepEqual((await exportPublication(writer)).prompts, input.prompts);
  });

  await t.test("new release cannot move a cursor; stale activation fails without writes", async () => {
    const next = { ...input, version: "source-two", prompts: [prompt(1000), ...input.prompts.map(item => item.id === "test-1" ? { ...item, title: "Changed" } : item)] };
    const nextID = await stagePublication(writer, next);
    await assert.rejects(() => activatePublication(writer, nextID, "0"), { message: "conflict" });
    assert.equal((await getState(reader)).release, id);
    await activatePublication(writer, nextID, "1");
    const page = await getFeed(reader, { filters, limit: 17, cursor: first!.nextCursor! }, secret);
    assert.equal(page.release, id);
    assert.equal(page.items[0].id, "test-17");
    assert.equal((await getFeed(reader, { filters, limit: 1 }, secret)).items[0].id, "test-1000");
    const old = first!.items.find(item => item.id === "test-1")!;
    assert.equal((await getDetail(reader, old.id, "original", old.revision)).item.title, "Test 1");
    assert.equal((await getDetail(reader, old.id, "original")).item.title, "Changed");
  });

  await t.test("tombstones override history, detail revisions and rollback; changes are independently paged", async () => {
    const directory = await getCreators(reader, { q: "", limit: 2 }, secret);
    await removeContent(writer, ["test-1", "test-17", "unseen-id"], "Test removal");
    const page = await getFeed(reader, { filters, limit: 17, cursor: first!.nextCursor! }, secret);
    assert.equal(page.items[0].id, "test-18");
    const old = first!.items.find(item => item.id === "test-1")!;
    await assert.rejects(() => getDetail(reader, old.id, "original", old.revision), { message: "removed" });
    assert.equal((await reader.query("select id from prompix.revisions where content_id='test-1'")).rows.length, 0);
    const changes = await getRemovals(reader, "0", 2);
    assert.equal(changes.hasMore, true);
    assert.equal(changes.items.length, 2);
    assert.equal((await getRemovals(reader, changes.nextAfter, 2)).items.length, 1);
    await activatePublication(writer, id, (await getState(reader)).generation);
    assert.equal((await getState(reader)).count, 119);
    await assert.rejects(() => getDetail(reader, "test-1", "original"), { message: "removed" });
    assert.equal((await getCreators(reader, { q: "author 1", limit: 2 }, secret)).items[0].count, 23);
    const directoryNext = await getCreators(reader, { q: "", limit: 3, cursor: directory.nextCursor! }, secret);
    assert.deepEqual(directoryNext.items.map(item => item.creator.id), ["author-2", "author-3", "author-4"]);
  });

  await t.test("reader cannot mutate, see internal removal reasons or inspect publication audit", async () => {
    for (const sql of ["delete from prompix.content", "update prompix.state set active_release=null", "select reason from prompix.removals",
      "select * from prompix.publication_events", "create table prompix.evil(id int)"])
      await assert.rejects(() => reader.query(sql), /permission denied/);
    await assert.rejects(() => writer.query("update prompix.revisions set original='{}'::jsonb"), /permission denied/);
  });

  await t.test("failed staging rolls back all rows and leaves the active release intact", async () => {
    const before = await getState(reader);
    const fault: TransactionalDatabase = { ...writer, transaction: fn => writer.transaction(tx => fn({ query: (sql, values) => {
      if (sql.includes("insert into prompix.release_entries")) throw new Error("Injected storage failure");
      return tx.query(sql, values);
    } })) };
    const failed = { ...input, prompts: [prompt(4000)] };
    await assert.rejects(() => stagePublication(fault, failed), /Injected storage failure/);
    assert.equal((await writer.query("select id from prompix.content where id='test-4000'")).rows.length, 0);
    assert.deepEqual(await getState(reader), before);
    assert.equal((await writer.query("select id from prompix.releases where id=$1", [preparePublication(failed).id])).rows.length, 0);
  });

  await t.test("HTTP contract rejects unsafe input, serves HEAD and hides database errors", async () => {
    for (const path of ["/v3/feed?limit=500", "/v3/feed?cursor=forged", "/v3/contents/test-0?locale=bad", "/v3/contents/test-0?revision='",
      "/v3/removals?after=-1", "/v3/state?x=1", "/v3/feed?locale=en&locale=ja"])
      assert.equal((await serveFeed(new Request(`https://example.com${path}`), reader, secret)).status, 400, path);
    assert.equal((await serveFeed(new Request("https://example.com/v3/feed", { method: "POST" }), reader, secret)).status, 405);
    assert.equal((await serveFeed(new Request("https://example.com/v3/other"), reader, secret)).status, 404);
    const head = await serveFeed(new Request("https://example.com/v3/feed", { method: "HEAD" }), reader, secret);
    assert.equal(head.status, 200); assert.equal(await head.text(), ""); assert.equal(head.headers.get("cache-control"), "no-store");
    const broken: Database = { query: async () => { throw new Error("postgres://private-password@example.com"); } };
    const unavailable = await serveFeed(new Request("https://example.com/v3/feed"), broken, secret);
    assert.equal(unavailable.status, 503); assert.equal(await unavailable.text(), '{"error":"unavailable"}');
  });
});

test("10,000 items: keyset traversal has no omissions or duplicates", { timeout: 180000 }, async t => {
  const { pg, writer, reader } = await createTestDatabase(); t.after(() => pg.close());
  const start = performance.now();
  const prompts = Array.from({ length: 10000 }, (_, i) => prompt(i));
  const id = await stagePublication(writer, { schemaVersion: 1, version: "scale-test", prompts });
  await activatePublication(writer, id, "0");
  const importedMs = performance.now() - start;
  const seen = new Set<string>(); let cursor: string | undefined; let pages = 0; const times: number[] = [];
  do {
    const began = performance.now();
    const page = await getFeed(reader, { filters, limit: 50, cursor }, secret);
    times.push(performance.now() - began); pages++;
    for (const item of page.items) { assert.ok(!seen.has(item.id)); seen.add(item.id); }
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1_000_000);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(seen.size, 10000); assert.equal(pages, 200);
  assert.deepEqual([...seen], prompts.map(item => item.id));
  await pg.exec("analyze prompix.content; analyze prompix.releases; analyze prompix.revisions; analyze prompix.release_entries");
  let searchSQL = "", searchValues: unknown[] = [];
  const captured: Database = { query: (sql, values) => {
    searchSQL = sql; searchValues = values ?? []; return reader.query(sql, values);
  } };
  const search = await getFeed(captured, { filters: { ...filters, q: "preserve whitespace" }, limit: 50 }, secret);
  assert.deepEqual(search.items.map(item => item.id), prompts.slice(0, 50).map(item => item.id));
  assert.ok(search.nextCursor);
  const plan = (await reader.query<{ "QUERY PLAN": { Plan: Record<string, unknown>; "Execution Time": number }[] }>(
    "explain (analyze,format json) " + searchSQL, searchValues)).rows[0]["QUERY PLAN"][0];
  let contentRowsScanned = 0;
  const inspect = (node: Record<string, unknown>) => {
    if (node["Relation Name"] === "content" && node["Node Type"] === "Seq Scan")
      contentRowsScanned += Number(node["Actual Rows"]) * Number(node["Actual Loops"]);
    for (const child of (node.Plans ?? []) as Record<string, unknown>[]) inspect(child);
  };
  inspect(plan.Plan);
  // Assert work, not host-dependent elapsed time. The old plan scanned ~50 million rows.
  assert.ok(contentRowsScanned < 100000, `Repeated content scans: ${contentRowsScanned}`);
  times.sort((a, b) => a - b);
  t.diagnostic(JSON.stringify({ engine: "PGlite PostgreSQL", items: seen.size, pages, importedMs: Math.round(importedMs),
    pageMedianMs: Math.round(times[100]), pageP95Ms: Math.round(times[190]), pageMaxMs: Math.round(times[199]),
    broadSearchMs: Math.round(plan["Execution Time"]), contentRowsScanned }));
});
