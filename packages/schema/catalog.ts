import { z } from "zod";
const https = z
  .url()
  .refine((value) => new URL(value).protocol === "https:", "HTTPS required");
const nonempty = z.string().trim().min(1);
const resource = z.string().regex(/^[a-z0-9-]+$/);
export const promptSchema = z.object({
  id: resource,
  kind: z.enum(["text", "image", "video", "web"]),
  title: nonempty.max(250),
  summary: nonempty.max(4000),
  prompt: nonempty.max(50000),
  example: nonempty,
  tags: z.array(nonempty).min(1),
  model: nonempty,
  toolURL: https.nullable(),
  artwork: resource,
  previewLabel: nonempty,
  cover: z.object({
    text: nonempty.max(100),
    eyebrow: nonempty.max(40),
    tone: z.enum(["sage", "clay", "ink", "sky", "cream"]),
  }).optional(),
  source: z.object({
    name: nonempty,
    url: https.nullable(),
    license: nonempty,
    method: nonempty,
    author: nonempty.optional(),
    repository: https.optional(),
    revision: nonempty.optional(),
  }),
  media: z
    .object({
      image: resource.nullable(),
      video: resource.nullable(),
      demoURL: https.nullable(),
      imageURL: https.optional(),
      imageURLs: z.array(https).min(1).max(8).optional(),
      aspectRatio: z.number().min(0.1).max(10).optional(),
      videoURL: https.optional(),
    })
    .nullable(),
  publishedAt: z.string().optional(),
});
export const catalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: resource,
    publishedAt: z.string().optional(),
    removedIDs: z.array(resource).optional(),
    prompts: z.array(promptSchema).min(1).max(1000),
  })
  .superRefine((catalog, context) => {
    const seen = new Set<string>();
    catalog.prompts.forEach((item, index) => {
      if (seen.has(item.id) || catalog.removedIDs?.includes(item.id))
        context.addIssue({
          code: "custom",
          message: "Duplicate or removed prompt ID",
          path: ["prompts", index, "id"],
        });
      seen.add(item.id);
    });
  });
export type Catalog = z.infer<typeof catalogSchema>;
export type Prompt = z.infer<typeof promptSchema>;
