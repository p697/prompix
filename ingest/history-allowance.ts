import { readFile, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { historyAllowanceSchema, historyAllowanceIDs } from "../services/feed/history-allowance.ts";
export async function readHistoryAllowance(environment: NodeJS.ProcessEnv = process.env) {
  const path = environment.PROMPIX_HISTORY_PUBLICATION_AUTHORIZATION;
  if (!path) return undefined;
  if (!isAbsolute(path)) throw new Error("History authorization must be an absolute private file");
  const info = await lstat(path);
  if (!info.isFile() || info.size > 1_000_000) throw new Error("Invalid history authorization file");
  const value = historyAllowanceSchema.parse(JSON.parse(await readFile(path, "utf8")));
  historyAllowanceIDs(value); return value;
}
