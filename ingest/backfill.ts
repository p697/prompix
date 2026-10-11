import { join } from "node:path";
import { atomic, contentRoot, lockContent } from "./publication.ts";
import { collectVideoArchive, videoArchive } from "./sources.ts";

if (process.argv.slice(2).length)
  throw new Error("Usage: npm run backfill:video (staging only; no arguments)");

const unlock = await lockContent(contentRoot);
try {
  const candidates = await collectVideoArchive();
  if (!candidates.length) throw new Error("Empty archive; previous snapshot preserved");
  await atomic(join(contentRoot, "candidates", `${videoArchive.id}.json`), candidates);
  console.log(JSON.stringify({
    source: videoArchive.id,
    revision: videoArchive.revision,
    count: candidates.length,
    reviewStatus: "draft",
    published: false,
  }));
} finally { await unlock(); }
