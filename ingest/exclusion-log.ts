import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

/** Every item the pipeline decides not to publish leaves one auditable line: no item waits
 * for a person. A later collection or recheck may send it through the pipeline again,
 * except a model refusal, which is final for that content. */
export const exclusionSchema = z.object({
  at: z.iso.datetime(), id: z.string().min(1).max(200),
  stage: z.enum(["media", "translate", "translationCheck", "source", "review", "publish"]),
  reason: z.string().min(1).max(1000), refused: z.boolean().optional(),
  provider: z.string().max(40).optional(), model: z.string().max(80).optional(),
}).strict();
export type Exclusion = z.infer<typeof exclusionSchema>;

export async function recordExclusion(path: string, entry: Omit<Exclusion, "at">) {
  const line = exclusionSchema.parse({ at: new Date().toISOString(), ...entry, reason: entry.reason.slice(0, 1000) });
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(line) + "\n", { mode: 0o600 });
}

export async function readExclusions(path: string): Promise<Exclusion[]> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
  return text.split("\n").filter(Boolean).map(line => exclusionSchema.parse(JSON.parse(line)));
}

/** Content a model declined is never sent again. */
export async function refusedIDs(path: string): Promise<Set<string>> {
  return new Set((await readExclusions(path)).filter(entry => entry.refused).map(entry => entry.id));
}
