import { z } from "zod";
import { join, isAbsolute } from "node:path";
import { readFile, stat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { atomic, json, writeImmutableBytes } from "./publication.ts";

export const campaignStageSchema = z.object({ version: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), run: z.string().min(1), authorizedAt: z.iso.datetime(),
  baselineCount: z.number().int().nonnegative(), seedReadyAtStart: z.number().int().nonnegative(),
  newReadyAtStart: z.number().int().nonnegative(), additionalQualified: z.number().int().min(1).max(10000),
  evidencePath: z.string().min(1), evidenceSHA256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type CampaignStage = z.infer<typeof campaignStageSchema>;
export function boundedStageTarget(raw: unknown, run: string, baselineCount: number, startedAt: string, now = Date.now()): number {
  const stage = campaignStageSchema.parse(raw);
  const target = baselineCount + stage.seedReadyAtStart + stage.newReadyAtStart + stage.additionalQualified;
  if (stage.run !== run || stage.baselineCount !== baselineCount || Date.parse(stage.authorizedAt) < Date.parse(startedAt)
    || Date.parse(stage.authorizedAt) > now || target > 10000) throw new Error("Invalid bounded stage baseline, date or target");
  return target;
}
/** Append-only grants. The mutable pointer may select only a byte-verified frozen grant. */
export async function activateCampaignStage(root: string, raw: CampaignStage) {
  const stage = campaignStageSchema.parse(raw);
  await writeImmutableBytes(join(root, "stages", stage.id + ".json"), Buffer.from(JSON.stringify(stage) + "\n"));
  await writeImmutableBytes(join(root, "stage-locks", stage.id + ".json"), Buffer.from(JSON.stringify(stage) + "\n"));
  await atomic(join(root, "active-stage.json"), { version: 1, id: stage.id });
}
export async function readCampaignStage(root: string): Promise<CampaignStage | null> {
  const raw = await json(join(root, "active-stage.json"), null);
  if (raw === null) return null;
  const pointer = z.object({ version: z.literal(1), id: campaignStageSchema.shape.id }).strict().parse(raw);
  const stage = campaignStageSchema.parse(await json(join(root, "stages", pointer.id + ".json"), null));
  if (stage.id !== pointer.id) throw new Error("Stage pointer identity mismatch");
  if (!isAbsolute(stage.evidencePath) || (await stat(stage.evidencePath)).size > 2_000_000) throw new Error("Invalid stage evidence path or size");
  const evidence = await readFile(stage.evidencePath);
  if (createHash("sha256").update(evidence).digest("hex") !== stage.evidenceSHA256) throw new Error("Stage evidence changed");
  if (await readFile(join(root, "stage-locks", stage.id + ".json"), "utf8") !== JSON.stringify(stage) + "\n") throw new Error("Frozen stage changed");
  const directory = join(root, "stage-ceilings", stage.id);
  const names = await readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  let additionalQualified = stage.additionalQualified;
  for (const name of names) {
    const ceiling = stageCeilingSchema.parse(await json(join(directory, name), null));
    if (name !== `${ceiling.additionalQualified}.json` || ceiling.stageID !== stage.id || ceiling.run !== stage.run
      || ceiling.stageSHA256 !== stageDigest(stage) || ceiling.additionalQualified >= stage.additionalQualified
      || Date.parse(ceiling.authorizedAt) < Date.parse(stage.authorizedAt) || Date.parse(ceiling.authorizedAt) > Date.now())
      throw Error("Invalid stage ceiling");
    additionalQualified = Math.min(additionalQualified, ceiling.additionalQualified);
  }
  return { ...stage, additionalQualified };
}
const stageCeilingSchema = z.object({ version: z.literal(1), stageID: campaignStageSchema.shape.id,
  run: z.string().min(1), stageSHA256: z.string().regex(/^[0-9a-f]{64}$/), authorizedAt: z.iso.datetime(),
  additionalQualified: z.number().int().min(1).max(9999) }).strict();
function stageDigest(stage: CampaignStage) {
  return createHash("sha256").update(JSON.stringify(stage) + "\n").digest("hex");
}
/** Caller must hold the campaign lock and drain leases. Reductions retain the original baseline and grant. */
export async function reduceCampaignStage(root: string, id: string, additionalQualified: number) {
  const current = await readCampaignStage(root);
  if (!current || current.id !== id || !Number.isInteger(additionalQualified) || additionalQualified < 1
    || additionalQualified >= current.additionalQualified) throw Error("Stage ceiling must strictly reduce the active increment");
  const original = campaignStageSchema.parse(await json(join(root, "stages", id + ".json"), null));
  const ceiling = stageCeilingSchema.parse({ version: 1, stageID: id, run: current.run,
    stageSHA256: stageDigest(original), authorizedAt: new Date().toISOString(), additionalQualified });
  await writeImmutableBytes(join(root, "stage-ceilings", id, `${additionalQualified}.json`), Buffer.from(JSON.stringify(ceiling) + "\n"));
  return (await readCampaignStage(root))!;
}
