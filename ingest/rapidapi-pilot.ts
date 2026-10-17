import { z } from "zod";
import { rapidAPIIDsSchema, rapidAPILookupURL, readRapidAPILookup } from "./rapidapi-transport.ts";
import { XSpendBudget } from "./x-spend.ts";

const numericID = z.string().regex(/^\d{1,19}$/);

/** Inspect identity only. Unavailable placeholders and omissions are unresolved,
 * never authoritative removal evidence or permission to extend source freshness. */
export function inspectRapidAPILookup(raw: unknown, ids: readonly string[]) {
  rapidAPIIDsSchema.parse(ids);
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
    const url = rapidAPILookupURL(ids);
    const reservation = await this.budget.reserve("rapidapi", "lookup", url.toString(), 1);
    const { raw, result: inspection } = await readRapidAPILookup({ key: this.key, url, reservation, capture,
      parse: raw => inspectRapidAPILookup(raw, ids), fetcher: this.fetcher });
    return { raw, inspection };
  }
}
