import assert from "node:assert/strict";
import { test } from "node:test";
import { publisherConfiguration } from "./postgres.ts";

test("publisher TLS cannot be weakened through connection URL parameters", () => {
  const ca = "-----BEGIN CERTIFICATE-----\ntest fixture\n-----END CERTIFICATE-----";
  const url = "postgresql://writer:p%40ss@db.example.com:5432/postgres";
  const config = publisherConfiguration({ PROMPIX_DATABASE_URL: url }, ca);
  assert.deepEqual(config.ssl, { ca, rejectUnauthorized: true });
  assert.equal(config.password, "p@ss");
  for (const value of [url + "?sslmode=disable", url + "?sslmode=no-verify", url + "#fragment",
    "http://writer:password@db.example.com/postgres", "postgresql://writer@db.example.com/postgres",
    "postgresql://writer:password@db.example.com/other"])
    assert.throws(() => publisherConfiguration({ PROMPIX_DATABASE_URL: value }, ca));
  assert.throws(() => publisherConfiguration({ PROMPIX_DATABASE_URL: url }, ""));
});

import { confirmedTransaction, hasConfirmedRollback } from "./postgres.ts";
import type { Database } from "./database.ts";

test("rollback proof excludes lost COMMIT and failed ROLLBACK acknowledgements", async () => {
  for (const failure of ["query", "commit", "rollback", "begin"]) {
    const error = new Error("Query read timeout"), statements: string[] = [];
    const db: Database = { query: async sql => {
      statements.push(sql);
      if (sql === failure || (failure === "rollback" && sql === "query")) throw error;
      return { rows: [] };
    } };
    await assert.rejects(confirmedTransaction(db, tx => tx.query("query")), e => e === error);
    assert.equal(hasConfirmedRollback(error), failure === "query" || failure === "begin");
    assert.equal(statements.at(-1), "rollback");
  }
});
