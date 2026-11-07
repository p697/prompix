import { z } from "zod";
import facetDefinitions from "./facets.json" with { type: "json" };

/** Prompix 2.0 catalog fields. Every field is optional on the public item so older
 * clients and older releases keep validating; `enrichedPromptIssues` states what a
 * fully enriched item must carry. Names are shared with the iOS model. */

export { facetDefinitions };
export const facetGroups = ["useCase", "style", "subject"] as const;
export type FacetGroup = typeof facetGroups[number];
export const facetLimits: Record<FacetGroup, number> = { useCase: 2, style: 3, subject: 3 };
export const facetIDs = Object.fromEntries(facetGroups.map(group => [group, facetDefinitions[group].map(facet => facet.id)])) as Record<FacetGroup, string[]>;

const nonempty = z.string().trim().min(1);
const bilingual = (max: number) => z.object({ zh: nonempty.max(max), en: nonempty.max(max) }).strict();
const unique = <T>(values: T[]) => new Set(values).size === values.length;

export const presentationValues = ["general", "suggestive", "unknown", "explicit"] as const;
export const presentationSchema = z.enum(presentationValues);

export const inputKinds = ["face", "product", "style", "scene", "video", "audio"] as const;
export const inputsSchema = z.object({
  requirement: z.enum(["none", "optional", "required"]),
  count: z.number().int().min(1).max(8).optional(),
  kinds: z.array(z.enum(inputKinds)).max(inputKinds.length).refine(unique, "Duplicate input kind"),
  /** The prompt is meant for the user's own face, so the app asks for one's own photo only. */
  ownLikenessOnly: z.boolean().optional(),
}).strict().superRefine((inputs, context) => {
  if (inputs.requirement === "none" ? inputs.kinds.length > 0 || inputs.count !== undefined : inputs.kinds.length === 0)
    context.addIssue({ code: "custom", path: ["kinds"], message: "Input kinds must be empty exactly when no input is used" });
  if (inputs.ownLikenessOnly !== undefined && !inputs.kinds.includes("face"))
    context.addIssue({ code: "custom", path: ["ownLikenessOnly"], message: "Own-likeness applies only to face inputs" });
});

export const modelFamilies = ["gpt-image", "nano-banana", "midjourney", "seedance", "veo", "kling", "flux", "claude", "gpt", "gemini", "other"] as const;
export const generationModes = ["t2i", "i2i", "t2v", "i2v", "v2v", "text", "web", "skill"] as const;
export type GenerationMode = typeof generationModes[number];
export const generationSchema = z.object({
  modelFamily: z.enum(modelFamilies),
  modelVersion: nonempty.max(40).optional(),
  mode: z.enum(generationModes),
  outputAspect: z.string().regex(/^[1-9]\d{0,2}:[1-9]\d{0,2}$/).optional(),
  durationSeconds: z.number().positive().max(3600).optional(),
  hasAudio: z.boolean().optional(),
}).strict();

export const variableSchema = z.object({
  /** The placeholder exactly as it appears in the prompt, such as "[a feeling]". */
  token: nonempty.max(300),
  name: bilingual(60),
  default: nonempty.max(200).optional(),
  hint: bilingual(200).optional(),
}).strict();
export const variablesSchema = z.array(variableSchema).max(32)
  .refine(values => unique(values.map(value => value.token)), "Duplicate variable token");

const facetList = (group: FacetGroup) =>
  z.array(z.enum(facetIDs[group] as [string, ...string[]])).max(facetLimits[group]).refine(unique, "Duplicate facet");
export const facetsSchema = z.object({ useCase: facetList("useCase"), style: facetList("style"), subject: facetList("subject") }).strict();
export type Facets = z.infer<typeof facetsSchema>;

/** English card metadata. Sits beside the nine-language translations because those
 * carry a full body; this needs only what a card shows. */
export const englishCardSchema = z.object({ title: nonempty.max(250), summary: nonempty.max(4000) }).strict();

export const paletteSchema = z.array(z.object({
  hex: z.string().regex(/^#[0-9A-F]{6}$/), weight: z.number().min(0).max(1),
}).strict()).length(3).superRefine((colors, context) => {
  if (colors.some((color, index) => index > 0 && color.weight > colors[index - 1].weight))
    context.addIssue({ code: "custom", message: "Palette must be ordered by weight" });
  if (colors.reduce((sum, color) => sum + color.weight, 0) > 1.0001)
    context.addIssue({ code: "custom", message: "Palette weights exceed 1" });
});
export type Palette = z.infer<typeof paletteSchema>;

export const shotsSchema = z.array(z.object({
  index: z.number().int().min(1).max(64),
  startSec: z.number().min(0).max(3600).optional(),
  endSec: z.number().positive().max(3600).optional(),
  text: nonempty.max(2000),
}).strict()).min(2).max(64).superRefine((shots, context) => {
  shots.forEach((shot, position) => {
    if (shot.index !== position + 1) context.addIssue({ code: "custom", path: [position, "index"], message: "Shots must be numbered from 1" });
    if (shot.startSec !== undefined && shot.endSec !== undefined && shot.endSec <= shot.startSec)
      context.addIssue({ code: "custom", path: [position, "endSec"], message: "Shot must end after it starts" });
  });
});

export const sourceAuthorRights = "LicenseRef-source-author-rights";
export const rightsSchema = z.object({
  license: z.string().regex(/^(LicenseRef-[A-Za-z0-9.-]+|[A-Za-z0-9.+-]+)$/).max(80),
  basis: z.enum(["license", "attribution-only"]),
  imageExport: z.boolean(),
}).strict().refine(rights => rights.basis === "license" || !rights.imageExport, "Attribution-only content cannot export images");

/** Collected by the worker and kept private: never part of a published item. */
export const sourceMetricsSchema = z.object({
  bookmarks: z.number().int().nonnegative().optional(), views: z.number().int().nonnegative().optional(),
  likes: z.number().int().nonnegative().optional(), reposts: z.number().int().nonnegative().optional(),
  capturedAt: z.iso.datetime(),
}).strict();

/** Merged into the public item schema; all optional. `inputs` is no longer produced or served;
 * it stays readable so catalogs written before 2026-11-07 still validate. */
export const enrichmentShape = {
  inputs: inputsSchema.optional(),
  generation: generationSchema.optional(),
  variables: variablesSchema.optional(),
  facets: facetsSchema.optional(),
  palette: paletteSchema.optional(),
  shots: shotsSchema.optional(),
  rights: rightsSchema.optional(),
};

type EnrichableItem = {
  kind: "text" | "image" | "video" | "web"; contentType?: "prompt" | "skill"; prompt: string;
  presentation?: string; localization?: { en?: unknown }; media?: unknown;
  generation?: z.infer<typeof generationSchema>;
  variables?: z.infer<typeof variablesSchema>; facets?: Facets; palette?: Palette; rights?: unknown;
};

/** Modes each kind may declare. */
export function allowedModes(item: Pick<EnrichableItem, "kind" | "contentType">): readonly GenerationMode[] {
  if (item.contentType === "skill") return ["skill"];
  return ({ text: ["text"], web: ["web"], image: ["t2i", "i2i"], video: ["t2v", "i2v", "v2v"] } as const)[item.kind];
}

/** Cross-field rules that hold whenever the fields are present. */
export function enrichmentConsistencyIssues(item: EnrichableItem): string[] {
  const issues: string[] = [];
  for (const variable of item.variables ?? [])
    if (!item.prompt.includes(variable.token)) issues.push(`Variable token is not in the prompt: ${variable.token}`);
  if (item.generation && !allowedModes(item).includes(item.generation.mode)) issues.push(`Mode ${item.generation.mode} does not fit ${item.contentType === "skill" ? "skill" : item.kind}`);
  return issues;
}

/** What a fully enriched 2.0 item must carry, beyond the shared consistency rules. */
export function enrichedPromptIssues(item: EnrichableItem): string[] {
  const issues = enrichmentConsistencyIssues(item);
  const visual = item.kind !== "text";
  if (visual && !item.presentation) issues.push("Visual items need a presentation label");
  if (!item.localization?.en) issues.push("English card metadata is required");
  if ((item.media as { imageURL?: string } | null | undefined)?.imageURL && !item.palette) issues.push("Items with a preview need a palette");
  for (const field of ["generation", "facets", "rights"] as const) if (!item[field]) issues.push(`Missing ${field}`);
  return issues;
}
