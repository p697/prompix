import { exportPublicationHistory, restorePublicationHistory } from "../services/feed/publication-history.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createTestDatabase } from "../services/feed/test-database.ts";
import { activatePublication, exportPublication, preparePublication, stagePublication } from "../services/feed/publication.ts";
import { getFeed, getRemovals, getState } from "../services/feed/queries.ts";

// Recovery rehearsal is always an isolated local PostgreSQL instance. No production writes.
const [source] = process.argv.slice(2);
if (!source || !isAbsolute(source)) throw new Error("Provide an absolute backup path");
const bytes = await readFile(source), manifest = JSON.parse(await readFile(source + ".manifest.json", "utf8"));
assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.sha256, "Backup checksum mismatch");
const backup = JSON.parse(bytes.toString("utf8"));
assert.ok(["prompix-publication-backup-v1", "prompix-publication-backup-v2"].includes(backup.format));
preparePublication(backup.catalog);
const { pg, writer, reader } = await createTestDatabase();
try {
  const release = await stagePublication(writer, backup.catalog);
  if (backup.format === "prompix-publication-backup-v2") await restorePublicationHistory(writer, backup.firstPublications);
  await activatePublication(writer, release, "0");
  if (backup.format === "prompix-publication-backup-v2") assert.deepEqual(await exportPublicationHistory(writer), backup.firstPublications);
  const restored = await exportPublication(writer);
  assert.deepEqual(restored.prompts, backup.catalog.prompts, "Restored content differs");
  assert.deepEqual([...(restored.removedIDs ?? [])].sort(), [...(backup.catalog.removedIDs ?? [])].sort());
  assert.equal((await getState(reader)).count, backup.catalog.prompts.length);
  const page = await getFeed(reader, { filters: { locale: "original", q: "" }, limit: 30 }, "local-backup-rehearsal-key-0000000000000000000000000");
  assert.deepEqual(page.items.map(item => item.id), backup.catalog.prompts.slice(0, 30).map((item: { id: string }) => item.id));
  let after = "0", more = true;
  const removed: string[] = [];
  while (more) {
    const page = await getRemovals(reader, after);
    removed.push(...page.items.map(item => item.id)); after = page.nextAfter; more = page.hasMore;
  }
  assert.deepEqual(removed.sort(), [...(backup.catalog.removedIDs ?? [])].sort());
  console.log(JSON.stringify({ verified: true, productionWritten: false, engine: "PGlite PostgreSQL",
    items: restored.prompts.length, removals: restored.removedIDs?.length ?? 0, backupSHA256: manifest.sha256 }));
} finally { await pg.close(); }
