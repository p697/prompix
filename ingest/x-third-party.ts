import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { atomic } from "./publication.ts";
import { TwitterAPIClient, type TwitterAPIResult } from "./twitterapi.ts";
import { configuredXSpendBudget, XBudgetExceeded, type XSpendPurpose } from "./x-spend.ts";
import type { XFeedSearch } from "./x-feed.ts";
import type { checkXAvailability } from "./x.ts";

export type XAcquisition = Omit<Awaited<ReturnType<typeof checkXAvailability>>, "posts"> & {
  posts: TwitterAPIResult["posts"];
  provider?: "twitterapi" | "rapidapi"; unknownIDs?: string[];
};
export type XSourceLookup = (credential: string, ids: readonly string[], purpose?: XSpendPurpose) => Promise<XAcquisition>;

export function thirdPartyOnly(env: NodeJS.ProcessEnv = process.env) {
  return env.PROMPIX_X_DISCOVERY_PROVIDER === "third-party";
}

/** The original response is durable before parsing. Missing IDs remain unknown,
 * never an assertion of deletion or a new copyright permission. */
export function thirdPartySourceLookup(root: string, env: NodeJS.ProcessEnv = process.env,
  lookup?: TwitterAPIClient["lookup"], sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))): XSourceLookup {
  const budget = configuredXSpendBudget(env);
  if (!budget || !env.TWITTERAPI_IO_KEY) throw new Error("Third-party acquisition requires a key and shared spend budget");
  const client = new TwitterAPIClient(env.TWITTERAPI_IO_KEY, budget);
  return async (_credential, ids, purpose = "growth") => {
    if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => !/^\d{1,19}$/.test(id)))
      throw new Error("Invalid third-party acquisition IDs");
    const parts: TwitterAPIResult[] = [];
    for (let offset = 0; offset < ids.length; offset += 50) {
      const batch = ids.slice(offset, offset + 50), at = new Date().toISOString();
      await sleep(6500);
      try {
        const { result } = await (lookup ?? client.lookup.bind(client))(batch,
          raw => atomic(join(root, "x-acquisition-evidence", `${randomUUID()}.json`), { provider: "twitterapi", capturedAt: at, ids: batch, raw }), purpose);
        parts.push(result);
      } catch (error) {
        // A later unsent request cannot make an already billed earlier batch
        // look wholly unsent to admission. Preserve its unresolved reservation.
        if (parts.length && error instanceof XBudgetExceeded) throw new Error("Partial acquisition stopped at budget; replay retained evidence before retrying");
        throw error;
      }
    }
    const unique = <T>(items: T[], key: (value: T) => string) => {
      const values = new Map<string, T>();
      for (const item of items) {
        const previous = values.get(key(item));
        if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw new Error("Conflicting third-party source expansions");
        values.set(key(item), item);
      }
      return [...values.values()];
    };
    return { provider: "twitterapi", posts: parts.flatMap(p => p.posts), unavailable: [], unknownIDs: parts.flatMap(p => p.unknownIDs),
      creators: unique(parts.flatMap(p => p.creators), c => c.externalID!), media: unique(parts.flatMap(p => p.media), m => m.media_key) };
  };
}

/** Independent search cursor namespace; the shared request/spend ledgers are retained. */
export function thirdPartyFeedSearch(root: string, env: NodeJS.ProcessEnv = process.env,
  search?: TwitterAPIClient["search"], lookup?: TwitterAPIClient["lookup"],
  sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))): XFeedSearch {
  const budget = configuredXSpendBudget(env);
  if (!budget || !env.TWITTERAPI_IO_KEY) throw new Error("Third-party search requires a key and shared spend budget");
  const client = new TwitterAPIClient(env.TWITTERAPI_IO_KEY, budget), lookupSource = thirdPartySourceLookup(root, env, lookup, sleep);
  return async (_credential, request) => {
    if (request.limit !== 20) throw new Error("Third-party search page size must be 20");
    const query = request.query + (request.since ? ` since_id:${request.since}` : "");
    await sleep(6500);
    const { result } = await (search ?? client.search.bind(client))(query, request.nextToken,
      raw => atomic(join(root, "x-acquisition-evidence", `${randomUUID()}.json`), { provider: "twitterapi", capturedAt: new Date().toISOString(), query, raw }));
    const rootID = /\bconversation_id:(\d{1,19})\b/.exec(query)?.[1];
    let rootCheck;
    if (rootID && !result.nextToken && !result.posts.some(post => post.id === rootID)) {
      const source = await lookupSource("", [rootID]);
      rootCheck = { ...source, capturedAt: new Date().toISOString() };
    }
    return { ...result, request, rootCheck,
      newest: result.posts.map(post => post.id).sort((a, b) => BigInt(a) > BigInt(b) ? -1 : 1)[0] };
  };
}
