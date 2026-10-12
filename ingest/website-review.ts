import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Prompt } from "../packages/schema/catalog.ts";
import { readResponseBytes } from "./network.ts";
import { fingerprint } from "./sources.ts";
import { websiteArtifactOrigin, websiteArtifactByteLimit, websiteContentSecurityPolicy } from "../packages/schema/website-artifact.ts";
export { websiteArtifactByteLimit, websiteContentSecurityPolicy } from "../packages/schema/website-artifact.ts";

const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const sha = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(1000);
const evidenceByteLimit = 8_000_000;
const trustSchema = z.object({ version: z.literal(1), demoOrigin: z.literal(websiteArtifactOrigin),
  reviewers: z.array(z.string().regex(/^[a-z0-9-]{1,80}$/)).min(1).max(20),
}).strict();
export type WebsiteReviewTrust = z.infer<typeof trustSchema>;
const screenshotSchema = z.object({ sha256: sha, byteLength: z.number().int().positive().max(evidenceByteLimit), format: z.enum(["png", "jpg"]) }).strict();
const viewportSchema = z.object({ width: z.number().int().min(320).max(2560), height: z.number().int().min(480).max(2560),
  screenshot: screenshotSchema,
  // A screenshot cannot establish that an interaction happened. The trusted reviewer
  // separately records the action, expected result and actual observation.
  interactions: z.array(z.object({ action: text, expected: text, observed: text, passed: z.literal(true) }).strict()).min(1).max(20),
  layoutPassed: z.literal(true), keyboardPassed: z.literal(true),
}).strict();
export const websiteReviewSchema = z.object({
  version: z.literal(1), identity: sha, id: z.string().regex(/^[a-z0-9-]+$/),
  promptSHA256: sha, sourceSHA256: sha,
  artifact: z.object({ url: z.url(), sha256: sha, byteLength: z.number().int().positive().max(websiteArtifactByteLimit),
    format: z.literal("self-contained-html"), author: text, license: z.literal("CC0-1.0"),
  }).strict(),
  preview: screenshotSchema.extend({ format: z.literal("jpg") }),
  reviewerID: z.string().regex(/^[a-z0-9-]{1,80}$/), reviewedAt: z.iso.datetime(), verdict: z.literal("approve"),
  method: z.literal("browser-interaction"),
  attestations: z.object({ completePromptCompared: z.literal(true), hostedArtifactInspected: z.literal(true),
    previewMatchesHostedArtifact: z.literal(true), sourceAttributionVerified: z.literal(true),
    sampleContentClearlyLabeled: z.literal(true), noSimulatedSuccess: z.literal(true),
    noRemoteSubresources: z.literal(true),
  }).strict(),
  mobile: viewportSchema, desktop: viewportSchema,
}).strict().superRefine((review, context) => {
  if (review.mobile.width > 600 || review.desktop.width < 1024 || review.mobile.screenshot.sha256 === review.desktop.screenshot.sha256)
    context.addIssue({ code: "custom", message: "Distinct mobile and desktop browser evidence is required" });
});
export type WebsiteReview = z.infer<typeof websiteReviewSchema>;
export const websiteReviewStoreSchema = z.object({ version: z.literal(1), reviews: z.record(sha, websiteReviewSchema) }).strict()
  .superRefine((store, context) => {
    for (const [key, review] of Object.entries(store.reviews)) if (key !== review.identity)
      context.addIssue({ code: "custom", message: "Website review key does not match its identity" });
  });

/** Include all source attribution, including author and pinned revision, unlike a visual-only check. */
export function websiteSourceSHA256(item: Prompt): string {
  const source = item.source;
  return digest(JSON.stringify({ name: source.name, url: source.url, author: source.author ?? null,
    repository: source.repository ?? null, revision: source.revision ?? null, license: source.license, method: source.method }));
}
export function websiteReviewIdentity(item: Prompt, artifactSHA256: string): string {
  return digest(JSON.stringify({ id: item.id, kind: item.kind, promptSHA256: digest(item.prompt), sourceSHA256: websiteSourceSHA256(item),
    model: item.model, contentType: item.contentType ?? "prompt", artifactSHA256,
    demoURL: item.media?.demoURL ?? null, imageURL: item.media?.imageURL ?? null,
    imageURLs: item.media?.imageURLs ?? [], image: item.media?.image ?? null, video: item.media?.video ?? null, videoURL: item.media?.videoURL ?? null }));
}
function artifactHash(item: Prompt): string {
  const value = item.media?.demoURL;
  if (!value || value !== value.trim()) throw new Error("A reviewed HTTPS website artifact is required");
  const url = new URL(value), match = /^\/examples\/([a-f0-9]{64})\.html$(?![\s\S])/.exec(url.pathname);
  if (url.origin !== websiteArtifactOrigin || url.username || url.password || url.search || url.hash || !match || url.href !== value)
    throw new Error("Website demo must use its content-addressed HTML URL on the approved origin");
  return match[1];
}
/** Web screenshots are prepared before browser review. Re-encoding them here would
 * invalidate that review; unreviewed or unavailable bytes are withheld downstream. */
export function websiteMediaNeedsMirroring(item: Prompt): boolean {
  if (item.kind !== "web") return true;
  checkSource(item);
  artifactHash(item);
  if (!/^https:\/\/api\.prompix\.dev\/media\/[a-f0-9]{64}\.jpg$(?![\s\S])/.test(item.media?.imageURL ?? ""))
    throw new Error("Website preview must already be a content-addressed hosted JPEG");
  return false;
}
function checkSource(item: Prompt) {
  // This first community website path supports the existing pinned CC0 source.
  // A website review never expands source licenses or grants native X permission.
  const revision = item.source.revision;
  if (item.kind !== "web" || item.contentType === "skill" || item.source.name !== "prompts.chat" || item.source.license !== "CC0-1.0"
    || !revision || !/^[a-f0-9]{40}$/.test(revision) || !item.source.author?.trim()
    || item.source.url !== `https://github.com/f/prompts.chat/blob/${revision}/prompts.csv`
    || item.id !== `pc-${fingerprint(item.prompt).slice(0, 20)}`)
    throw new Error("Website source is outside the attributed, pinned CC0 community source");
  if (item.media?.image || item.media?.video || item.media?.videoURL || (item.media?.imageURLs && (item.media.imageURLs.length !== 1 || item.media.imageURLs[0] !== item.media.imageURL)))
    throw new Error("Website review requires one exact hosted preview without other media");
}
function checkCSP(header: string | null) {
  const directives = (value: string) => value.split(";").map(part => part.trim().replace(/\s+/g, " ")).filter(Boolean).sort();
  if (!header || JSON.stringify(directives(header)) !== JSON.stringify(directives(websiteContentSecurityPolicy)))
    throw new Error("Website artifact lacks the reviewed self-contained content security policy");
}
async function boundedFile(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error("Invalid website review evidence file");
    const bytes = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < bytes.length) { const result = await file.read(bytes, length, bytes.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
    if (length !== stat.size) throw new Error("Website review file changed while reading");
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}
async function optionalJSON(path: string) {
  try { return JSON.parse((await boundedFile(path, 2_000_000)).toString()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export interface WebsiteReviewDependencies {
  fetch: typeof fetch;
  readEvidence: (sha256: string, format: "png" | "jpg") => Promise<Buffer>;
  now: () => Date;
}

/** Operator attestations are distinct from automated screenshot or metadata judgments. */
export async function verifyWebsiteReview(item: Prompt, input: WebsiteReview, trusted: WebsiteReviewTrust, dependencies: WebsiteReviewDependencies): Promise<void> {
  const review = websiteReviewSchema.parse(input), trust = trustSchema.parse(trusted);
  checkSource(item);
  const artifactSHA256 = artifactHash(item);
  if (!trust.reviewers.includes(review.reviewerID)) throw new Error("Website reviewer is not explicitly trusted");
  if (Date.parse(review.reviewedAt) > dependencies.now().getTime()) throw new Error("Website review is dated in the future");
  if (review.id !== item.id || review.promptSHA256 !== digest(item.prompt) || review.sourceSHA256 !== websiteSourceSHA256(item)
    || review.identity !== websiteReviewIdentity(item, artifactSHA256) || review.artifact.sha256 !== artifactSHA256 || review.artifact.url !== item.media?.demoURL
    || item.media?.imageURL !== `https://api.prompix.dev/media/${review.preview.sha256}.jpg`)
    throw new Error("Website review is stale or does not match the complete source and artifact identity");
  // Keep downloaded proof private. Never execute HTML or follow a redirect here.
  for (const evidence of [review.preview, review.mobile.screenshot, review.desktop.screenshot]) {
    const bytes = await dependencies.readEvidence(evidence.sha256, evidence.format);
    if (bytes.length !== evidence.byteLength || bytes.length > evidenceByteLimit || digest(bytes) !== evidence.sha256)
      throw new Error("Website browser evidence bytes do not match the review");
    const image = evidence.format === "png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) && bytes.subarray(-2).equals(Buffer.from([255, 217]));
    if (!image) throw new Error("Website browser evidence is not the declared image format");
  }
  // The origin is fixed in both the URL validator and explicit operator trust config.
  if (new URL(review.artifact.url).origin !== trust.demoOrigin) throw new Error("Unapproved website demo origin");
  const response = await dependencies.fetch(review.artifact.url, { redirect: "error", signal: AbortSignal.timeout(60_000), headers: { "Cache-Control": "no-cache" } });
  if (response.status !== 200 || response.redirected || (response.url && response.url !== review.artifact.url)) {
    await response.body?.cancel(); throw new Error("Website artifact did not return its exact HTTPS document");
  }
  try { checkCSP(response.headers.get("content-security-policy")); }
  catch (error) { await response.body?.cancel(); throw error; }
  if (!/^text\/html(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel(); throw new Error("Website artifact is not HTML");
  }
  const bytes = await readResponseBytes(response, websiteArtifactByteLimit);
  if (bytes.length !== review.artifact.byteLength || digest(bytes) !== review.artifact.sha256)
    throw new Error("Hosted website artifact changed after browser review");
  const previewURL = item.media!.imageURL!;
  const preview = await dependencies.fetch(previewURL, { redirect: "error", signal: AbortSignal.timeout(60_000), headers: { "Cache-Control": "no-cache" } });
  if (preview.status !== 200 || preview.redirected || (preview.url && preview.url !== previewURL)
    || !/^image\/jpeg(?:\s*;|$)/i.test(preview.headers.get("content-type") ?? "")) {
    await preview.body?.cancel(); throw new Error("Website preview did not return its exact hosted JPEG");
  }
  const previewBytes = await readResponseBytes(preview, evidenceByteLimit);
  if (previewBytes.length !== review.preview.byteLength || digest(previewBytes) !== review.preview.sha256)
    throw new Error("Hosted website preview changed after browser review");
}

/** Operator records follow genuine browser review, not source claims or automatic model output. */
export async function websiteReviewer(root: string, fetcher: typeof fetch = fetch): Promise<(item: Prompt) => Promise<void>> {
  const directory = join(root, "web-review"), rawTrust = await optionalJSON(join(directory, "trust.json"));
  const rawStore = await optionalJSON(join(directory, "reviews.json"));
  const trust = rawTrust === undefined ? undefined : trustSchema.parse(rawTrust);
  const store = rawStore === undefined ? undefined : websiteReviewStoreSchema.parse(rawStore);
  return async item => {
    if (!trust || !store) throw new Error("A real webpage inspection by an explicitly trusted reviewer is required");
    const identity = websiteReviewIdentity(item, artifactHash(item)), review = store.reviews[identity];
    if (!review) throw new Error("A real webpage review matching this exact source and artifact is required");
    await verifyWebsiteReview(item, review, trust, { fetch: fetcher, now: () => new Date(),
      readEvidence: (sha256, format) => boundedFile(join(directory, "evidence", `${sha256}.${format}`), evidenceByteLimit),
    });
  };
}
