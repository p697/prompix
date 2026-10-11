import { contentRoot } from "./publication.ts";
import { recoverRelease } from "./recovery.ts";
const [version, ...flags] = process.argv.slice(2);
if (!version || flags.some(x => x !== "--publish")) throw new Error("Usage: npm run rollback -- <edition-or-rollback-version> [--publish]");
recoverRelease(contentRoot, version, flags.includes("--publish")).catch(error => {
  console.error(String(error)); process.exitCode = 1;
});
