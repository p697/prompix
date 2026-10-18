import type { TransactionalDatabase } from "../services/feed/database.ts";
import { withPublisherDatabase } from "./database-publication.ts";

// Serialize short database operations per worker process, not the external model work.
// Separate processes still obey the database's role limit and bounded connect backoff.
export function queueDatabase(using: typeof withPublisherDatabase = withPublisherDatabase): TransactionalDatabase {
  let tail: Promise<unknown> = Promise.resolve();
  const run = <T>(operation: (db: TransactionalDatabase) => Promise<T>): Promise<T> => {
    const result = tail.then(() => using(operation));
    tail = result.catch(() => {});
    return result;
  };
  return { query: (sql, parameters) => run(db => db.query(sql, parameters)), transaction: op => run(db => db.transaction(op)) };
}
