import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Prompt } from "../packages/schema/catalog.ts";
import { atomic, json } from "./publication.ts";
import { runVisualReview, visualCacheSchema, visualLedgerSchema, visualReviewVersion } from "./visual-review.ts";
import { codexVisualProvider } from "./visual-provider.ts";
import { prepareVisualMedia } from "./visual-media.ts";

/** Runs under the daily content lock, after immutable media preparation. */
export async function prepareDailyVisualReview(prompts: Prompt[], previous: Prompt[], root: string,
  publishing: boolean, environment: NodeJS.ProcessEnv = process.env) {
  const directory = join(root, "visual-review"), day = new Date().toISOString().slice(0, 10);
  const cachePath = join(directory, "decisions.json"), ledgerPath = join(directory, "daily-attempts", `${day}.json`);
  const cache = visualCacheSchema.parse(await json(cachePath, { version: visualReviewVersion, decisions: {} }));
  const saved = await json<unknown | undefined>(ledgerPath, undefined);
  const ledger = saved === undefined ? undefined : visualLedgerSchema.parse(saved);
  const configured = environment.PROMPIX_VISUAL_PROVIDER;
  if (configured && configured !== "codex") throw new Error("Unsupported visual provider; publication stopped");
  let temporary: string | undefined;
  try {
    return await runVisualReview({ prompts, previous, cache, ledger, day,
      provider: publishing && configured === "codex" ? codexVisualProvider(environment.PROMPIX_CODEX ?? "codex",
        response => atomic(join(directory, "responses", `${day}.json`), response)) : undefined,
      prepareMedia: async prompt => {
        temporary ??= await mkdtemp(join(tmpdir(), "prompix-visual-daily-"));
        const files = await mkdtemp(join(temporary, "item-"));
        return prepareVisualMedia(prompt, files);
      },
      persistCache: state => atomic(cachePath, state),
      persistLedger: state => atomic(ledgerPath, state),
    });
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}
