import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import type { Database, TransactionalDatabase } from "./database.ts";

export async function createTestDatabase() {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const migrations = new URL("../../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort())
    await pg.exec(await readFile(new URL(file, migrations), "utf8"));
  const role = (name: "prompix_reader" | "prompix_writer"): TransactionalDatabase => ({
    query: async <T extends Record<string, unknown>>(sql: string, parameters?: unknown[]) => pg.transaction(async tx => {
      await tx.exec(`set local role ${name}`);
      return tx.query<T>(sql, parameters);
    }),
    transaction: async operation => pg.transaction(async tx => {
      await tx.exec(`set local role ${name}`);
      const adapter: Database = { query: (sql, parameters) => tx.query(sql, parameters) };
      return operation(adapter);
    }),
  });
  return { pg, writer: role("prompix_writer"), reader: role("prompix_reader") };
}
