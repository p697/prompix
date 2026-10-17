# Batch-priced X maintenance pilot

2026-10-17. **The user has stopped this candidate after repeated registration problems. Do not resume signup or request payment.** The isolated **TweetAPI (`tweetapi.com`)** pilot remains dormant with zero vendor API calls. It is a different service from the production **TwitterAPI.io** route. Neither the pilot nor its plan enables production maintenance or new-source acquisition.

## Why test another provider

TwitterAPI.io charges per returned post. Checking 10,000 X originals twice daily for 30 days is approximately $90 before fallbacks. Re-reading creator timelines is not automatically cheaper: our frozen 180-original snapshot spans 111 creators, with at most eight originals per creator. At TwitterAPIs.com's $0.0024/history-call, even one call per creator would exceed the existing per-post route at that density. Timeline omissions also require separate lookups; they are not deletion evidence.

[TweetAPI's bulk endpoint](https://tweetapi.com/docs/tweet/details-by-ids) accepts up to 200 IDs. Its [OpenAPI](https://tweetapi.com/openapi-v2.json) specifies `x-tweetapi-request-cost: 1` and no X-account authentication. [PAYG](https://tweetapi.com/pricing) is $5/10,000 units; the [metering terms](https://tweetapi.com/terms) bill units per call, including billable empty results. These published contracts suggest 3,000 full batches/month, or $1.50 of consumption for the same 10,000-source check schedule. With 50 IDs/batch, it would be $6. Neither number includes official fallbacks, new acquisition or discovery, and neither is a verified charge or reliability claim. The minimum payment is $5, distinct from consumption. The 100-unit free trial needs no payment; do not subscribe or top up automatically.

## Safe capture and accounting

`npm run test:x-batch-provider` freezes an external plan and official-source baseline with a checksum. It selects a mixed sample of images, video, long text, galleries and reply dependencies, plus up to five existing officially confirmed removal controls. Two planned requests capture a small control batch and up to 200 IDs. The exact raw responses are written outside Git before identity validation, so a parser repair can reuse them offline.

`--fetch` requires `TWEETAPI_KEY` in an external environment file and the **existing** `PROMPIX_X_SPEND_DIR`/`PROMPIX_X_MONTHLY_USD` configuration. Every call reserves 500 micro-dollars at PAYG value in the shared ledger even when funded by free credits. One batch is one unit, not 200 units. Failed, malformed and uncertain requests retain their cost; the pilot does not infer refunds from a vendor's policy. No automatic HTTP retries or credential-bearing redirects are allowed. Existing reservations without captured responses block replay. `--replay /external/root/2026-10-17` is offline only.

The new `tweetapi` ledger provider must be deployed to every collector reader **before** the first live trial. Older runtimes reject the new provider rather than silently omit its spend. After trial entries exist, rollback must retain the updated ledger reader; never erase or relabel trial entries to make an old binary accept them. Production provider flags remain unchanged. No source freshness, review, removal or publication state is written by this command.

## Evidence required before enabling maintenance

Capturing 200 objects is insufficient. The report deliberately keeps `productionSwitchAllowed: false` and `sourceFidelityVerified: false` until separately verified:

- Compare full text including long posts, exact numeric authors/timestamps, current attribution, full galleries/video variants and all reply relationships against official baselines. Changed/stale baselines need a bounded current comparison; they are not automatic provider failures.
- Run the actual extractor and strict revision comparator. Added or missing media and incomplete link entities remain unresolved; matching a subset must not extend freshness.
- Check the known unavailable controls. Missing IDs are unknown and need the existing authoritative confirmation path; they do not directly delete a record.
- Reconcile small and large-batch calls with dashboard usage. Trial credits are not evidence of ongoing cost, and pricing arithmetic is not an uptime measurement.
- Test multiple runs, failure/restart handling, production-state replay, shared caps and rollback before switching. Keep new-source acquisition provenance and all review gates intact.

The existing TwitterAPI.io discovery, official supplement and maintenance remain active. Historical publication continues under its own existing review limits. No registration handoff is pending.

## Candidate screening after stopping TweetAPI

Public contracts checked on 2026-10-17; these are preflight estimates, not live provider acceptance. The comparison workload is 10,000 X posts checked twice daily for 30 days, excluding discovery, acquisition, profiles and authoritative fallback. A batch endpoint can reduce round trips without reducing per-post billing.

| Candidate | Documented charge or minimum | Decision within the existing $20 total collection budget |
|---|---|---|
| [TwitterAPI.io](https://twitterapi.io/pricing/details) | $0.00015/returned post; about $90 for the comparison workload | Keep the verified route for current inventory; does not solve large-library cost |
| [SocialData](https://docs.socialdata.tools/getting-started/pricing/) | $0.0002/returned tweet; about $120 | More expensive despite [100-ID batches](https://docs.socialdata.tools/reference/get-multiple-tweets/) |
| [Desearch](https://www.desearch.ai/pricing) | $0.15/1,000 X posts; about $90 | No demonstrated maintenance saving |
| [Sorsa](https://api.sorsa.io/pricing) | Flat calls with up to 100 IDs, but minimum $49/month | Minimum subscription exceeds the entire budget |
| [TwexAPI](https://twexapi.io/pricing) | Typical reads billed per item; recurring plans start at $50/month; the $20 one-time pack lasts one day | Neither the recurring minimum nor expiring pack solves this budget |
| [Pinlyx](https://pinlyx.com/pricing) | Data API free tier is 100 requests/30 days; paid minimum $69/month | Its [100-ID endpoint](https://pinlyx.com/data-api/reference/x-tweets-batch) does not make the paid minimum affordable; daily rate limits are not included monthly allowance |

None of these alternatives has been registered, funded or enabled as a result of this screening. No replacement is currently validated within budget. The incomplete Google consent flow was observed to stall before a callback; its exact cause is unconfirmed, so it is not evidence that TweetAPI's data API is fraudulent or unavailable. Registration trouble is sufficient to stop this trial without making that unsupported claim.
