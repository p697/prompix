import { join } from "node:path";
import { reviewsSchema } from "./editorial.ts";
import { json, writeImmutableBytes } from "./publication.ts";

/** Called under the batch lock, before review. Later stages only read this local evidence. */
export async function snapshotHistoryEditorial(directory: string, sharedRoot: string) {
  const path = join(directory, "editorial.json");
  const local = await json<unknown>(path, null);
  if (local !== null) return reviewsSchema.parse(local);
  const inherited = reviewsSchema.parse(await json(join(sharedRoot, "editorial.json"), {}));
  // A fully cached review makes no provider call and never invokes persistReviews.
  // Freeze its input now so the next queue stage does not depend on mutable shared state.
  await writeImmutableBytes(path, Buffer.from(JSON.stringify(inherited) + "\n"));
  return inherited;
}
