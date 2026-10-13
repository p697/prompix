import { mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { atomic, contentRoot, lockContent, repo } from "./publication.ts";
import { readXExcerptReviews, xExcerptSelectionSchema } from "./x-excerpts.ts";
import { readXIntake } from "./x-intake.ts";

const [postID, file, ...options] = process.argv.slice(2);
if (!/^\d{1,19}$/.test(postID ?? "") || !file || options.some(option => option !== "--save"))
  throw new Error("Usage: npm run review:x-excerpt -- <post-id> /external/selection.json [--save]");
await mkdir(contentRoot, { recursive: true });
const location = relative(await realpath(repo), await realpath(contentRoot));
if (!location || (!location.startsWith("..") && !isAbsolute(location))) throw new Error("Source excerpts must stay outside the repository");
const unlock = await lockContent(contentRoot);
try {
  const selection = xExcerptSelectionSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const reviews = await readXExcerptReviews(contentRoot);
  reviews[postID] = { ...selection, reviewedAt: new Date().toISOString() };
  const intake = await readXIntake(contentRoot, {}, reviews);
  const candidate = intake.candidates.find(item => item.id === `x-post-${postID}`);
  if (!candidate) throw new Error(`Excerpt did not produce a draft: ${intake.records.find(item => item.postID === postID)?.reason ?? "post-not-found"}`);
  if (options.includes("--save")) await atomic(join(contentRoot, "x-excerpt-reviews.json"), reviews);
  console.log(JSON.stringify({ id: candidate.id, saved: options.includes("--save"), characters: candidate.prompt.length,
    fingerprint: candidate.fingerprint, kind: candidate.kind, status: "draft-awaiting-source-and-editorial-review", published: false }));
} finally { await unlock(); }
