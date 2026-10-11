import { z } from 'zod';
const https = z.url().refine(value => new URL(value).protocol === 'https:', 'HTTPS required');
const nonempty = z.string().trim().min(1);
const resource = z.string().regex(/^[a-z0-9-]+$/);
export const promptSchema = z.object({
  id: resource, kind: z.enum(['text', 'image', 'video', 'web']),
  title: nonempty, summary: nonempty, prompt: nonempty, example: nonempty,
  tags: z.array(nonempty).min(1), model: nonempty, toolURL: https.nullable(),
  artwork: resource, previewLabel: nonempty,
  source: z.object({name: nonempty, url: https.nullable(), license: nonempty, method: nonempty}),
  media: z.object({image: resource.nullable(), video: resource.nullable(), demoURL: https.nullable()}).nullable()
});
export const catalogSchema = z.object({
  schemaVersion: z.literal(1), version: resource,
  prompts: z.array(promptSchema).min(1)
}).superRefine((catalog, context) => {
  const seen = new Set<string>();
  catalog.prompts.forEach((item, index) => {
    if (seen.has(item.id)) context.addIssue({code:'custom', message:'Duplicate prompt ID', path:['prompts',index,'id']});
    seen.add(item.id);
  });
});
export type Catalog = z.infer<typeof catalogSchema>;
