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
