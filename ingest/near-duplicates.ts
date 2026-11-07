import type { Prompt } from "../packages/schema/catalog.ts";

/** Two prompts sharing this share of their word shingles are one prompt (owner, 2026-11-07:
 * the same prompt text is a duplicate even with different result images). */
export const duplicateSimilarity = 0.8;
/** Shorter prompts are too generic to compare safely. */
const minimumShingles = 8;
/** More live takedowns than this in one run is far likelier a fault than real reposts. */
export const duplicateTakedownLimit = 50;

/** Words for spaced scripts, single characters for Chinese, Japanese and Korean, so both compare by meaning-bearing units. */
function tokens(text: string): string[] {
  return text.toLowerCase().replace(/https?:\/\/\S+/g, " ")
    .match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+/gu) ?? [];
}
function shingles(text: string): Set<string> {
  const words = tokens(text), set = new Set<string>();
  for (let index = 0; index + 4 <= words.length; index++) set.add(words.slice(index, index + 4).join(" "));
  return set;
}

/** Later copies of the same prompt, keeping the earliest post in each group: by publication
 * time, then by id. Items without a time count as earliest, so library originals stay. */
export function laterDuplicates(items: readonly Prompt[]): Map<string, string> {
  const order = [...items].sort((a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? "") || a.id.localeCompare(b.id));
  const sets = order.map(item => shingles(item.prompt)), index = new Map<string, number[]>(), later = new Map<string, string>();
  for (const [position, set] of sets.entries()) {
    if (set.size < minimumShingles) continue;
    const overlap = new Map<number, number>();
    for (const shingle of set) for (const earlier of index.get(shingle) ?? []) overlap.set(earlier, (overlap.get(earlier) ?? 0) + 1);
    for (const [earlier, shared] of overlap) {
      if (later.has(order[earlier].id)) continue;
      if (shared / (set.size + sets[earlier].size - shared) >= duplicateSimilarity) { later.set(order[position].id, order[earlier].id); break; }
    }
    if (!later.has(order[position].id)) for (const shingle of set) index.set(shingle, [...(index.get(shingle) ?? []), position]);
  }
  return later;
}
