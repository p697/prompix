import { isAbsolute } from "node:path";
import { z } from "zod";
import { catalogSchema, localizationLanguages, type Catalog } from "../packages/schema/catalog.ts";
import { languagePackByteLimit } from "../packages/schema/language-packs.ts";
import { contentRoot, lockContent } from "./publication.ts";
import { qualityHoldRecordSchema, readQualityReviewFile, saveQualityHold } from "./quality-holds.ts";

const [itemID, path, catalogPath, ...extra] = process.argv.slice(2);
if (!itemID || !path || !isAbsolute(path) || !catalogPath || !isAbsolute(catalogPath) || extra.length)
  throw new Error("Usage: npm run quality:hold -- <id> /absolute/path/operator-review.json /absolute/path/inspected-catalog.json");
// The operator record binds its ID and exact inspected original/media to external evidence.
// It is not produced by source text, automatic model decisions or discovery status.
const inputSchema = qualityHoldRecordSchema.extend({ id: z.literal(itemID) }).strict();
const unlock = await lockContent(contentRoot);
try {
  const { id, ...review } = inputSchema.parse(await readQualityReviewFile(path));
  const snapshot = await readQualityReviewFile(catalogPath, languagePackByteLimit * (localizationLanguages.length + 1));
  catalogSchema.parse(snapshot);
  // Validate structure above, but preserve exact inspected text when computing its identity.
  const inspected = (snapshot as Catalog).prompts.find(item => item.id === id);
  if (!inspected) throw new Error("Reviewed ID is missing from the inspected catalog");
  await saveQualityHold(contentRoot, inspected, review);
  console.log(JSON.stringify({ id, status: "quality-held-for-next-edition", published: false, removalTombstoneAdded: false }));
} finally { await unlock(); }
