# Hybrid X source maintenance

The first production-ready routing change is limited to **verification of existing standalone sources**. Discovery and new-source acquisition remain official. This is not a claim that the entire X pipeline already meets $10–20/month; the official search workload still needs its own validated replacement.

## Routing and evidence

`PROMPIX_X_RECHECK_PROVIDER=twitterapi` opts in; absent or `official` preserves the original route. A shared dollar budget and an external `TWITTERAPI_IO_KEY` are mandatory. The scheduler loads `~/.config/prompix/twitterapi.env`; secrets stay outside the repository.

A due standalone source is reparsed through the actual intake extractor. The verifier compares the exact publishable source revision, full original text, author ID, source date, prompt, model, complete published media list, current handle, display name, profile link and avatar. Only X MP4 CDN aliases and the non-content `tag` parameter are canonicalized. An added photo is a change, not an ignored extra. Quoted/reposted/reply relationships do not qualify for this standalone path.

A complete match refreshes availability for the **original official acquisition and exact editorial revision**, with `checkedBy: twitterapi` in the availability record. Raw third-party evidence stays in `x-rechecks/responses/`; it never enters `x-discovery`, changes the acquisition license, or creates a publishable candidate. The original acquisition files are unchanged. No new content is approved by this checker.

Missing or changed records are immediately withheld pending an official lookup. Third-party omission never means deletion. Only an explicit, fully accounted official unavailable response can persist removal. If the official budget is exhausted or the read fails, the unresolved item stays withheld. Existing reply chains, including standalone posts used by those chains, remain on joint official checks to preserve dependency invalidation.

The original 12-hour check target and 24-hour publication expiry remain. A failed third-party request cannot extend freshness. The request ledger is reserved before HTTP, blocks interrupted/failed attempts for the rest of the UTC day and does not automatically replay a paid request. A successful earlier batch remains usable if a later batch fails. Missing/changed fallbacks and transport-failure fallbacks remain subject to both the existing official daily request limit and the shared dollar ledger; no read bypasses the budget. The monitor sees nested failed reports even if cached content can still publish.

Third-party maintenance allows 50 IDs/request and defaults to 16 requests/day (hard configurable bound 40). It waits 6.5 seconds before every call, including the first call in a new invocation, for the free account's 0.2 QPS. No subscription is needed to test. Raising this allowance never raises the independent shared dollar cap.

## Real evidence on October 17, 2026

A frozen baseline contained 316 candidates and 322 distinct original/dependency posts. Seven third-party requests returned 318 usable posts and cost $0.04830, confirmed by the dashboard. All 322 raw response entries were billable, including four unavailable placeholders; counting only usable posts would understate the cost. One response needed an offline parser repair for shared-video HLS aliases; its raw capture was reused with no paid retry. The published MP4 identities matched.

- Source comparison and the real extractor matched 312/316 candidates.
- The stricter production standalone gate matched **306/310** eligible candidates, including attribution and complete selected media. The remaining four IDs were missing, not source-body mismatches. Six reply candidates remain on official verification.
- Official lookup returned **one of the four omitted IDs**; three were explicitly unavailable. This is concrete evidence that third-party omission must not trigger deletion.
- An isolated production-state replay skipped 49 inactive candidates, checked 262 eligible standalone sources in six mocked reads, accepted 258 unchanged sources and withheld four pending official confirmation. All reply chains remained for official checks. Repeating the same run made zero third-party requests. The production source/state files were unchanged; this replay made zero network calls and used an explicitly simulated future due time.

These are bounded fidelity and routing tests, not proof of long-term provider reliability or complete search recall. Synthetic regression tests cover edits, truncation, added/removed gallery media, identity/name/avatar changes, missing IDs, explicit official withdrawal, old-revision invalidation, source provenance, 24-hour expiry, request limits, failed-run persistence and reply dependency routing.

Local validation: type checking passed; 578 TypeScript tests passed with one opt-in 10,000-item SQL test skipped; all 13 scheduler tests passed. CI and production activation are recorded separately in the PR and external runtime acceptance files.

## Spend and remaining work

The X console was changed from unlimited spend to a **$20 billing-cycle cap**, with automatic recharge still off. The collector's combined-provider ledger uses UTC calendar months, so these are separate safeguards rather than identical counters. The observed official balance was $5.44 with $14.56 spent in the current billing cycle. No recharge or subscription was purchased. The third-party dashboard confirmed 45 calls, 15,555 credits consumed ($0.15555), 84,445 bonus credits remaining (about $0.84445), and zero recharge credits.

Do not subscribe to TwitterAPI.io Starter merely to remove trial throttling: the listed $29/month already exceeds the user's total target. The vendor says a one-time paid top-up also increases the free account rate limit to 20 QPS. Continue using the trial balance until the validated workload requires a small pay-as-you-go top-up; confirm the current checkout minimum before requesting payment. See [plans](https://twitterapi.io/subscribe) and [per-result rates](https://twitterapi.io/pricing/details).

The cheap recheck rate does not make a 10,000-item full-body scan free: two scans/day would cost about $90/month at $0.00015/returned post before discovery. An official batch-compliance pilot was created and five IDs uploaded successfully. At documentation time it was still processing. Read/create/upload access is confirmed; completed output, actual price and suitability for production are not. See the [official integration contract](https://docs.x.com/x-api/compliance/batch-compliance/integrate). Do not mark an unfinished job as a clean scan or infer that the feature is free.

Search still has unresolved third-party coverage gaps. The next gate is discovery through third-party leads plus a bounded official supplement and official acquisition of selected candidates, measured against quality/yield rather than merely counting nonempty pages. Neither reduced X coverage nor weaker editorial/preview review is accepted as a cost optimization.

## Draft admission and authoritative publication history

The database-backed daily route now limits checks of never-approved drafts to the remaining editorial window capacity (up to three candidates per remaining request). Fresh official discoveries occupy that same queue without a duplicate paid read. An exhausted or failed editorial ledger admits no additional draft rechecks. Attempted candidate identities remain spent for their UTC day.

Any previously published X identity, existing editorial approval, or cached approval stays outside this draft limit. Publication history comes from `prompix.content.first_published_at`, including inactive and removed identities; merely staged rows do not count. Missing database history or malformed editorial state stops the optimized route before X calls instead of silently treating the published set as empty. Legacy publishers retain conservative maintenance. Explicit moderation and quality holds still take precedence, and the original 12-hour checks, 24-hour expiry, fallback behavior and shared spend ledger remain unchanged.

With the October 17 production snapshot and exhausted editorial slots, an isolated future-due replay reduced standalone checks from 288 to 237, excluding 51 never-published unreviewed drafts. Every published standalone check was preserved. The replay used mocked provider reads and one read-only database history query: it is routing evidence, not a fresh availability or provider-fidelity check. Two complete checks per day would save about $0.459 per 30 days at the current per-result rate. This does **not** solve the approximately $90/month cost of twice-daily checking 10,000 published X originals.

The earlier users compliance pilot also completed with an empty result despite its officially confirmed suspended-account negative control. Both existing compliance pilots are complete and unsuitable as maintenance replacements; do not create or poll duplicates. The [official edit-post documentation](https://help.x.com/en/using-x/edit-post) limits ordinary text/media edits to one hour after posting, but deletion, account protection/suspension, withholding and attribution changes still require an independently verified route. An edit window alone is not permission to extend source freshness.

Validation for draft admission: 627 TypeScript tests passed, two optional tests skipped, including real SQL publication-history checks, unpublished backlog limits, fresh-discovery reuse, failed ledger preservation and continued withdrawal checks after missing/rejected reviews. CI and runtime activation remain independent deployment gates.

After collection, newly acquired standalone originals now contribute their exact captured source check before editorial filtering. Previously, availability ran before collection and the new original waited until the following scheduled run. Adoption makes no API call, never advances the captured timestamp, never grants editorial approval, and rejects digest mismatches, persistent removals, newer withheld checks, stale/future captures and posts involved in reply dependencies. Threads continue to require a joint lookup.

## Preserve maintenance headroom before growth

`PROMPIX_X_MAINTENANCE_RESERVE=1` adds an opt-in protection inside the existing shared dollar budget. Daily collection takes a complete census from intake, authoritative publication history and previous approvals before checking sources. Removed/held sources are excluded. Missing protected intake or missing database history makes the census incomplete: new search, original acquisition and provider trials stop before HTTP. Verified maintenance lookups can continue within the original hard cap. Reply dependencies, including standalone roots used by unapproved threads, are priced on the official route.

A separate `maintenance-reserve.json` stores only counts, timestamp, completeness and a source-set hash; the spend ledger format and all previous charges remain unchanged. A census must be complete, nonfuture and less than 24 hours old to admit growth. Nominal headroom is two full scans per day through the end of the UTC month, retaining the entire current day's allowance even after a scan. Both the daily and monthly headroom must remain after a proposed growth reservation. Only official/TwitterAPI.io source lookups for already published or previously approved identities can use that headroom; drafts run in separate, lower-priority batches. Searches, profile reads and unverified provider pilots cannot claim maintenance purpose.

An `XBudgetExceeded` refusal occurs before the provider request and removes only that just-created, unsent local attempt. It does not poison later maintenance or consume a request allowance. Paid, failed and uncertain requests remain recorded and retain the existing retry restrictions. No freshness, publication, visual review or translation limit is relaxed.

The October 17 12:47 UTC read-only census found **256 standalone and 10 official original/dependency identities** with no missing protected sources. The resulting nominal reserve was **$0.1768/day and $2.652 for the remaining 15 days**. Shared accounted spend was **$16.03915**, leaving approximately **$1.30885 for growth** under the $20 calendar-month cap. The audit sent no vendor requests and verified that the spend ledger remained byte-identical.

This is budget allocation, not a lower unit price or a guarantee against every outage. Unexpected official fallbacks and newly approved sources can increase demand; the census refreshes at the start of each collection. At 10,000 X originals the current per-result maintenance price still exceeds the total budget. Do not weaken checks, buy another subscription or raise the cap to make the forecast fit.

Activation requires passing regression tests and CI, a complete real census and the normal versioned-runtime deployment. Set the external switch only after installing the supporting runtime. Rollback: disable the switch and restore the preceding runtime; keep both the original spend ledger and all request evidence. Disabling protection does not increase the independent $20 hard cap.
