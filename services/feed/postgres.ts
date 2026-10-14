import { Client, type ClientConfig } from "pg";
import type { Database, TransactionalDatabase } from "./database.ts";

/** One connection per operation/request; never share a Worker client globally. */
export async function connectDatabase(config: ClientConfig): Promise<TransactionalDatabase & { close(): Promise<void> }> {
  const client = new Client({ connectionTimeoutMillis: 5000, query_timeout: 10000,
    statement_timeout: 8000, lock_timeout: 3000, idle_in_transaction_session_timeout: 15000,
    application_name: "prompix-content", ...config });
  // Idle socket errors must not escape as unhandled EventEmitter errors.
  client.on("error", () => {});
  try { await client.connect(); }
  catch (error) { await client.end().catch(() => {}); throw error; }
  const adapter: Database = { query: (sql, parameters) => client.query(sql, parameters) };
  let inTransaction = false;
  return {
    ...adapter,
    close: () => client.end(),
    async transaction(operation) {
      if (inTransaction) throw new Error("Concurrent or nested transactions are not supported");
      inTransaction = true;
      try {
        await client.query("begin");
        const result = await operation(adapter);
        await client.query("commit");
        return result;
      } catch (error) {
        // Preserve the original failure if the connection also failed during rollback.
        await client.query("rollback").catch(() => {});
        throw error;
      } finally { inTransaction = false; }
    },
  };
}

/** Direct publisher connections verify both CA chain and hostname. */
export function publisherConfiguration(environment: NodeJS.ProcessEnv, ca: string): ClientConfig {
  const { PROMPIX_DATABASE_URL: value } = environment;
  if (!value || !ca.includes("-----BEGIN CERTIFICATE-----")) throw new Error("Database configuration is incomplete");
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username || !url.password ||
      url.search || url.hash || url.pathname !== "/postgres") throw new Error("Invalid database connection configuration");
  // Separate fields prevent URL sslmode parameters from overriding verification.
  return { host: url.hostname, port: Number(url.port || 5432), database: "postgres",
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    ssl: { ca, rejectUnauthorized: true }, application_name: "prompix-publisher" };
}
