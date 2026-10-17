# X provider pilot and maintenance costs

Status: implementation and local tests only. Production still uses the official X API. TwitterAPI.io registration and live comparisons must complete before any provider switch. The pilot does not publish, translate, mirror media, or change the discovery query mix.

## Scope and cost boundary

The pilot keeps the ten existing discovery topics, adds July and August 2026 historical queries, and takes up to two pages per query. A round-robin sample selects up to 45 known post IDs across video, website, reply chains, long text, galleries, images and text. Every selected thread includes all its required source IDs. Missing categories are coverage gaps, not passing cases.

The [October 12 price schedule](https://twitterapi.io/pricing/details) lists $0.00015 per returned tweet, including a one-tweet minimum for empty requests. The [search endpoint](https://docs.twitterapi.io/api-reference/endpoint/tweet_advanced_search) returns up to 20 tweets per page; [ID lookup](https://docs.twitterapi.io/api-reference/endpoint/get_tweet_by_ids) accepts up to 50 IDs. With 45 IDs and 24 search pages, the first complete pilot reserves at most $0.07875. Prices and account credit availability must be checked before a live run. Headline subscription discounts are not assumed.

`XSpendBudget` persists integer micro-dollar reservations before network access, shares a monthly file and mutex across client instances, and counts empty calls and uncertain failures. The monthly configuration cannot exceed $20; this pilot also sets a $0.25 daily guard. Settlement counts returned tweets before filtering bad source objects. A crash, timeout, HTTP error, malformed body or uncertain settlement retains its reservation. A stale mutex or corrupt ledger blocks new reads and requires inspection; it is not silently cleared.

**The ledger is connected to the pilot only at this stage.** It does not yet cap the existing official production jobs or other services. Before switching, every official fallback, discovery read, source check and profile lookup must use the same ledger, with already-incurred account spend imported and independently reconciled. Neither local tests nor the pilot's small cap prove the entire account is under its monthly budget.

## Run and inspect

Keep `TWITTERAPI_IO_KEY` only in an external `~/.config/prompix/*.env` file. Do not paste the key into a command, commit it, or put it in a report.

```sh
npm run test:x-provider
# Explicitly load the external credential into the environment before this command:
npm run test:x-provider -- --fetch
```

Without `--fetch`, the command only reads cached sources and writes a plan. Output defaults to `~/.local/share/prompix/x-pilot/<UTC day>/<plan hash>/`; `PROMPIX_X_PILOT_DIR` may select another external directory. The command rejects output inside the checkout or production content root. `PROMPIX_X_SPEND_DIR` selects the shared external ledger, defaulting to `~/.local/share/prompix/x-spend/`.

A paid run pins that day's active plan. Changing the inputs cannot silently replace it or start another paid plan. Completed requests are reused; unresolved attempts stop. Raw successful JSON is saved before parsing, so parser repairs can replay evidence offline. There are no automatic paid retries or fallback requests. Raw source data stays outside Git.

The report compares original text, numeric author identities, source timestamps, reply parents and expected image/video URLs against the stored official-source baseline. Differences remain unresolved: an edited source or stale baseline needs investigation, not automatic rejection of either provider. The initial normalized media/long-text shapes remain provisional until actual responses confirm them. The report always records `productionSwitchAllowed: false`; it is diagnostic evidence, not a deployment authorization.

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

Automated tests cover budget persistence, concurrent reservation, monthly boundaries, opening spend, empty-result billing, key redaction, redirect/HTTP/JSON failures, long text and media normalization, ambiguous omissions, immutable source comparisons, maintenance prioritization, rejection skipping, fresh-source reuse and withdrawal protection. Live provider fidelity and account billing remain unverified until registration completes.

Local validation on 2026-10-17: type checking passed; the full TypeScript suite passed 554 tests with one explicitly opt-in 10,000-item SQL acceptance test skipped. The scheduler safety suite passed 13 tests and the bundled first-party catalog validated. Budget/counter validation was rerun after final ledger hardening. No paid live provider request, production deployment, or mobile build is claimed by these results.
