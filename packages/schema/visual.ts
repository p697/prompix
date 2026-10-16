import type { Prompt } from "./catalog.ts";

/** A creative label or platform dependency is not a visual preview. */
export function hasVisualPreview(item: Pick<Prompt, "media">): boolean {
  return !!(item.media?.imageURL || item.media?.image);
}
