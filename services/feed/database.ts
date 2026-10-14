export interface Database {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters?: unknown[]): Promise<{ rows: T[] }>;
}
export interface TransactionalDatabase extends Database {
  transaction<T>(operation: (transaction: Database) => Promise<T>): Promise<T>;
}

export class FeedError extends Error {
  constructor(public readonly code: "invalid_request" | "unavailable" | "snapshot_expired" | "not_found" | "removed" | "conflict", public readonly status: number) {
    super(code);
  }
}
