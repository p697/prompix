import { z } from "zod";
const https = z
  .url()
  .refine((value) => new URL(value).protocol === "https:", "HTTPS required");
const nonempty = z.string().trim().min(1);
const resource = z.string().regex(/^[a-z0-9-]+$/);
export const localizationLanguages = ["en", "zh-Hans", "zh-Hant", "ja", "ko", "es", "pt-BR", "fr", "de"] as const;
export const translatedContent = z.object({
  title: nonempty.max(250), summary: nonempty.max(4000), prompt: nonempty.max(50000),
  example: nonempty.max(50000), previewLabel: nonempty.max(500),
  cover: z.object({ text: nonempty.max(100), eyebrow: nonempty.max(40) }).optional(),
});
export const creatorSchema = z.object({
  id: nonempty.max(200), platform: z.enum(["x", "github", "web"]),
  displayName: nonempty.max(200), username: nonempty.max(200).optional(),
  profileURL: https, avatarURL: https.optional(), externalID: nonempty.max(200).optional(),
  bio: nonempty.max(2000).optional(),
});
export const sourcePostSchema = z.object({
  id: z.string().regex(/^\d{1,19}$/), authorID: z.string().regex(/^\d{1,19}$/),
  text: z.string().min(1).max(50000), createdAt: z.iso.datetime(), checkedAt: z.iso.datetime(),
  parentID: z.string().regex(/^\d{1,19}$/).optional(),
});
export const promptSchema = z.object({
  id: resource,
  kind: z.enum(["text", "image", "video", "web"]),
  contentType: z.enum(["prompt", "skill"]).optional(),
  creator: creatorSchema.optional(),
  skill: z.object({
    name: nonempty.max(250), description: nonempty.max(4000), format: z.literal("agent-skills"),
    entrypoint: z.literal("SKILL.md"), repository: https, directory: nonempty,
    installURL: https, files: z.array(nonempty).max(200).optional(),
  }).optional(),
  localization: z.object({
    sourceLanguage: nonempty.max(40), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    translations: z.partialRecord(z.enum(localizationLanguages), translatedContent),
  }).optional(),
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
    post: sourcePostSchema.optional(),
    context: z.array(sourcePostSchema).min(1).max(8).optional(),
    mediaPostID: z.string().regex(/^\d{1,19}$/).optional(),
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
    .refine(media => !media.imageURLs || media.imageURL === media.imageURLs[0], "Gallery must start with its cover")
    .nullable(),
  publishedAt: z.string().optional(),
}).superRefine((item, validation) => {
  const { post, context, mediaPostID } = item.source;
  if (context) {
    const chain = [...context, ...(post ? [post] : [])];
    if (!post || item.source.name !== "X" || !mediaPostID || !chain.some(value => value.id === mediaPostID) ||
        new Set(chain.map(value => value.id)).size !== chain.length || chain.some((value, index) =>
          value.authorID !== post.authorID || (index === 0 ? value.parentID !== undefined :
            value.parentID !== chain[index - 1].id || Date.parse(value.createdAt) < Date.parse(chain[index - 1].createdAt))))
      contextIssue();
  } else if (post?.parentID || mediaPostID) contextIssue();
  function contextIssue() { validation.addIssue({ code: "custom", path: ["source", "context"], message: "Invalid original-post context chain" }); }
  if ((item.contentType === "skill") !== !!item.skill)
    validation.addIssue({ code: "custom", path: ["skill"], message: "Skill metadata and contentType must agree" });
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
