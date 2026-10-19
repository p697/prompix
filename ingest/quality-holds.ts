import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { promptSchema, type Catalog, type Prompt } from "../packages/schema/catalog.ts";
import { atomic } from "./publication.ts";

export const qualityHoldsByteLimit = 1_000_000;
const id = z.string().regex(/^[a-z0-9-]{1,200}$(?![\s\S])/);
const sha = z.string().length(64).regex(/^[a-f0-9]+$/);
export const qualityHoldRecordSchema = z.object({
  sourceIdentitySHA256: sha,
  reason: z.string().trim().min(1).max(1000),
  evidenceSHA256: sha,
  reviewerID: z.string().regex(/^[a-z0-9-]{1,80}$(?![\s\S])/),
  reviewedAt: z.iso.datetime(),
}).strict();
export const qualityHoldsSchema = z.object({ schemaVersion: z.literal(1), holds: z.record(id, qualityHoldRecordSchema) }).strict()
  .refine(value => Object.keys(value.holds).length <= 1000, "Too many quality holds");
export type QualityHolds = z.infer<typeof qualityHoldsSchema>;
export type QualityHoldRecord = z.infer<typeof qualityHoldRecordSchema>;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Bind the inspected original, attribution and complete media selection, not translations. */
export function qualityHoldIdentity(item: Prompt): string {
  const source = item.source, media = item.media;
  return digest({ id: item.id, kind: item.kind, contentType: item.contentType ?? "prompt", prompt: item.prompt, model: item.model,
    source: { name: source.name, url: source.url, author: source.author ?? null, repository: source.repository ?? null,
      revision: source.revision ?? null, license: source.license, method: source.method },
    media: { image: media?.image ?? null, imageURL: media?.imageURL ?? null, imageURLs: media?.imageURLs ?? [],
      video: media?.video ?? null, videoURL: media?.videoURL ?? null, demoURL: media?.demoURL ?? null },
  });
}

/** Operator metadata only. Missing is empty; corrupt, oversized and unsafe files fail closed. */
export async function readQualityReviewFile(path: string, maximumBytes = qualityHoldsByteLimit): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes) throw new Error("Invalid quality hold review file");
    const bytes = Buffer.alloc(metadata.size + 1); let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== metadata.size) throw new Error("Quality hold review file changed while reading");
    return JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } finally { await file.close(); }
}
async function readLocalQualityHolds(root: string): Promise<QualityHolds> {
  try { return qualityHoldsSchema.parse(await readQualityReviewFile(join(root, "quality-holds.json"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, holds: {} };
    throw error;
  }
}

const holdScopesSchema = z.object({ schemaVersion: z.literal(1), roots: z.array(z.string().refine(isAbsolute)).max(16) }).strict();
async function readHoldScopes(root: string) {
  try { return holdScopesSchema.parse(await readQualityReviewFile(join(root, "quality-hold-scopes.json"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1 as const, roots: [] as string[] };
    throw error;
  }
}
/** Publication and recovery keep observing owner holds even while a campaign runs independently.
 * Registered files are required: losing a mounted campaign must fail closed, not clear its holds.
 * Scopes are deliberately flat; they cannot recursively include each other. */
export async function readQualityHolds(root: string): Promise<QualityHolds> {
  const local = await readLocalQualityHolds(root);
  for (const scope of (await readHoldScopes(root)).roots) {
    const linked = qualityHoldsSchema.parse(await readQualityReviewFile(join(scope, "quality-holds.json")));
    Object.assign(local.holds, linked.holds);
  }
  return qualityHoldsSchema.parse(local);
}
/** Caller owns the public daily.lock. Persist before staging any campaign content. */
export async function registerQualityHoldScope(root: string, campaign: string) {
  const canonical = await realpath(campaign);
  qualityHoldsSchema.parse(await readQualityReviewFile(join(canonical, "quality-holds.json")));
  const scopes = await readHoldScopes(root);
  if (!scopes.roots.includes(canonical)) await atomic(join(root, "quality-hold-scopes.json"),
    holdScopesSchema.parse({ ...scopes, roots: [...scopes.roots, canonical] }));
}

/** A changed source does not silently release a hold. Only an explicit reviewed clearance can do so. */
export function applyQualityHolds(prompts: readonly Prompt[], holds: QualityHolds): { prompts: Prompt[]; withheldIDs: string[] } {
  const validated = qualityHoldsSchema.parse(holds);
  return { prompts: prompts.filter(item => !Object.hasOwn(validated.holds, item.id)),
    withheldIDs: prompts.filter(item => Object.hasOwn(validated.holds, item.id)).map(item => item.id) };
}
export function assertNoQualityHolds(catalog: Pick<Catalog, "prompts">, holds: QualityHolds): void {
  const { withheldIDs } = applyQualityHolds(catalog.prompts, holds);
  if (withheldIDs.length) throw new Error(`Publication blocked by quality hold: ${withheldIDs.join(", ")}. Prepare a new edition without these IDs; the immutable target and removal tombstones were not changed.`);
}

/** Caller owns daily.lock. This never writes moderation, candidates, reviews or release artifacts. */
export async function saveQualityHold(root: string, inspected: Prompt, input: QualityHoldRecord): Promise<void> {
  promptSchema.parse(inspected);
  const itemID = id.parse(inspected.id);
  const record = qualityHoldRecordSchema.parse(input);
  if (qualityHoldIdentity(inspected) !== record.sourceIdentitySHA256)
    throw new Error("Quality hold review does not match the inspected original, source and media");
  if (Date.parse(record.reviewedAt) > Date.now()) throw new Error("Quality hold review is dated in the future");
  const current = await readLocalQualityHolds(root);
  const next = qualityHoldsSchema.parse({ ...current, holds: { ...current.holds, [itemID]: record } });
  if (Buffer.byteLength(JSON.stringify(next, null, 2) + "\n") > qualityHoldsByteLimit)
    throw new Error("Quality holds exceed the storage limit");
  await atomic(join(root, "quality-holds.json"), next);
}
