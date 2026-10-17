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
