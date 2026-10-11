import type { Candidate } from "./sources.ts";
import type { Reviews } from "./editorial.ts";

/** Expand only the upstream's exact named-default notation, after review. */
export function publicationText(candidate: Candidate, reviews: Reviews): string {
  if (reviews[candidate.id]?.fingerprint !== candidate.fingerprint) return candidate.prompt;
  const replace = (text: string) => text.replace(
    /\{argument name="[^"\r\n{}]+" default="([^"\r\n{}]*)"\}/g,
    (_match, value: string) => value,
  );
  // Some source prompts are JSON documents. Decode string values first so the
  // escaped macro quotes do not leak into a copied prompt or break valid JSON.
  try {
    JSON.parse(candidate.prompt);
    return candidate.prompt.replace(/"(?:[^"\\]|\\[\s\S])*"/g, (token, offset: number) => {
      // Keep keys, whitespace and numeric literals byte-for-byte. Re-encoding
      // the whole document could lose precision in unrelated large numbers.
      if (/^\s*:/.test(candidate.prompt.slice(offset + token.length))) return token;
      const value: string = JSON.parse(token);
      const expanded = replace(value);
      return expanded === value ? token : JSON.stringify(expanded);
    });
  } catch {
    return replace(candidate.prompt);
  }
}
