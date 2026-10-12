import { join } from "node:path";
import type { Prompt } from "../packages/schema/catalog.ts";
import type { Candidate } from "./sources.ts";
import type { Reviews } from "./editorial.ts";
import { atomic, json } from "./publication.ts";
import { editorialCacheSchema, editorialLedgerSchema, editorialVersion, runEditorialReview } from "./editorial-runner.ts";
import { codexEditorialProvider } from "./editorial-provider.ts";

/** Daily already owns the content lock; no independent scheduler or agent loop. */
export async function prepareDailyEditorial(candidates: Candidate[], reviews: Reviews, previous: Prompt[], root: string,
  publishing: boolean, environment: NodeJS.ProcessEnv = process.env) {
  const directory = join(root, "editorial"), day = new Date().toISOString().slice(0, 10);
  const cachePath = join(directory, "decisions.json"), ledgerPath = join(directory, "daily-attempts", `${day}.json`);
  const cache = editorialCacheSchema.parse(await json(cachePath, { version: editorialVersion, decisions: {} }));
  const savedLedger = await json<unknown | undefined>(ledgerPath, undefined);
  const ledger = savedLedger === undefined ? undefined : editorialLedgerSchema.parse(savedLedger);
  const configured = environment.PROMPIX_EDITORIAL_PROVIDER;
  if (configured && configured !== "codex") throw new Error("Unsupported editorial provider; publication stopped");
  return runEditorialReview({ candidates, previous, reviews, cache, ledger, day,
    provider: publishing && configured === "codex" ? codexEditorialProvider(environment.PROMPIX_CODEX ?? "codex",
      response => atomic(join(directory, "responses", `${day}.json`), response)) : undefined,
    persistCache: state => atomic(cachePath, state), persistReviews: state => atomic(join(root, "editorial.json"), state),
    persistLedger: state => atomic(ledgerPath, state),
  });
}
