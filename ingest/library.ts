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

export type RetentionReason = "awaiting-review" | "media-failed" | "source-missing" | "not-prepared" | "duplicate-update";
export type RetentionReport = { counts: KindCounts; reasons: Record<RetentionReason, number> };

/** Keep a complete published snapshot until a replacement is ready or explicitly removed. */
export function retainPublishedLibrary(
  prepared: readonly Prompt[], previous: readonly Prompt[], excluded: ReadonlySet<string>,
  reasonForMissing: (item: Prompt) => RetentionReason = () => "not-prepared",
): { prompts: Prompt[]; retainedPrevious: RetentionReport } {
  const ready = prepared.filter(item => !excluded.has(item.id));
  const readyByID = new Map(ready.map(item => [item.id, item]));
  if (readyByID.size !== ready.length) throw new Error("Prepared library contains duplicate IDs; active edition must remain unchanged");
  const active = previous.filter(item => !excluded.has(item.id));
  const previousByHash = new Map(active.map(item => [fingerprint(item.prompt), item.id]));
  const retained: Prompt[] = [];
  const reasons: RetentionReport["reasons"] = { "awaiting-review": 0, "media-failed": 0, "source-missing": 0, "not-prepared": 0, "duplicate-update": 0 };
  const replacements = new Map(active.map(item => {
    const update = readyByID.get(item.id);
    const conflictingID = update ? previousByHash.get(fingerprint(update.prompt)) : undefined;
    if (update && (!conflictingID || conflictingID === item.id)) return [item.id, update] as const;
    retained.push(item);
    reasons[update ? "duplicate-update" : reasonForMissing(item)]++;
    return [item.id, item] as const;
  }));
  // Reserve previous identities before deduplicating new source posts. A newly
  // ranked copy must not replace an ID already held in a user's saved collection.
  const reservedHashes = new Set([...replacements.values()].map(item => fingerprint(item.prompt)));
  const seenIDs = new Set<string>(), seenHashes = new Set<string>();
  const prompts: Prompt[] = [];
  const append = (item: Prompt) => {
    prompts.push(item); seenIDs.add(item.id); seenHashes.add(fingerprint(item.prompt));
  };
  for (const item of ready) {
    const existing = replacements.get(item.id);
    if (existing) { append(existing); continue; }
    const hash = fingerprint(item.prompt);
    if (!reservedHashes.has(hash) && !seenHashes.has(hash)) append(item);
  }
  for (const item of replacements.values()) if (!seenIDs.has(item.id)) append(item);
  if (prompts.length > 1000) {
    throw new Error(`Complete retained library has ${prompts.length} entries, exceeding the 1000-entry client protocol limit; no published items were discarded`);
  }
  const resultingIDs = new Set(prompts.map(item => item.id));
  if (active.some(item => !resultingIDs.has(item.id))) throw new Error("Previously published items are missing without tombstones; active edition must remain unchanged");
  return { prompts, retainedPrevious: { counts: countByKind(retained), reasons } };
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
