import { mkdir, realpath } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import { contentRoot, repo, lockContent } from "./publication.ts";
import { prepareClawHub } from "./clawhub-daily.ts";

// A bounded public intake command also refreshes status before manual rollback/review.
await mkdir(contentRoot, { recursive: true });
const location = relative(await realpath(repo), await realpath(contentRoot));
if (!location || (!location.startsWith("..") && !isAbsolute(location))) throw new Error("Community content must stay outside the repository");
const unlock = await lockContent(contentRoot);
try {
  const result = await prepareClawHub(contentRoot);
  console.log(JSON.stringify({ ...result.report, published: false }));
} finally { await unlock(); }
