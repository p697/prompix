import { join } from "node:path";
import { atomic, json, contentRoot as root, lockContent, moderationSchema } from "./publication.ts";
const [id, ...reason] = process.argv.slice(2);
if (!id || !/^[a-z0-9-]+$/.test(id) || !reason.length)
  throw new Error("Usage: npm run remove -- <id> <reason>");
const unlock = await lockContent(root);
try {
  const path = join(root, "moderation.json");
  const data = moderationSchema.parse(await json(path, { removedIDs: [] }));
  if (!data.removedIDs.includes(id)) data.removedIDs.push(id);
  data.history ??= [];
  data.history.push({ id, reason: reason.join(" "), at: new Date().toISOString() });
  await atomic(path, data);
  console.log("Removal staged. Publish daily, or roll back the active edition when publication is held, to activate it.");
} finally { await unlock(); }
