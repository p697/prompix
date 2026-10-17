import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Prompt } from "../packages/schema/catalog.ts";
import { atomic, json } from "./publication.ts";
import { runVisualReview, visualCacheSchema, visualLedgerSchema, visualReviewVersion } from "./visual-review.ts";
import { codexVisualProvider } from "./visual-provider.ts";
import { prepareVisualMedia } from "./visual-media.ts";
import { reviewRequestLimit } from "./review-budget.ts";
import { websiteReviewer } from "./website-review.ts";

/** Runs under the daily content lock, after immutable media preparation. */
export async function prepareDailyVisualReview(prompts: Prompt[], previous: Prompt[], root: string,
  publishing: boolean, environment: NodeJS.ProcessEnv = process.env, clock: () => Date = () => new Date()) {
  const directory = join(root, "visual-review"), day = clock().toISOString().slice(0, 10);
  const cachePath = join(directory, "decisions.json"), ledgerPath = join(directory, "daily-attempts", `${day}.json`);
  const cache = visualCacheSchema.parse(await json(cachePath, { version: visualReviewVersion, decisions: {} }));
  const saved = await json<unknown | undefined>(ledgerPath, undefined);
  const ledger = saved === undefined ? undefined : visualLedgerSchema.parse(saved);
  if (ledger && ledger.day !== day) throw new Error("Visual review ledger does not match its UTC day file");
  const configured = environment.PROMPIX_VISUAL_PROVIDER;
  if (configured && configured !== "codex") throw new Error("Unsupported visual provider; publication stopped");
  const maxRequests = reviewRequestLimit(environment.PROMPIX_VISUAL_MAX_REQUESTS);
  const classify = environment.PROMPIX_VISUAL_CLASSIFY_PUBLISHED;
  if (classify !== undefined && classify !== "0" && classify !== "1") throw new Error("Invalid published presentation review switch");
  // Dry-run remains offline for review media. Trusted website reviews never use
  // a model or spend the image-review request budget.
  const reviewWebsite = publishing && prompts.some(item => item.kind === "web") ? await websiteReviewer(root) : undefined;
  let requestSequence = ledger?.requests ?? 0;
  let temporary: string | undefined;
  try {
    return await runVisualReview({ prompts, previous, cache, ledger, day, maxRequests, reviewWebsite, classifyPublished: classify === "1",
      provider: publishing && configured === "codex" ? async items => {
        if (clock().toISOString().slice(0, 10) !== day) throw new Error("UTC visual review day changed; reserved attempt remains consumed");
        const sequence = requestSequence;
        return codexVisualProvider(environment.PROMPIX_CODEX ?? "codex",
          response => atomic(join(directory, "responses", `${day}-${String(sequence).padStart(3, "0")}.json`), response))(items);
      } : undefined,
      prepareMedia: async prompt => {
        temporary ??= await mkdtemp(join(tmpdir(), "prompix-visual-daily-"));
        const files = await mkdtemp(join(temporary, "item-"));
        return prepareVisualMedia(prompt, files);
      },
      persistCache: state => atomic(cachePath, state),
      persistLedger: async state => { await atomic(ledgerPath, state); requestSequence = state.requests; },
    });
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}
