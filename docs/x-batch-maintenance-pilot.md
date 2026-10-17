# Batch-priced X maintenance pilot

2026-10-17. **The user has stopped TweetAPI after repeated registration problems. Do not resume its signup or request payment.** The isolated **TweetAPI (`tweetapi.com`)** pilot remains dormant with zero vendor API calls. It is a different service from the production **TwitterAPI.io** route and from the newly approved **Twttr API / RapidAPI `twitter241`** pilot below. No pilot enables production maintenance or new-source acquisition.

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

The existing TwitterAPI.io discovery, official supplement and maintenance remain active. Historical publication continues under its own existing review limits. No TweetAPI registration handoff is pending.

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

## Twttr API / RapidAPI first-month pilot

The rendered [twitter241 pricing page](https://rapidapi.com/davethebeast/api/twitter241/pricing), checked on 2026-10-17, lists Basic at $1/month with 1,000 requests per billing cycle (hard request limit), 10,240 MB included bandwidth and $0.001/MB bandwidth overage. Pro costs $25/month and is outside the approved total budget. The user explicitly approved **only the first $1 month and at most eight trial requests**, within the existing $20 shared cap. The user completed payment; the account's transaction history shows Completed, Basic, $1 at 23:38 JST on October17. The existing reserved fee was confirmed without creating another fee. [RapidAPI's cancellation documentation](https://docs.rapidapi.com/v2/docs/api-pricing) says unsubscribe cuts access immediately and resubscription charges again. Keep access for the planned trial, then cancel within the paid month unless continuation is separately authorized; no renewal or Pro upgrade is authorized.

The public [Get Tweets Details By IDs](https://rapidapi.com/davethebeast/api/twitter241/playground/Get%20Tweets%20Details%20By%20IDs) example uses `GET /tweet-by-ids?tweetIds=...`, `x-rapidapi-key` and `x-rapidapi-host`. It shows four IDs and `result.tweetResult[].result`, including a long-text `note_tweet` example. **It does not establish a maximum batch size.** The first live 200-ID request succeeded; 200 remains our experiment bound, not a documented vendor maximum or a repeated reliability result.

The separate CLI reuses the frozen 197-ID official baseline and three existing negative controls without buying those originals again. It freezes six named requests: controls (8 IDs), 50, 100, 200, then two 200-ID repeats at least 12 and 24 hours after receipt confirmation. Missing positives, unexpectedly returned negative controls, malformed results, failed smaller batches or depleted reported quota stop expansion. Such differences require investigation of both baseline age and provider behavior; they do not establish current deletion or stale data by themselves.

```sh
# Existing private directory containing preflight-plan.json; never inside Git/content.
npm run test:x-rapidapi-provider -- /external/pilot prepare
# Only after every runtime ledger reader supports rapidapi and subscription:
npm run test:x-rapidapi-provider -- /external/pilot reserve-fee
# Verify actual checkout/receipt is $1; stop on any additional charge.
# Run the next command only after payment has actually been verified:
npm run test:x-rapidapi-provider -- /external/pilot confirm-fee
npm run test:x-rapidapi-provider -- /external/pilot fetch controls
npm run test:x-rapidapi-provider -- /external/pilot replay controls
```

Load `RAPIDAPI_KEY` only from the private environment alongside the existing shared spend configuration. `reserve-fee` records the **whole $1** before checkout, without paying; it recovers the same reservation after interruption and cannot reserve a second fee for a different plan in that UTC month. Unpaid/uncertain fees stay reserved until reconciled with external evidence, never silently refunded. `confirm-fee` is an operator receipt confirmation, not payment automation. Any tax or changed checkout total must be reconciled before proceeding; the current pilot only accounts for the approved $1.

Included lookups have zero additional per-call dollar cost but each attempt gets a shared-ledger entry. All eight attempts count, including reserved/uncertain failures; restart and midnight cannot reset the allowance. A completed fee in the same UTC month, less than 72 hours old, is required. This intentionally narrow trial window is not a production subscription-cycle implementation. Budget and protected maintenance runway still apply; the candidate cannot claim verified-maintenance headroom.

The directory lock, immutable plan/attempts, raw response digest and saved quota headers support offline recovery. A capture is saved before parsing; an attempt without a capture cannot retry. Re-running a captured request does not perform HTTP. Requests have a 60-second timeout, manual redirects, 16 MB success/64 KB error response limits and no automatic retry. Reports explicitly retain `sourceFidelityVerified: false` and `productionSwitchAllowed: false`. No candidate, source freshness, removal, review or publication files are changed.

**Deploy reader support before reserving the fee.** Old runtimes reject the new provider/operation. After ledger entries exist, a rollback must retain the updated reader; preserve every entry rather than rewriting history to fit old code. The pilot is absent from production provider routing. Local tests cover fixed-fee protection, idempotent reservation/confirmation, eight-call accounting, expiration, negative controls, expansion stops, failed/crashed runs, modified captures and offline replay. Synthetic 200-ID success does not establish actual vendor capacity; the source-fidelity and dashboard-reconciliation gates above still apply.

Even if 200 IDs/call works, 10,000 X sources checked twice daily for 30 days require **3,000 calls**, above Basic's 1,000. At that hypothetical batch size Basic covers at most 3,200 X sources at the same schedule before other calls. A mixed-source library has a different X population; price feasibility must use that actual population and authoritative fallbacks. The large-library budget problem is not yet solved.

## First live capture and source audit — October17

Four actual requests at 14:43–14:48 UTC covered 8,50,100 and200 IDs. All returned each expected positive ID and three unavailable placeholders. Headers decremented from999 to996 remaining; the account's Subscriptions & Usage page independently showed0.4% of1,000 calls used. The subscription is $1 with zero additional per-call cash cost for these four calls. Shared monthly accounting was $17.03915 after the four calls, then $17.04915 after the separate $0.01 official author verification, including earlier uncertain charges. The100-ID call encountered an omitted nested `__typename` inside `TweetWithVisibilityResults`; its raw response was already captured. A narrow parser repair recovered it offline, with the original uncertain ledger entry preserved and no duplicate request.

`npm run audit:x-rapidapi-sources -- /external/pilot batch200` verifies the frozen baseline/capture checksums, normalizes source fields offline and invokes the existing extractor and strict standalone revision comparator. This command never changes source freshness, removal state or publication. Known protected/withheld users and unavailable media remain unresolved; missing privacy metadata, conflicting IDs/profiles, incomplete notes/references and malformed media fail closed. Only a known visibility wrapper may omit its nested typename.

| Check against existing official acquisition evidence | Observed result |
|---|---|
| Positive/negative identity controls |197positive IDs returned,3unavailable controls correct |
| Source-body/media and real extraction |190/191content candidates matched |
| Strict standalone publishable revision/current attribution |184/185eligible candidates matched |
| Coverage represented in those candidates |175long-text,64gallery,66video,6reply-thread cases |
| Full cached official media comparison |197source snapshots found;196matched all attachment identities, previews and MP4 variants;319baseline attachments and254MP4 variants total |

The same single author restriction explains every unmatched row: the provider reports `withheld_in_countries: ["IN"]`. A separate $0.01 official user lookup at15:03UTC confirmed `withheld.country_codes: ["IN"]` and `protected: false`. The adapter conservatively withholds that source from matching; this is not global removal or a provider recall error. A temporary operator hold is recorded for the next publication because the current worldwide feed has no regional delivery gate; it preserves personal favorites and does not add a removal tombstone. Six reply-thread cases pass extraction but remain outside the standalone maintenance route. The media audit compared every MP4 variant exposed by the existing official snapshots; it does not prove freshness beyond those snapshots or inspect full videos visually.

Raw captures, frozen media baselines, reports, payment and usage screenshots are private under `~/.local/share/prompix/rapidapi-twitter241-pilot/2026-10-17/`. The full local suite passes666tests with2environment skips; synthetic regression cases cover privacy, authors, long notes, galleries, video variants, references, contradictory objects and mutation rejection. No third-party content is committed.

Production remains unchanged. Planned repeat captures are due no earlier than October18 02:42:55UTC and14:42:55UTC (the saved receipt is authoritative for exact timing). Before enabling the provider, complete those repeats, ensure the official fallback retains author-level restrictions, validate production-state replay and subscription-cycle quotas, protect discovery/maintenance budgets, and retain a tested rollback. First-pass completeness and a cheap batch do not establish ongoing reliability or the whole10,000-item budget.

### Preserve author restrictions through the official fallback

The official reader now requests and retains `user.fields=protected,withheld`, as supported by the [official SDK's user-field contract](https://github.com/xdevplatform/twitter-api-java-sdk/blob/main/docs/UsersApi.md). Restricted authors cannot enter discovery, hydration or the creator cache. Search validates the original counts/cursor before filtering so excluded results do not corrupt pagination. Added fields change the request fingerprint; existing paid daily/monthly limits are preserved.

Maintenance distinguishes explicit resource-not-found from protected/not-authorized or regionally withheld content. The latter is withheld without setting persistent `removed: true`, and a later successful public-source check can restore availability. This does not release existing operator quality holds or reinterpret old removal records. The actual saved official restricted-author response was replayed through an isolated maintenance state: it produced withheld, no deletion marker, and no network request or production mutation. Automated tests cover ordinary public sources, malformed flags, search cursors, strict hydration, hybrid fallback and later recovery.

This closes a fallback correctness gap found during the trial. It does not enable RapidAPI production routing or bypass the delayed repeat/subscription-accounting gates above.

## Subscription-cycle request guard (prepared, not activated)

The shared `XSpendBudget` now supports an explicitly reconciled Basic cycle independently of its UTC cash month. `reconcileRapidAPICycle` requires the original completed $1 fee, exact receipt interval, an explicit authorized stop time no later than expiry, and the fixed 1,000-request limit. It performs no HTTP, purchase, renewal or provider switch. No production cycle is configured by installing this code, and the pilot keeps its eight-call/72-hour limit.

The separate `rapidapi-cycle.json` stores immutable receipt bounds and a usage high-water mark anchored to the original cash-ledger attempt IDs. `reserveRapidAPICycleLookup` counts all RapidAPI lookups since that fee reservation across affected calendar ledgers, including the four real trial attempts, pending and uncertain outcomes. One 200-ID batch consumes one request. It reserves in the existing cash ledger under the same exclusive lock before a future adapter could send HTTP; cash accounting remains schema version1. A new calendar month, process restart, lower dashboard count, empty response or failed settlement cannot restore credits. Missing anchored attempts, malformed ledgers, an unconfirmed fee, expiry and backwards observation clocks stop admission.

Dashboard reconciliation must happen while provider callers are idle. A higher observed count accounts conservatively for calls outside the collector; a lower count never refunds local attempts. Calls from other tools should remain disabled after reconciliation, because a local guard cannot see simultaneous external usage until another observation. It does not infer a new cycle from quota headers or automatically buy overages. Request reservation and HTTP response handling in the future production adapter remain a separate integration gate.

Growth lookups also need a complete census younger than24hours and must leave two full scans/day, at200 standalone IDs/batch, through the authorized stop date. Published-source maintenance may consume that reserve but cannot exceed the hard1,000 requests or the existing shared dollar cap. The cash reserve still conservatively prices the currently active TwitterAPI.io route; this patch does not claim the lower maintenance price is already in production. Official dependency/fallback reads remain subject to their cash budget.

Automated cases cover cross-month restart/late settlement, concurrent last-credit use, uncertain attempts, external usage reconciliation, expiry, immutable terms, malformed state, request/cash headroom and the unchanged official/TwitterAPI.io fallback. The delayed real captures, production adapter, source-state replay and controlled cutover are still required. On a later routing rollback, retain cycle state and all cash entries; disable the candidate route before restoring a runtime without cycle support. Installation alone requires no state migration and leaves current collection unchanged.
