import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const [id, ...reason] = process.argv.slice(2);
if (!id || !/^[a-z0-9-]+$/.test(id) || !reason.length)
  throw new Error("Usage: npm run remove -- <id> <reason>");
const root = join(homedir(), ".local/share/prompix/content");
await mkdir(root, { recursive: true });
const path = join(root, "moderation.json");
let data: { removedIDs: string[]; history?: unknown[] } = { removedIDs: [] };
try {
  data = JSON.parse(await readFile(path, "utf8"));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
if (!data.removedIDs.includes(id)) data.removedIDs.push(id);
data.history ??= [];
data.history.push({
  id,
  reason: reason.join(" "),
  at: new Date().toISOString(),
});
await writeFile(path + ".tmp", JSON.stringify(data, null, 2) + "\n");
await rename(path + ".tmp", path);
console.log("Removal staged. Run npm run daily -- --publish to activate it.");
