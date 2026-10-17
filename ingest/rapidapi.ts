import { XSpendBudget, type XSpendPurpose } from "./x-spend.ts";
import { parseRapidAPISources } from "./rapidapi-sources.ts";
import { rapidAPILookupURL, readRapidAPILookup } from "./rapidapi-transport.ts";

/** Existing-source verification only; acquisition remains official. Installation
 * does not configure a cycle or select this provider. */
export class RapidAPIClient {
  constructor(private readonly key: string, private readonly budget: XSpendBudget, private readonly fetcher: typeof fetch = fetch) {
    if (!key.trim() || /\s/.test(key)) throw new Error("Missing or invalid RapidAPI key");
  }
  async lookup(ids: readonly string[], capture: (evidence: unknown) => Promise<void>, purpose: XSpendPurpose = "growth") {
    const url = rapidAPILookupURL(ids);
    if (typeof capture !== "function") throw new Error("RapidAPI maintenance requires durable response capture");
    const reservation = await this.budget.reserveRapidAPICycleLookup(url.toString(), purpose);
    return readRapidAPILookup({ key: this.key, url, reservation, capture, fetcher: this.fetcher,
      parse: raw => parseRapidAPISources(raw, ids), observeQuota: async quota => {
        const remaining = quota["x-ratelimit-requests-remaining"];
        if (quota["x-ratelimit-requests-limit"] !== "1000" || remaining === null || !/^\d{1,4}$/.test(remaining))
          throw new Error("RapidAPI response omitted the expected subscription quota");
        await this.budget.observeRapidAPICycleQuota(reservation.id, Number(remaining));
      } });
  }
}
