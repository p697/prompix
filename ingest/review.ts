import { readFile, mkdir, writeFile, rename, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { editorialMetadataSchema, reviewsSchema, applyEditorialReviews } from "./editorial.ts";
import { repositories, videoArchive, type Candidate } from "./sources.ts";
import { skillSources } from "./skills.ts";
import { lockContent } from "./publication.ts";
import { isNativeXDraft } from "./x-intake.ts";

const [id, metadataFile] = process.argv.slice(2);
if (!id || !/^[a-z0-9-]+$/.test(id) || !metadataFile)
  throw new Error("Usage: npm run review -- <candidate-id> /absolute/path/to/editorial-metadata.json");
const root = resolve(process.env.PROMPIX_CONTENT_DIR ?? join(homedir(), ".local/share/prompix/content"));
await mkdir(root, { recursive: true });
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const relativeRoot = relative(await realpath(repo), await realpath(root));
if (!relativeRoot || (!relativeRoot.startsWith("..") && !isAbsolute(relativeRoot)))
  throw new Error("Editorial content must stay outside the repository");
const unlock = await lockContent(root);
try {
let candidate: Candidate | undefined;
for (const source of [...repositories.map((source) => source.id), "prompts-chat", "x-native", videoArchive.id, ...skillSources.map(source => `skill-${source.id}`)]) {
  try {
    const items: Candidate[] = JSON.parse(await readFile(join(root, "candidates", `${source}.json`), "utf8"));
    candidate = items.find((item) => item.id === id);
    if (candidate) break;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
if (!candidate) throw new Error("Candidate not found; collect its allowlisted source first");
const metadata = editorialMetadataSchema.parse(JSON.parse(await readFile(resolve(metadataFile), "utf8")));
const file = join(root, "editorial.json");
let reviews = reviewsSchema.parse({});
try { reviews = reviewsSchema.parse(JSON.parse(await readFile(file, "utf8"))); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
reviews[id] = { fingerprint: candidate.fingerprint, reviewedAt: new Date().toISOString(), metadata };
const approved = applyEditorialReviews([candidate], reviews)[0];
if (approved.reviewStatus !== "candidate" && !isNativeXDraft(candidate)) throw new Error("Website review requires both a working demo URL and a real preview image URL");
await writeFile(`${file}.tmp`, JSON.stringify(reviews, null, 2) + "\n");
await rename(`${file}.tmp`, file);
const visual = approved.kind !== "text" || !!(approved.media?.imageURL || approved.media?.imageURLs?.length || approved.media?.videoURL);
console.log(JSON.stringify({ reviewed: id, status: isNativeXDraft(candidate) ? "draft-awaiting-source-review"
  : visual ? "metadata-reviewed-awaiting-media-check" : "ready-for-next-edition", published: false }));
} finally { await unlock(); }
