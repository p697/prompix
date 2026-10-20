import type { TransactionalDatabase } from "../services/feed/database.ts";
import { hasConfirmedRollback } from "../services/feed/postgres.ts";
import { retrySafeDatabase } from "./transient-retry.ts";
import { withPublisherDatabase } from "./database-publication.ts";

// Serialize short database operations per worker process, not the external model work.
// Separate processes still obey the database's role limit and bounded connect backoff.
export function queueDatabase(using: typeof withPublisherDatabase = withPublisherDatabase, sleep?: (ms: number) => Promise<void>): TransactionalDatabase {
  let tail: Promise<unknown> = Promise.resolve();
  const run = <T>(operation: (db: TransactionalDatabase) => Promise<T>): Promise<T> => {
    const result = tail.then(() => retrySafeDatabase(() => using(operation), hasConfirmedRollback, sleep));
    tail = result.catch(() => {});
    return result;
  };
  return { query: (sql, parameters) => run(db => db.transaction(tx => tx.query(sql, parameters))), transaction: op => run(db => db.transaction(op)) };
}
