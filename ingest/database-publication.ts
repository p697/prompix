import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Catalog } from "../packages/schema/catalog.ts";
import type { TransactionalDatabase } from "../services/feed/database.ts";
import { activatePublication, exportRelease, stagePublication } from "../services/feed/publication.ts";
import { connectDatabase, publisherConfiguration } from "../services/feed/postgres.ts";
import { retryConnection } from "./transient-retry.ts";

const releaseID = z.string().regex(/^feed-[a-f0-9]{64}$/);
const generation = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
export const databasePointerSchema = z.object({ release: releaseID, generation }).strict();
export const databaseIntentSchema = z.object({ release: releaseID, observed: databasePointerSchema }).strict();
export type DatabasePointer = z.infer<typeof databasePointerSchema>;
export type DatabaseIntent = z.infer<typeof databaseIntentSchema>;

export interface DatabasePublisher {
  pointer(): Promise<DatabasePointer>;
  read(release: string): Promise<Catalog>;
  stage(catalog: Catalog): Promise<string>;
  activate(intent: DatabaseIntent): Promise<void>;
}

/** The adapter also lets recovery tests use real SQL without production credentials. */
export function databasePublisher(using: <T>(operation: (db: TransactionalDatabase) => Promise<T>) => Promise<T>): DatabasePublisher {
  const pointer = () => using(async db => {
    const row = (await db.query("select active_release as release,generation::text from prompix.state where singleton")).rows[0];
    // Bootstrap is a separate verified migration, never an implicit empty fallback.
    return databasePointerSchema.parse(row);
  });
  return {
    pointer,
    read: release => using(db => exportRelease(db, release)),
    stage: catalog => using(db => stagePublication(db, catalog)),
    async activate(intent) {
      await assertDatabaseReconciled(intent, await pointer());
      await using(db => activatePublication(db, intent.release, intent.observed.generation));
      await assertDatabaseActivated(intent, await pointer());
    },
  };
}

export async function withPublisherDatabase<T>(operation: (db: TransactionalDatabase) => Promise<T>, environment: NodeJS.ProcessEnv = process.env): Promise<T> {
  const path = environment.PROMPIX_DATABASE_CA;
  if (!path) throw new Error("Database publisher CA is not configured");
  const config = { ...publisherConfiguration(environment, await readFile(path, "utf8")),
    query_timeout: 30000, statement_timeout: 25000, lock_timeout: 5000, idle_in_transaction_session_timeout: 30000 };
  // No query has executed yet. Never replay an uncertain transaction commit here.
  const db = await retryConnection(() => connectDatabase(config));
  try { return await operation(db); } finally { await db.close(); }
}

export function configuredDatabasePublisher(environment: NodeJS.ProcessEnv = process.env): DatabasePublisher {
  return databasePublisher(operation => withPublisherDatabase(operation, environment));
}

export function assertDatabaseActivated(intent: DatabaseIntent, current: DatabasePointer): void {
  const expected = BigInt(intent.observed.generation) + (intent.observed.release === intent.release ? 0n : 1n);
  if (current.release !== intent.release || BigInt(current.generation) !== expected)
    throw new Error("Database publication changed before final verification");
}

export function assertDatabaseReconciled(intent: DatabaseIntent, current: DatabasePointer): void {
  if (current.release === intent.observed.release && current.generation === intent.observed.generation) return;
  // A lost response may have committed this exact target. Do not accept A -> B -> A.
  assertDatabaseActivated(intent, current);
}
