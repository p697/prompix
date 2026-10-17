import { join } from "node:path";
import { z } from "zod";
import type { Database } from "../services/feed/database.ts";
import { withPublisherDatabase } from "./database-publication.ts";
import { windowBudget } from "./discovery-budget.ts";
import { editorialLedgerSchema } from "./editorial-runner.ts";
import { json } from "./publication.ts";
import { reviewRequestLimit } from "./review-budget.ts";

export interface XMaintenanceAdmission {
  publishedIDs: ReadonlySet<string>;
  attemptedIDs: ReadonlySet<string>;
  maxDrafts: number;
}

/** Historical publication identities survive removal, lost approvals and release rollback. */
export async function publishedXIdentities(db: Database): Promise<Set<string>> {
  const state = (await db.query("select active_release from prompix.state where singleton")).rows[0];
  if (!state?.active_release) throw new Error("X maintenance admission requires an initialized publication database");
  const rows = (await db.query(`select id from prompix.content
    where first_published_at is not null and id like 'x-post-%' order by id limit 100001`)).rows;
  const ids = z.array(z.object({ id: z.string().regex(/^x-post-\d{1,19}$/) }).strict()).max(100000).parse(rows).map(row => row.id);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate published X identity");
  return new Set(ids);
}

/** No remote X call: bound draft maintenance to available editorial capacity, never live inventory. */
export async function prepareXMaintenanceAdmission(root: string, environment: NodeJS.ProcessEnv = process.env,
  now = new Date(), readPublished = () => withPublisherDatabase(publishedXIdentities, environment)): Promise<XMaintenanceAdmission | undefined> {
  // Legacy publishers keep the existing conservative route until authoritative history is available.
  if (environment.PROMPIX_DATABASE_ENABLED !== "true") return;
  const day = now.toISOString().slice(0, 10);
  const raw = await json<unknown>(join(root, "editorial", "daily-attempts", `${day}.json`), undefined);
  const ledger = raw === undefined ? undefined : editorialLedgerSchema.parse(raw);
  if (ledger && ledger.day !== day) throw new Error("Editorial admission ledger day mismatch");
  const provider = environment.PROMPIX_EDITORIAL_PROVIDER;
  if (provider && provider !== "codex") throw new Error("Unsupported editorial provider");
  const limit = windowBudget(reviewRequestLimit(environment.PROMPIX_EDITORIAL_MAX_REQUESTS), now);
  const blocked = ledger?.attempts.some(attempt => attempt.state !== "completed") ?? false;
  return { publishedIDs: await readPublished(), attemptedIDs: new Set(ledger?.attempts.flatMap(attempt => attempt.candidateIDs) ?? []),
    maxDrafts: provider === "codex" && !blocked ? Math.max(0, limit - (ledger?.requests ?? 0)) * 3 : 0 };
}
