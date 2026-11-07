import type { Prompt } from "../packages/schema/catalog.ts";
import { translationFingerprint } from "./translation.ts";

/** Hashtags (never a hex colour) and links back to the post itself, at the very end of the text. */
function trailingTag(postID: string) {
  return new RegExp(`(?:^|\\s+)(?:#(?![0-9a-f]{3,8}(?![\\p{L}\\p{N}_]))[\\p{L}\\p{M}][\\p{L}\\p{M}\\p{N}_]*`
    + `|https://(?:www\\.)?(?:x|twitter)\\.com/[^\\s/]+/status/${postID}(?:/(?:photo|video)/\\d+)?/?)$`, "iu");
}
export function stripTrailingTags(text: string, postID: string): string {
  const pattern = trailingTag(postID);
  let next = text.trimEnd();
  while (pattern.test(next)) next = next.replace(pattern, "").trimEnd();
  // A body made only of tags is left for the editorial and source checks to judge.
  return next.trim() ? next : text;
}

/** X posts often end with hashtags and the post's own media link; neither is part of the
 * prompt, and the link already lives in source.url. Applied to the published text and every
 * translation of it after editorial and source checks, which stay bound to the original. */
export function withoutTrailingTags(item: Prompt): Prompt {
  const postID = item.source.post?.id;
  if (item.source.name !== "X" || !postID) return item;
  const prompt = stripTrailingTags(item.prompt, postID);
  if (prompt === item.prompt) return item;
  const cleaned = { ...item, prompt };
  const localization = item.localization;
  if (!localization) return cleaned;
  // A translation stays attached only while it matched the original text.
  if (localization.sourceFingerprint !== translationFingerprint(item)) return { ...cleaned, localization };
  const translations = Object.fromEntries(Object.entries(localization.translations)
    .map(([locale, text]) => [locale, text && { ...text, prompt: stripTrailingTags(text.prompt, postID) }]));
  return { ...cleaned, localization: { ...localization, translations, sourceFingerprint: translationFingerprint(cleaned) } };
}

/** "Name | tagline" display names keep the name; the tagline becomes the bio when there is none. */
export function withCleanCreator(item: Prompt): Prompt {
  const creator = item.creator;
  const match = creator && /^(.+?)\s*[|｜丨]\s*(.+)$/u.exec(creator.displayName);
  if (!creator || !match || !match[1].trim()) return item;
  return { ...item, creator: { ...creator, displayName: match[1].trim(), ...(creator.bio ? {} : { bio: match[2].trim() }) } };
}
