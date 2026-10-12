import type { Prompt } from "../packages/schema/catalog.ts";
import { fingerprint, type Candidate } from "./sources.ts";

export type KindCounts = Record<Prompt["kind"], number> & { total: number };

export function countByKind(items: readonly Pick<Prompt, "kind">[]): KindCounts {
  const counts: KindCounts = { total: items.length, text: 0, image: 0, video: 0, web: 0 };
  for (const item of items) counts[item.kind]++;
  return counts;
}

/** Select the complete eligible library after current-fingerprint editorial review. */
export function selectLibrary(items: readonly Candidate[], excluded: ReadonlySet<string>): Candidate[] {
  const eligible = items.filter((item) => {
    if (
      excluded.has(item.id) ||
      item.prompt.length < (item.editorialRank !== undefined ? 20 : 80) ||
      item.prompt.length > 30000 ||
      item.title.length > 160 ||
      item.reviewStatus !== "candidate" ||
      (item.kind === "video" && !(item.media?.imageURL && item.media?.videoURL))
    ) return false;
    return !/nsfw|porn|nudity|nude |jailbreak|越狱|裸体|色情|鬼灭之刃|demon slayer|dragon ball|naruto|蜘蛛侠|spider-man|血腥|gore/i.test(
      item.title + " " + item.prompt,
    );
  });
  eligible.sort((a, b) => {
    const rank = (b.editorialRank ?? -1) - (a.editorialRank ?? -1);
    if (rank) return rank;
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    const left = BigInt(a.source.url?.match(/status\/(\d+)/)?.[1] ?? "0");
    const right = BigInt(b.source.url?.match(/status\/(\d+)/)?.[1] ?? "0");
    return left === right ? a.id.localeCompare(b.id) : left > right ? -1 : 1;
  });
  // Deduplicate across all sources after eligibility and ranking, so an
  // unreviewed or removed copy cannot hide the best approved source post.
  const seen = new Set<string>();
  return eligible.filter((item) => {
    if (seen.has(item.fingerprint)) return false;
    seen.add(item.fingerprint);
    return true;
  });
}

/** Interleave the entire library; homepage curation must never truncate it. */
export function interleaveLibrary(
  community: readonly Prompt[],
  bundled: readonly Prompt[],
  excluded: ReadonlySet<string>,
): Prompt[] {
  const groups = [
    community.filter((item) => item.kind === "image"),
    bundled.filter((item) => item.kind === "text"),
    community.filter((item) => item.kind === "video"),
    bundled.filter((item) => item.kind === "web"),
    community.filter((item) => item.kind === "text"),
    community.filter((item) => item.kind === "web"),
    // Production fallback contains real original images, not motion fixtures.
    bundled.filter((item) => item.kind === "image" && item.media?.image),
  ];
  const prompts: Prompt[] = [];
  const seen = new Set<string>();
  for (let row = 0; groups.some((group) => group.length > row); row++) {
    for (const group of groups) {
      const item = group[row];
      if (!item || excluded.has(item.id)) continue;
      const hash = fingerprint(item.prompt);
      if (seen.has(hash)) continue;
      prompts.push(item);
      seen.add(hash);
    }
  }
  if (prompts.length > 1000) {
    throw new Error(`Complete library has ${prompts.length} entries, exceeding the 1000-entry client protocol limit; no entries were truncated and the active edition must remain unchanged`);
  }
  return prompts;
}

export function assertLibraryDownloadSize(bytes: Uint8Array): void {
  if (bytes.byteLength > 10_000_000) {
    throw new Error(`Complete library is ${bytes.byteLength} bytes, exceeding the 10000000-byte client download limit; the active edition must remain unchanged`);
  }
}

/** Count real catalog membership changes, not how many cards ran through a job. */
export function libraryDelta(previous: readonly Prompt[], next: readonly Prompt[]) {
  const before = new Set(previous.map((item) => item.id));
  const after = new Set(next.map((item) => item.id));
  return {
    added: countByKind(next.filter((item) => !before.has(item.id))),
    removed: countByKind(previous.filter((item) => !after.has(item.id))),
    retained: next.filter((item) => before.has(item.id)).length,
  };
}
