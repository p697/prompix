import { z } from "zod";
import { readResponseBytes } from "./network.ts";
import { XSpendBudget } from "./x-spend.ts";

const numericID = z.string().regex(/^\d{1,19}$/);
const idsSchema = z.array(numericID).min(1).max(200)
  .refine(ids => new Set(ids).size === ids.length, "Duplicate RapidAPI request IDs");

/** Inspect identity only. Unavailable placeholders and omissions are unresolved,
 * never authoritative removal evidence or permission to extend source freshness. */
export function inspectRapidAPILookup(raw: unknown, ids: readonly string[]) {
  idsSchema.parse(ids);
  const envelope = z.object({ result: z.object({ tweetResult: z.array(z.object({ result: z.unknown() }).passthrough()).max(200) }).passthrough(),
    error: z.unknown().optional(), errors: z.unknown().optional() }).passthrough().parse(raw);
  if (envelope.error != null || envelope.errors != null) throw new Error("RapidAPI returned an application error");
  const returnedIDs: string[] = [];
  let unavailablePlaceholders = 0;
  for (const item of envelope.result.tweetResult) {
    const wrapper = z.object({ __typename: z.string(), tweet: z.unknown().optional() }).passthrough().parse(item.result);
    if (["TweetTombstone", "TweetUnavailable"].includes(wrapper.__typename)) { unavailablePlaceholders++; continue; }
    // Live visibility wrappers omit the nested typename. Only this known wrapper
    // may do so; an explicit contradictory type or a bare untyped object fails.
    const tweet = wrapper.__typename === "TweetWithVisibilityResults"
      ? z.object({ __typename: z.literal("Tweet").optional(), rest_id: numericID }).passthrough().parse(wrapper.tweet)
      : z.object({ __typename: z.literal("Tweet"), rest_id: numericID }).passthrough().parse(wrapper);
    if (returnedIDs.includes(tweet.rest_id) || !ids.includes(tweet.rest_id)) throw new Error("RapidAPI returned inconsistent identities");
    returnedIDs.push(tweet.rest_id);
  }
  return { returnedIDs, missingIDs: ids.filter(id => !returnedIDs.includes(id)), unavailablePlaceholders,
    sourceFidelityVerified: false as const, productionSwitchAllowed: false as const };
}

/** Isolated pilot, deliberately absent from production routing. Its fixed fee and
 * every attempted request use the shared ledger, including failures and timeouts. */
export class RapidAPIPilotClient {
  constructor(private readonly key: string, private readonly budget: XSpendBudget, private readonly fetcher: typeof fetch = fetch) {
    if (!key.trim() || /\s/.test(key)) throw new Error("Missing or invalid RapidAPI key");
  }
  async lookup(ids: readonly string[], capture: (evidence: unknown) => Promise<void>) {
    idsSchema.parse(ids);
    const url = new URL("https://twitter241.p.rapidapi.com/tweet-by-ids");
    url.searchParams.set("tweetIds", ids.join(","));
    const reservation = await this.budget.reserve("rapidapi", "lookup", url.toString(), 1);
    try {
      let response: Response;
      try { response = await this.fetcher(url, { headers: { "x-rapidapi-key": this.key, "x-rapidapi-host": url.hostname },
        redirect: "manual", signal: AbortSignal.timeout(60_000) }); }
      catch { throw new Error("RapidAPI transport failed; attempt remains accounted"); }
      const quota = Object.fromEntries(["x-ratelimit-requests-limit", "x-ratelimit-requests-remaining", "x-ratelimit-requests-reset",
        "x-ratelimit-rapid-free-plans-hard-limit-remaining", "retry-after"].map(name => [name, response.headers.get(name)]));
      const bytes = await readResponseBytes(response, response.ok ? 16_000_000 : 64_000);
      // Preserve the original bytes before parsing an unfamiliar provider response.
      // Capture must stay outside Git; a parser repair never needs a second charge.
      await capture({ status: response.status, quota, bytes: bytes.length, body: bytes.toString() });
      if (!response.ok) throw new Error(`RapidAPI HTTP ${response.status}`);
      const raw: unknown = JSON.parse(bytes.toString());
      const inspection = inspectRapidAPILookup(raw, ids);
      await reservation.finish(1);
      return { raw, inspection };
    } catch (error) {
      try { await reservation.finish(); } catch { /* Keep the durable reservation/settlement. */ }
      if (error instanceof Error && /^RapidAPI (transport failed|HTTP \d+|returned (an application error|inconsistent identities))/.test(error.message)) throw error;
      throw new Error("RapidAPI response validation or capture failed; attempt remains accounted");
    }
  }
}
