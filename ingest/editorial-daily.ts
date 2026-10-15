import { join } from "node:path";
import type { Prompt } from "../packages/schema/catalog.ts";
import type { Candidate } from "./sources.ts";
import type { Reviews } from "./editorial.ts";
import { atomic, json } from "./publication.ts";
import { editorialCacheSchema, editorialLedgerSchema, editorialVersion, runEditorialReview } from "./editorial-runner.ts";
import { codexEditorialProvider } from "./editorial-provider.ts";
import { reviewRequestLimit } from "./review-budget.ts";
import { windowBudget } from "./discovery-budget.ts";

/** Daily already owns the content lock; no independent scheduler or agent loop. */
export async function prepareDailyEditorial(candidates: Candidate[], reviews: Reviews, previous: Prompt[], root: string,
  publishing: boolean, environment: NodeJS.ProcessEnv = process.env, clock: () => Date = () => new Date()) {
  const directory = join(root, "editorial"), day = clock().toISOString().slice(0, 10);
  const cachePath = join(directory, "decisions.json"), ledgerPath = join(directory, "daily-attempts", `${day}.json`);
  const cache = editorialCacheSchema.parse(await json(cachePath, { version: editorialVersion, decisions: {} }));
  const savedLedger = await json<unknown | undefined>(ledgerPath, undefined);
  const ledger = savedLedger === undefined ? undefined : editorialLedgerSchema.parse(savedLedger);
  if (ledger && ledger.day !== day) throw new Error("Editorial ledger date does not match its UTC-day file");
  const configured = environment.PROMPIX_EDITORIAL_PROVIDER;
  if (configured && configured !== "codex") throw new Error("Unsupported editorial provider; publication stopped");
  let requestSequence = ledger?.requests ?? 0;
  return runEditorialReview({ candidates, previous, reviews, cache, ledger, day,
    maxRequests: windowBudget(reviewRequestLimit(environment.PROMPIX_EDITORIAL_MAX_REQUESTS), clock()),
    provider: publishing && configured === "codex" ? async items => {
      if (clock().toISOString().slice(0, 10) !== day) throw new Error("UTC editorial review day changed before provider call; reserved attempt remains consumed");
      const sequence = requestSequence;
      return codexEditorialProvider(environment.PROMPIX_CODEX ?? "codex",
        response => atomic(join(directory, "responses", `${day}-${String(sequence).padStart(3, "0")}.json`), response))(items);
    } : undefined,
    persistCache: state => atomic(cachePath, state), persistReviews: state => atomic(join(root, "editorial.json"), state),
    persistLedger: async state => { await atomic(ledgerPath, state); requestSequence = state.requests; },
  });
}
