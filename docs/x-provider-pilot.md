# X provider pilot and maintenance costs

Status: live pilot completed on 2026-10-17; a full production switch did **not** pass the discovery coverage gate. Production still uses the official X API. The maintenance optimization is independently deployable after CI. The pilot does not publish, translate, mirror media, or change the discovery query mix.

## Scope and cost boundary

The pilot keeps the ten existing discovery topics, adds July and August 2026 historical queries, and takes up to two pages per query. A round-robin sample selects up to 45 known post IDs across video, website, reply chains, long text, galleries, images and text. Every selected thread includes all its required source IDs. Missing categories are coverage gaps, not passing cases.

The [October 12 price schedule](https://twitterapi.io/pricing/details) lists $0.00015 per returned tweet, including a one-tweet minimum for empty requests. The [search endpoint](https://docs.twitterapi.io/api-reference/endpoint/tweet_advanced_search) returns up to 20 tweets per page; [ID lookup](https://docs.twitterapi.io/api-reference/endpoint/get_tweet_by_ids) accepts up to 50 IDs. With 45 IDs and 24 search pages, the first complete pilot reserves at most $0.07875. Prices and account credit availability must be checked before a live run. Headline subscription discounts are not assumed.

`XSpendBudget` persists integer micro-dollar reservations before network access, shares a monthly file and mutex across client instances, and counts empty calls and uncertain failures. The monthly configuration cannot exceed $20; this pilot also sets a $0.25 daily guard. Settlement counts returned tweets before filtering bad source objects. A crash, timeout, HTTP error, malformed body or uncertain settlement retains its reservation. A stale mutex or corrupt ledger blocks new reads and requires inspection; it is not silently cleared.

**The official collector can now use the same ledger.** Set `PROMPIX_X_MONTHLY_USD` in the external X environment only after importing already-incurred account spend. The value must be positive and at most 20; `PROMPIX_X_DAILY_USD` is optional and defaults to that monthly ceiling. `PROMPIX_X_SPEND_DIR` selects the shared directory for discovery, explicit post lookup, source availability checks, author profile lookup and third-party trials. The calendar month and day use UTC, not the vendor billing-cycle reset date. Existing request-count limits continue to apply.

The guard is explicitly enabled at deployment so a fresh ledger cannot silently omit existing account charges. Reservations precede every official HTTP request, count primary returned resources (not author expansions), and retain an upper bound for errors without a reliable count. Same-day vendor deduplication is a soft guarantee and does not reduce local reservations. Explicit official withdrawal responses still reach the availability parser even when their cost is conservatively reserved. Exceeding the cap stops a read before network access; it does not trigger an unbudgeted fallback. Normal ingestion failure monitoring remains active.

This controls code paths that load the configured environment and share this directory, not unrelated apps or ad hoc requests made with the same API key. The pilot's cheap unit cost and this safety cap do not prove that the unchanged official collection can sustain its desired volume for $10–20/month. If the cap is reached, paid X reads stop until budget is available; source freshness gates remain in force. Production activation is recorded in external runtime evidence.

## Run and inspect

Keep `TWITTERAPI_IO_KEY` only in an external `~/.config/prompix/*.env` file. Do not paste the key into a command, commit it, or put it in a report.

```sh
npm run test:x-provider
# Explicitly load the external credential into the environment before this command:
npm run test:x-provider -- --fetch
# Reparse captured responses without credentials or network access:
npm run test:x-provider -- --replay /absolute/external/UTC-day/plan-hash
```

Without `--fetch`, the command only reads cached sources and writes a plan. Output defaults to `~/.local/share/prompix/x-pilot/<UTC day>/<plan hash>/`; `PROMPIX_X_PILOT_DIR` may select another external directory. The command rejects output inside the checkout or production content root. `PROMPIX_X_SPEND_DIR` selects the shared external ledger, defaulting to `~/.local/share/prompix/x-spend/`.

A paid run pins that day's active plan. Changing the inputs cannot silently replace it or start another paid plan. Completed requests are reparsed from saved raw responses; unresolved attempts stop. New paid runs freeze their comparison candidates and excerpt reviews outside Git. Legacy replay explicitly labels its baseline as the current revision of the original sample, rather than claiming the baseline was frozen before acquisition. Raw successful JSON is saved before parsing, so parser repairs can replay evidence offline. There are no automatic paid retries or fallback requests. Raw source data stays outside Git.

The report compares original text, numeric author identities, source timestamps, reply parents and expected image/video URLs against the stored official-source baseline. Differences remain unresolved: an edited source or stale baseline needs investigation, not automatic rejection of either provider. It also runs the existing standalone and thread extractors and compares prompt, kind and model. Search audits flag out-of-window dates, excluded replies/quotes/retweets and missing requested media. Free-tier calls wait 6.5 seconds after the previous response completes; Retry-After values are honored up to 24 hours without automatic retries. The report always records `productionSwitchAllowed: false`; it is diagnostic evidence, not a deployment authorization.

## Production maintenance improvements

The existing official checker now:

- Excludes moderated, quality-held and exact-revision rejected/deferred candidates with no previous approval. Prior approvals continue to be checked because they may back a retained published edition.
- Reuses a complete standalone discovery response younger than 12 hours as a source check. It records the original check time; it does not reset the timestamp to the current run. Posts participating in reply chains still require joint lookups so a partial refresh can invalidate older dependent approvals.
- Never lets an older discovery snapshot override a newer withheld check, or revive a persistent removal.
- Prioritizes approved content and then the oldest effective successful check, instead of repeatedly favoring the original discovery timestamp.

The 12-hour recheck target, 24-hour publication freshness gate, full thread dependency checks and durable daily request limits remain. The new report counters are `skippedInactive` and `reusedDiscovery`. Changed source revisions can re-enter review. This reduces redundant work without treating a failed API call as deletion evidence.

## Required evidence before a switch

1. Real lookup and search responses must preserve full source bodies, authors, image galleries, video variants and reply chains. Compare against a bounded same-window official sample when cached sources differ; synthetic fixtures do not establish fidelity.
2. Validate pagination and query operators on real results. Increase HTTP page allowances to preserve the existing candidate volume when moving from 50 to 20 results/page; use provider-specific cursor identities.
3. Test multiple runs, historical coverage, empty results, rate limits, timeout recovery and budget stops. A single successful response does not establish reliability.
4. Resolve missing/deleted/private/edited sources separately. TwitterAPI.io may omit unavailable IDs or return an empty-ID placeholder; omission is unknown, never proof of deletion. A small, explicitly budgeted official confirmation path or verified compliance capability is still needed. Official batch-compliance access and price are unconfirmed.
5. Record third-party acquisition provenance and the applicable display basis. Do not label third-party responses `X-API-Terms` or write them into official discovery snapshots. [Vendor terms](https://twitterapi.io/terms) do not by themselves establish a license to republish every returned post.
6. Bind all paid read paths to the shared budget, reconcile balances, and run the existing editorial/media/publication regression checks. Keep the visual source mix and review standards unchanged.

## Validation

Automated tests cover budget persistence, concurrent reservation, monthly boundaries, opening spend, empty-result billing, key redaction, redirect/HTTP/JSON failures, long text and media normalization, ambiguous omissions, immutable source comparisons, maintenance prioritization, rejection skipping, fresh-source reuse and withdrawal protection. Live lookup fidelity and trial billing were checked as described below; search equivalence failed its initial gate.

Local validation on 2026-10-17: type checking passed; the full TypeScript suite passed 560 tests with one explicitly opt-in 10,000-item SQL acceptance test skipped. After the final UTC query conversion, all 17 provider/pilot tests passed. The scheduler safety suite passed 13 tests. Final CI results are attached to PR #121; runtime activation evidence is kept in the external pilot directory. No mobile build is required for these ingestion-only changes.

## Live evidence, 2026-10-17

Registration succeeded with 100,000 bonus credits ($1), no recharge and no subscription. The first 25 successful requests consumed exactly 7,875 credits ($0.07875), independently confirmed in the account dashboard. A failed local TLS handshake and one HTTP 429 retained conservative reservations in the local ledger; neither appeared as a charged call in that dashboard observation. TLS was fixed with the existing host CA bundle, without disabling certificate verification.

- **Known-source lookup:** all 45 requested posts were returned, covering 39 library candidates (18 images, 12 videos, 9 texts, including reply chains and galleries). Full source text, numeric author, timestamp, reply parent and media identity matched 39/39; the real extractor reproduced prompt, kind and model for 39/39. There was no existing website candidate in this sample, so this is not website extraction coverage.
- **Video identity:** 12 videos used equivalent X CDN hosts or a non-content `tag` parameter. The adapter canonicalizes only exact HTTPS X video hosts and MP4 paths. Two pairs of 64 KiB range responses had identical bytes, total lengths and content ranges; this is not a full-file checksum comparison of all videos.
- **Discovery:** 24 pages across the existing ten topics and two historical queries returned 480 posts without within-query page duplicates. Populated responses alone did not pass fidelity: seven current-query records violated a requested media/exclusion condition, and 29 historical records exceeded the requested month boundary.
- **Historical repair:** exact `since_time` / `until_time` UTC seconds, as documented by the vendor, returned 80/80 posts inside July/August on a separate four-page rerun. Date-only query inputs now translate to those exact boundaries. These results establish bounded historical retrieval, not complete archive coverage.
- **Same-window comparison:** both providers queried the same 2026-10-16 22:00 to 2026-10-17 04:30 UTC window with equivalent topics. The first image pages overlapped 11/20 official results; video 15/20; website 2/4. The third-party pages included older results while omitting newer official results, including complete visual prompts. This is a small diagnostic sample, not a global recall estimate.
- **Gap investigation:** all 15 distinct omitted IDs were readable by third-party ID lookup. Removing the quote/reply/retweet exclusions did not recover those IDs in the first image/video pages. Thus a successful lookup is insufficient evidence of search equivalence. No production cutover is allowed on this evidence.

The full experiment used 702 third-party tweet results across 35 successful calls. The final dashboard confirmed 10,530 consumed credits ($0.10530), 89,470 bonus credits remaining and zero recharge. The 44 official comparison results reserve $0.22 locally; the refreshed official dashboard rose from $14.43 to $14.56 (a $0.13 observed increase). Keep the conservative local reservation rather than assume billing timing or deduplication behavior. Raw results, query plans, extraction reports and range checks remain outside Git under `~/.local/share/prompix/x-pilot/2026-10-17/`. The $14.43 official billing-cycle spend observed before comparison was conservatively imported as opening spend in the pilot ledger. These pilot-era production reads were independent; reconcile that opening balance again when enabling the new shared production guard.

The next architecture candidate is third-party discovery/known-ID reads with a bounded official validation and discovery supplement, explicit acquisition provenance and the shared dollar ledger. The combined provider routing is a candidate, not an implemented or validated $10–20/month service. The current official production collection cannot be claimed to fit that target merely because the trial API is cheap.

## Shared-budget regression

The production guard adds transport-level tests for every official read path, mixed-provider spend, imported opening balances, pre-network budget rejection, transport/HTTP/ambiguous failures, valid empty results, conservative duplicate-read accounting and explicit withdrawal evidence. Local validation: all 567 TypeScript tests passed, with the opt-in 10,000-item SQL acceptance test skipped; type checking passed. Enabling the external environment and verifying the deployed runtime remain separate from these tests.
