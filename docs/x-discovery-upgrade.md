# X discovery routing and staged backfill

Updated 2026-10-17. This document separates implemented routes, measured evidence, and remaining release gates. The user's target is a $10–20 monthly collection budget, stable X supply, unchanged quality, and staged historical growth toward 10,000 published items.

## Implemented routing

`PROMPIX_X_DISCOVERY_PROVIDER=hybrid` opts the daily collector and normal `collect:x` command into three stages:

1. TwitterAPI.io discovers leads across all ten existing topics and four additional visual recall queries. The additional queries do not require a prompt marker AND a model name to be searchable together. Four lanes rotate per six-hour collection window with a 24-hour overlap and a 15-minute indexing allowance. The first invocation freezes each plan; later invocations resume its exact queries and cursors. Search is a bounded sample, not a claim of exhaustive X coverage.
2. The existing extractor identifies complete prompt, public-reply and allowlisted GitHub Skill leads in memory. Incomplete teasers remain evidence, not publishable drafts. Official lookup acquires selected original bodies before they enter `x-discovery`. Official identity, attribution, editorial, media and publication gates remain authoritative. Third-party acquisition provenance is never relabeled as official.
3. Independent official search remains as a supplement, with half its topic slots assigned to video because the measured search gaps include complete video prompts. The existing public reply recovery can use every third official request. Unknown or unavailable third-party results never cause deletion.

Daily allowances are 40 third-party search calls / at most 800 raw results, 40 newly acquired official IDs, and three ten-result official supplement/reply calls. Allowances are cumulative across four UTC windows, not reset per invocation. Existing official attempts and shared dollar reservations survive migration. Nonvisual leads use at most one fifth of the acquisition allowance; unused slots remain available for later visual leads.

Every HTTP attempt reserves dollars first. A transient read can retry at most twice, retaining prior uncertain charges and reserving each retry. Long Retry-After periods persist across windows and midnight. Interrupted unclassified attempts require inspection; captured valid responses replay without payment. Malformed responses, cursor cycles, edited plans and missing evidence fail closed. An independent official supplement can still run after a third-party failure, within its existing budget.

Set the discovery provider back to `official` to restore the previous discovery route. This does not reset any spend or request ledger. Recheck routing has its separate existing flag. Activation and rollback must use the guarded runtime installer, preserve secrets outside Git, and record the actual runtime and environment diff.

## Historical search

`npm run collect:x-search -- --directory /external/job --start ISO --end ISO` creates a dry-run plan. The default planner partitions an explicitly bounded range into six-hour UTC windows, preserving every original topic and adding recall lanes. A plan covers at most 31 days; separate monthly jobs cover July onward. Source bodies and media metadata stay outside Git.

Resume with `--fetch --max-requests 10`; use `--replay` for offline extraction. Existing plans are immutable. A page cap is reported as incomplete; it never advances a global completeness watermark. All jobs share the same dollar ledger as live collection. This command only stages leads: it cannot publish, lower review standards, or count raw results as library growth.

Prefer weekly history chunks. A checkpoint stops safely at 10,000 recorded attempts, before another paid request; `checkpoint-limit` means split the remaining range into a new bounded plan while retaining the prior evidence and shared spend. It never means the range was exhausted.

The intended gates are: sample historical results and measure actual approval/cost; acquire and review an additional 500 items; verify total 2,000; then continue toward at least 10,000. Deduplication, exact prompt completeness, source permission/attribution, media checks, translations and removals remain required. Normal new-release pacing remains separate from staged historical inventory.

## Live evidence and limitations

Private evidence is under `~/.local/share/prompix/x-discovery/2026-10-17/` and the earlier `x-pilot` / `x-hybrid` directories.

- Exhausting the repeated image, video and website queries did not repair the original omissions: 11/20, 15/20 and 2/4 official sample IDs were found respectively. Dropping model conjunctions and narrowing time ranges did not recover every known missing post. These are sample comparisons, not estimates of worldwide recall.
- Nineteen additional successful search pages returned 158 entries, 145 distinct locally valid results and 27 visual candidate leads, including five public reply leads. Offline replay through the actual search/intake code produced the same counts without another paid request.
- A real isolated hybrid run acquired 20 official draft bodies and ten official supplement results. The extractor produced 20 drafts plus one public reply lead. The fourth third-party request had an uncaptured failure; it was retained and charged conservatively. The run was reported failed, not passed. A bounded recovery and final validation are recorded separately; do not infer activation from this experiment.
- The official batch-compliance pilot completed with HTTP 200 and an empty result for five submitted IDs, including three IDs that an earlier official lookup reported unavailable. It has therefore NOT passed the negative-case gate and cannot yet replace live source-availability checks.

Official references: [TwitterAPI search contract](https://docs.twitterapi.io/api-reference/endpoint/tweet_advanced_search), [X batch compliance](https://docs.x.com/x-api/compliance/batch-compliance/integrate). Provider documentation does not establish complete search recall or a republication license for every returned record.

## Budget and scale gates

At full configured daily discovery allowances, third-party search costs at most $3.60 per 30 days; new official acquisitions at most $6; official supplement/reply reads at most $4.50. Existing roughly 300-source twice-daily third-party maintenance is about $2.70, and six joint official thread checks twice daily about $1.80. The illustrative sum is **$18.60**, excluding additional fallback reads, profiles, experiments and growth. The hard shared $20 monthly cap is authoritative; the estimate is not a guarantee that all allowances can always be used.

The current official account billing cycle and the local UTC calendar-month ledger differ. Earlier official spend was imported conservatively; it is not refunded by migration. Historical jobs must use remaining budget, not a fresh ledger. Existing Codex capacity supplies editorial/visual/translation work; no new token-billed translation route is enabled by this change. Fixed Supabase/other existing subscriptions are separate from incremental collection charges.

A 10,000-source twice-daily full-body check would cost roughly $90/month on the third party alone. Acquiring 10,000 new X originals through official lookup costs at least $50 before discovery/review. Thus rapid all-X backfill and large-library maintenance cannot honestly be promised within $20 until the authoritative change-check route is validated or the acquisition design changes with a supported display basis. Do not weaken deletion handling or hide X supply reductions to make a spreadsheet look cheaper. Stage data and continue solving the scale gate; request any additional budget explicitly, with measured approval yields.

## Continuous execution

The current thread has an hourly follow-up named “Prompix 采集降本与历史补库”. It resumes checkpoints, stays quiet on unchanged state and continues through production validation and backfill. It must not create duplicate paid jobs, reset failure accounting, charge a card, or treat this document as proof of delivery. Current blocking evidence and exact next actions belong in the external acceptance/checkpoint record and this thread.

### Recovery acceptance

The isolated live run was resumed after preserving its original failed checkpoint and recording one explicit operator retry. All earlier request and dollar reservations remained intact. Sixteen further search calls completed; the same plan reached 311 unique valid results and 148 candidate leads. The acquisition stage correctly reused its 20 already-acquired IDs and made zero further official calls because that collection window's allowance was consumed. The official supplement likewise made zero repeated requests. The resumed run reported `ok` / `sampled`, with unfinished pagination retained. This establishes recovery and budget persistence for that run; it does not erase the initial failure or establish global recall.

### First historical sample

The repaired July/August captures were replayed through the new staging engine without new search charges: 80 distinct results yielded 42 visual candidate leads. Five selected historical originals were then acquired with one real official lookup; all five returned and produced complete draft candidates. These are **five drafts, zero newly published items**, pending editorial and media checks. This pilot is a start toward the staged backfill, not completion of the additional-500 milestone.

Local validation for this implementation: type checking passed; the full suite passed 596 tests with the opt-in scale test skipped. The separate 10,000-item SQL acceptance passed: all items appeared once across 334 pages, with a local median of 155 ms and p95 of 173 ms per page. These are embedded local SQL measurements, not production-network latency. Scheduler safety tests also passed. CI and runtime activation remain separately recorded gates.

## Production cutover and durable lead queue

PR 125 passed content CI and the native suite (254 tests, four environment skips, zero failures), then merged as `39b102c`. The guarded runtime was activated at 2026-10-17 07:39 UTC with hybrid discovery, the existing hybrid rechecks, three official supplement calls and the shared $20 cap. Thirty-one state files and all credential values survived installation unchanged. A deployed-runtime budget smoke test made zero HTTP requests at a full budget. A real publication run started at 07:40 UTC; its final result must be verified separately, not inferred from installation.

The follow-up queue removes a gap in the first cutover: previously, a new search window selected only its own leads. `x-lead-queue.json` now records deduplicated candidate metadata and exact immutable evidence references across all windows. Replaying unchanged checkpoints does not renew age or buy another search. Within each media pool, admission alternates three fresh candidates with one oldest pending candidate. Existing visual quotas and all official acquisition, editorial, preview and publication gates remain unchanged.

Official acquisition ledgers are read across UTC days. Completed unavailable IDs and ambiguous paid attempts cannot silently be purchased again after midnight. A confirmed dollar-budget rejection remains pending because no request was sent. Uncertain attempts require operator reconciliation before their identities can be retried; other candidates can proceed on a subsequent day.

Historical leads are explicitly staged with `npm run collect:x-leads -- --directory /external/verified-plan --scope history`. This is a dry run and makes no acquisition request. After reviewing remaining shared budget, use `--acquire --max-posts N`, with at most 60 historical originals per day. The normal live route keeps its separate 40-original allowance. Both lanes share the same monetary ledger and global source deduplication; separate post allowances are **not** extra dollar budgets. The command emits drafts only. The scheduled daily pipeline still supplies editorial, media, translation and publication checks.

Historical acquisition is operator-driven while the large-library maintenance and budget gates remain unresolved. Do not enable an unattended 10,000-item import or spend the routine collection runway without an explicit allocation. If rolling back to a runtime predating the queue ledger's `lane` field, set discovery to `official` first; never erase or rewrite paid reservations to make an older parser accept the state.

### First production acceptance, 2026-10-17

The cutover run finished successfully at 07:59 UTC. It published 28 new items (17 images, ten videos, one text) and withdrew two previously published images; total inventory became 837. All three known unavailable source IDs appear in the removal set, including one already absent from the previous active release. The public API passed 85 requests covering full pagination, original/Chinese projections, details, removals and invalid requests. Observed median was 490 ms, p95 1,034 ms. A read-only database snapshot was backed up outside Git.

Three of the first five historical candidates reached publication. One was editorially rejected; the fourth approved candidate was withheld after Cloudflare returned HTTP 500 during its preview upload. Chinese translations for the three published candidates are prepared in the shared translation cache, awaiting the next publication. A second historical acquisition obtained 20 originals with one official request; these are not counted as published items. Sixteen immutable weekly plans cover July 1 through October 15, without issuing extra searches merely to create the plans.

PR 126 passed content and native CI and was installed as runtime commit `a801908`. Seventy-three state files and all credential files were preserved. Replaying the deployed queue imported 190 distinct leads (148 live, 42 historical) with zero HTTP calls and no repeated official acquisition. The runtime now includes operational scripts, so removing its development worktree does not break backfill commands.

The three unavailable post IDs belong to the same author. A separate official user lookup confirmed account suspension. A new **users** compliance pilot, including that negative control and a current positive control, was uploaded as job `2111366279978438656` at 07:58 UTC. This is distinct from the already completed **tweets** pilot. Do not create a duplicate job or change source-availability gates while awaiting the result. Signed URLs and raw evidence remain private outside Git.

### Media recovery

Source downloads now retry transient connection failures and HTTP 408/429/500/502/503/504 at most twice, keeping host, redirect, TLS and decoded-byte checks. Retry-After is honored up to 30 seconds; longer delays fail the current attempt. Missing content, invalid hosts, oversized media and TLS verification failures never trigger a retry.

Only content-addressed `media/<sha256>.<extension>` uploads receive storage retries. File bytes must match the key before every attempt; a changed file stops immediately. Authentication errors and long Retry-After also stop immediately. Mutable publication pointers still use their existing reconciliation protocol, rather than replaying an uncertain write. Raw CLI diagnostics are not copied into media failure reports.

### Historical readiness audit, 2026-10-17 12:20 UTC

The public library contains 836 items after a separately verified quality hold removed one mismatching image. Three historical items remain published; their Chinese translations are live. The next 20 acquired originals produced 19 complete drafts, all text-approved using seven existing Codex review requests. Only 18 of those pass the subsequent library selection rules. Approval of metadata alone is not publication eligibility.

Including the earlier fourth historical candidate, 19 unpublished image candidates now pass source freshness, text selection and quality-hold checks. Two image mirrors already exist; 38 further images must be prepared. All 19 still need complete Chinese translation and current presentation review. In particular, the fourth candidate's earlier image/prompt match lacks the newer presentation label, so its cached match cannot bypass the configured classification gate.

Today's visual ledger has 24 completed requests covering 61 candidates and 247 images or sampled video frames. It is exhausted without failed or uncertain attempts. This is already bounded batch review, not one request per image. The current publication window permits 75 new items and 50 have been published today, but spare publication capacity cannot substitute for visual review. The readiness audit made zero model calls, vendor calls or publications and did not reset any ledger.

Media preparation may proceed from these already acquired, approved sources under the content lock, using the existing allowlisted downloader, image normalization, content-addressed uploader and CDN checksum checks. Cached media is preparation only. The next review window must reuse the cache, retain all attempt accounting, revalidate source freshness, finish presentation/translation checks and apply the ordinary publication quota before adding any record. Do not repurchase the original 20 posts to restart this cohort.

Both completed official compliance pilots returned empty results and failed their known-unavailable negative controls, including the user-suspension control. They are not a source-freshness replacement; do not create another copy of either job or continue polling completed jobs.
