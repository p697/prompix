import { exportPublicationHistory } from "../services/feed/publication-history.ts";
import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { withPublisherDatabase } from "../ingest/database-publication.ts";
import { exportRelease, preparePublication } from "../services/feed/publication.ts";
import { getState } from "../services/feed/queries.ts";

const [destination] = process.argv.slice(2);
const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
if (!destination || !isAbsolute(destination)) throw new Error("Provide an absolute backup path outside the repository");
await mkdir(dirname(destination), { recursive: true });
const parent = await realpath(dirname(destination));
const within = relative(root, resolve(parent, basename(destination)));
if (within !== ".." && !within.startsWith(".." + sep))
  throw new Error("Content backups cannot be stored in the source repository");

// One read-only snapshot prevents publication/removal changes between export batches.
const backup = await withPublisherDatabase(db => db.transaction(async tx => {
  await tx.query("set transaction isolation level repeatable read read only");
  const state = await getState(tx);
  const catalog = await exportRelease(tx, state.release);
  preparePublication(catalog);
  const firstPublications = await exportPublicationHistory(tx);
  return { format: "prompix-publication-backup-v2", firstPublications, createdAt: new Date().toISOString(), state, catalog };
}));
const bytes = JSON.stringify(backup);
await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
const summary = { format: backup.format, createdAt: backup.createdAt, release: backup.state.release,
  generation: backup.state.generation, removalSequence: backup.state.removalSequence,
  items: backup.catalog.prompts.length,
  translations: backup.catalog.prompts.reduce((sum, item) => sum + Object.keys(item.localization?.translations ?? {}).length, 0),
  removals: backup.catalog.removedIDs?.length ?? 0, bytes: Buffer.byteLength(bytes),
  sha256: createHash("sha256").update(bytes).digest("hex") };
await writeFile(destination + ".manifest.json", JSON.stringify(summary, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(summary));
