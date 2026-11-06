import { join } from "node:path";
import { homedir } from "node:os";
import { atomic, contentRoot, json, lockContent, moderationSchema } from "./publication.ts";
import { prepareXMaintenanceAdmission } from "./x-maintenance-admission.ts";
import { prepareXAvailability } from "./x-availability.ts";
import { prepareClawHub } from "./clawhub-daily.ts";
import { withPublisherDatabase } from "./database-publication.ts";
import { loadEnvFile } from "./models/registry.ts";
import { removeContent } from "../services/feed/publication.ts";
import type { TransactionalDatabase } from "../services/feed/database.ts";

/** The same credential files the legacy scheduler passed to `ingest/daily.ts`. */
export const pipelineEnvFiles = ["x", "twitterapi", "rapidapi", "translation", "editorial", "publication", "database", "alerts", "models"]
  .map(name => join(homedir(), ".config/prompix", `${name}.env`));

/** Process environment wins over the files, as with `node --env-file-if-exists`. */
export async function pipelineEnvironment(env: NodeJS.ProcessEnv = process.env, files = pipelineEnvFiles): Promise<NodeJS.ProcessEnv> {
  const merged: NodeJS.ProcessEnv = {};
  for (const file of files) Object.assign(merged, (await loadEnvFile(file)).values);
  return { ...merged, ...env };
}

/** More confirmed deletions than this in one run is far likelier a provider fault than
 * real removals, so nothing is taken down and the run fails loudly instead. */
export const takedownLimit = 50;

export type MaintenanceReport = { x: unknown; clawhub: unknown; removed: number; takenDown: string[] };
type Dependencies = {
  lock: typeof lockContent; admission: typeof prepareXMaintenanceAdmission; availability: typeof prepareXAvailability;
  clawhub: typeof prepareClawHub; database: <T>(work: (db: TransactionalDatabase) => Promise<T>) => Promise<T>;
};

/** Source maintenance is a safety duty and runs whatever the intake state is: it refreshes
 * the X and ClawHub verifications that every publication requires, and takes down live
 * items whose source post is confirmed gone with a tombstone rather than waiting for the
 * next release. Holds the shared content lock, so it never overlaps a legacy run. */
export async function runMaintenance(env: NodeJS.ProcessEnv, root = contentRoot, overrides: Partial<Dependencies> = {}): Promise<MaintenanceReport> {
  const io: Dependencies = { lock: lockContent, admission: prepareXMaintenanceAdmission, availability: prepareXAvailability,
    clawhub: prepareClawHub, database: work => withPublisherDatabase(work, env), ...overrides };
  const unlock = await io.lock(root);
  try {
    // Without the published IDs the recheck counts as growth and the maintenance reserve refuses it.
    const admission = env.X_BEARER_TOKEN || env.PROMPIX_X_DISCOVERY_PROVIDER === "third-party" ? await io.admission(root, env) : undefined;
    const x = await io.availability(root, { enabled: true, bearer: env.X_BEARER_TOKEN, admission, environment: env });
    const removed = Object.entries(x.state).filter(([, state]) => state.removed).map(([id]) => id).sort();
    let takenDown: string[] = [];
    if (removed.length) {
      const path = join(root, "moderation.json");
      const current = moderationSchema.parse(await json(path, { removedIDs: [] }));
      await atomic(path, { ...current, removedIDs: [...new Set([...current.removedIDs, ...removed])].sort() });
      takenDown = await io.database(async db => {
        const live = (await db.query<{ id: string }>("select id from prompix.content where id = any($1::text[]) and removed_at is null order by id", [removed])).rows.map(row => row.id);
        if (live.length > takedownLimit) throw new Error(`Refusing to take down ${live.length} items at once; check the X provider before removing them`);
        if (live.length) await removeContent(db, live, "X source post is no longer available");
        return live;
      });
    }
    const clawhub = await io.clawhub(root);
    return { x: x.report, clawhub: clawhub.report, removed: removed.length, takenDown };
  } finally { await unlock(); }
}
