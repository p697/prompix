import { z } from "zod";
import { readResponseBytes } from "./network.ts";
import type { XSpendBudget } from "./x-spend.ts";

export const rapidAPIIDsSchema = z.array(z.string().regex(/^\d{1,19}$/)).min(1).max(200)
  .refine(ids => new Set(ids).size === ids.length, "Duplicate RapidAPI request IDs");
export function rapidAPILookupURL(ids: readonly string[]) {
  rapidAPIIDsSchema.parse(ids);
  const url = new URL("https://twitter241.p.rapidapi.com/tweet-by-ids");
  url.searchParams.set("tweetIds", ids.join(","));
  return url;
}

/** One accounted request, no redirects/retries. Original bytes are captured before
 * parsing so response repairs never require buying the same request again. */
export async function readRapidAPILookup<T>(options: {
  key: string; url: URL; reservation: Awaited<ReturnType<XSpendBudget["reserve"]>>;
  capture: (evidence: unknown) => Promise<void>; parse: (raw: unknown) => T;
  observeQuota?: (quota: Record<string, string | null>) => Promise<unknown>; fetcher: typeof fetch;
}) {
  const { key, url, reservation, capture } = options;
  try {
    let response: Response;
    try { response = await options.fetcher(url, { headers: { "x-rapidapi-key": key, "x-rapidapi-host": url.hostname },
      redirect: "manual", signal: AbortSignal.timeout(60_000) }); }
    catch { throw new Error("RapidAPI transport failed; attempt remains accounted"); }
    const quota = Object.fromEntries(["x-ratelimit-requests-limit", "x-ratelimit-requests-remaining", "x-ratelimit-requests-reset",
      "x-ratelimit-rapid-free-plans-hard-limit-remaining", "retry-after"].map(name => [name, response.headers.get(name)]));
    const bytes = await readResponseBytes(response, response.ok ? 16_000_000 : 64_000);
    await capture({ status: response.status, quota, bytes: bytes.length, body: bytes.toString() });
    await options.observeQuota?.(quota);
    if (!response.ok) throw new Error(`RapidAPI HTTP ${response.status}`);
    const raw: unknown = JSON.parse(bytes.toString()), result = options.parse(raw);
    await reservation.finish(1);
    return { raw, result };
  } catch (error) {
    try { await reservation.finish(); } catch { /* Retain durable reservation or settlement. */ }
    if (error instanceof Error && /^RapidAPI (transport failed; attempt remains accounted|HTTP \d{3}|returned (an application error|inconsistent identities))$/.test(error.message)) throw error;
    throw new Error("RapidAPI response validation or capture failed; attempt remains accounted");
  }
}
