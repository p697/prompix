import { z } from "zod";
import { readResponseBytes } from "./network.ts";
import { XSpendBudget } from "./x-spend.ts";

const idsSchema = z.array(z.string().regex(/^\d{1,19}$/)).min(1).max(200)
  .refine(ids => new Set(ids).size === ids.length, "Duplicate TweetAPI request IDs");

/** Validate identity/envelope only. This is NOT source fidelity or publication approval. */
export function inspectTweetAPILookup(raw: unknown, ids: readonly string[]) {
  idsSchema.parse(ids);
  const envelope = z.object({ data: z.object({ tweets: z.array(z.object({ id: z.string().regex(/^\d{1,19}$/) })
    .passthrough()).max(200) }).passthrough(), error: z.unknown().optional(), errors: z.unknown().optional() }).passthrough().parse(raw);
  if (envelope.error != null || envelope.errors != null) throw new Error("TweetAPI returned an application error");
  const returned = envelope.data.tweets.map(tweet => tweet.id);
  if (new Set(returned).size !== returned.length || returned.some(id => !ids.includes(id)))
    throw new Error("TweetAPI returned inconsistent identities");
  return { returnedIDs: returned, missingIDs: ids.filter(id => !returned.includes(id)), sourceFidelityVerified: false as const };
}

/** Isolated read-only pilot; never imported by production discovery or maintenance routing. */
export class TweetAPIPilotClient {
  constructor(private readonly key: string, private readonly budget: XSpendBudget,
    private readonly fetcher: typeof fetch = fetch) {
    if (!key.trim() || /\s/.test(key)) throw new Error("Missing or invalid TweetAPI key");
  }
  async lookup(ids: readonly string[], capture: (raw: unknown) => Promise<void>) {
    idsSchema.parse(ids);
    const url = new URL("https://api.tweetapi.com/tw-v2/tweet/details-by-ids");
    url.searchParams.set("ids", ids.join(","));
    const reservation = await this.budget.reserve("tweetapi", "lookup", url.toString(), 1);
    try {
      let response: Response;
      try { response = await this.fetcher(url, { headers: { "X-API-Key": this.key }, redirect: "manual", signal: AbortSignal.timeout(60_000) }); }
      catch { throw new Error("TweetAPI transport failed; request remains accounted"); }
      if (!response.ok) {
        await response.body?.cancel();
        // No automatic retry, refund assumption, or redirect carrying the credential.
        throw new Error(`TweetAPI HTTP ${response.status}`);
      }
      let raw: unknown;
      try { raw = JSON.parse((await readResponseBytes(response, 16_000_000)).toString()); }
      catch { throw new Error("TweetAPI returned invalid or oversized JSON"); }
      await capture(raw);
      await reservation.finish(1);
      return { raw, inspection: inspectTweetAPILookup(raw, ids) };
    } catch (error) {
      try { await reservation.finish(); } catch { /* Preserve the original reservation or completed settlement. */ }
      if (error instanceof Error && /^TweetAPI (transport failed|HTTP \d+|returned (invalid or oversized JSON|an application error|inconsistent identities))/.test(error.message)) throw error;
      throw new Error("TweetAPI response validation or evidence capture failed");
    }
  }
}
