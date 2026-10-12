import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { atomic, contentRoot, lockContent, repo } from "./publication.ts";
import { collectXFeeds } from "./x-feed.ts";
import { readXIntake } from "./x-intake.ts";

await mkdir(contentRoot, { recursive: true });
const location = relative(await realpath(repo), await realpath(contentRoot));
if (!location || (!location.startsWith("..") && !isAbsolute(location))) throw new Error("Community content must stay outside the repository");
const unlock = await lockContent(contentRoot);
try {
  const report = await collectXFeeds(contentRoot, { enabled: process.argv.includes("--fetch"), bearer: process.env.X_BEARER_TOKEN });
  const intake = await readXIntake(contentRoot);
  await atomic(join(contentRoot, "candidates", "x-native.json"), intake.candidates);
  await atomic(join(contentRoot, "x-intake", "status.json"), { updatedAt: new Date().toISOString(), ...intake.report, records: intake.records });
  await atomic(join(contentRoot, "x-feed-status.json"), { updatedAt: new Date().toISOString(), ...report, intake: intake.report });
  console.log(JSON.stringify({ ...report, intake: intake.report, published: false }));
} finally { await unlock(); }
