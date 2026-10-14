import { withPublisherDatabase } from "../ingest/database-publication.ts";
import { databaseReport } from "../services/feed/maintenance.ts";
import { getState } from "../services/feed/queries.ts";

const result = await withPublisherDatabase(db => db.transaction(async tx => {
  await tx.query("set transaction isolation level repeatable read read only");
  return { state: await getState(tx), ...await databaseReport(tx) };
}));
console.log(JSON.stringify(result, null, 2));
