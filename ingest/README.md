# Lightweight collection

Requires Node 22+. `npm ci` at the repository root, then:

```sh
npm run collect -- --source prompts-chat
npm run validate -- ios/Prompix/Resources/catalog.json
npm run stage -- ios/Prompix/Resources/catalog.json
```

Collection downloads a pinned, public CC0 CSV from prompts.chat. It preserves contributor/revision/provenance, deduplicates normalized text, and reports rejected rows. Unsupported types are rejected, not guessed. There are bounded timeouts, retries, and a size limit. Repeated collection produces the same snapshot. Nothing is published automatically.

Drafts and local release candidates go to `~/.local/share/prompix/content/`, never Git. `PROMPIX_CONTENT_DIR` can override this to another directory outside the checkout. Drafts require editorial work (preview, description, model/tool check) before they meet the shipping catalog schema. Collected source text must not be placed in the bundled first-party catalog or committed.

`stage` validates and writes a versioned catalog plus SHA-256 manifest locally. Existing versions cannot be replaced by different content. This command only stages locally; the separate daily publisher handles remote media, activation, removal lists and additional adapters.

The checked-in app catalog contains 30 original Prompix text, image and website prompts. Edit `ios/Prompix/Resources/catalog.json` directly; this is the canonical first-party fixture. TypeScript and Swift contract tests validate that same fixture. Model-generated media and editorial illustrations are labeled separately in the app.

## Daily publishing

`npm run daily` collects and stages candidates outside Git. `npm run daily -- --publish` mirrors verified media and activates a catalog only after its remote checksum matches. `npm run check:deployment` verifies the deployed read-only API and byte ranges. `npm run remove -- <id> <reason>` stages a removal for the next publish.

Install the Mac daily job with `python3 scripts/install-scheduler.py`. See [operations](../docs/content-operations.md) for credentials, logs, recovery and cost limits.

After acquiring the content lock, daily writes `status.json` with a new `runID`, `startedAt`, `state: running` and `published: false` before any collection, provider call or publication recovery. If that write fails, no work begins; stale status is removed on a best-effort basis. Completion is saved under the same lock with `state: succeeded|failed` and `finishedAt`. `succeeded` means the invocation completed: held publication, local staging and individual source failures still retain their separate report fields.

The existing daily log always receives a terminal record, including the original error plus separate `statusWriteError`, `statusInvalidationError` or `unlockError` when applicable. Status/cleanup failures return a nonzero exit without hiding the original collection exception or claiming an activated edition was rolled back. A final status-write failure leaves the persisted start at `running`; an unwritable and non-removable volume can still leave old data. A killed process may have no terminal record. Check the matching run ID/time, live process, log and scheduler exit together; neither an old `published: true` nor a remaining `running` record proves current health. Lock-acquisition failures leave the owner's status untouched and are reported by the existing CLI error path. Fault tests run with `node --import tsx --test ingest/daily-status.test.ts` and never contact providers.

Official Skill inventory requires an authenticated GitHub CLI (`gh`) session on the collector host. The collector requests one complete recursive tree per allowlisted repository and immutable revision, with a 60-second timeout and 7 MB response limit. It validates the complete directory inventory before accepting a Skill. CLI failures expose sanitized errors and preserve the previous candidate; there is no anonymous API fallback or interactive login in the daily job. Source bodies and licenses still come from pinned public raw URLs.

The v2 language-pack publisher is implemented behind `PROMPIX_LANGUAGE_PACKS_ENABLED=true` for initial bootstrap. The scheduled launcher reads this optional setting from `~/.config/prompix/publication.env`. Deploy the Worker routes and verify the migration before enabling it. Once local state or the live v2 pointer exists, omitting the flag cannot return the publisher to v1. This server implementation does not enable native downloads; see [protocol and migration boundaries](../docs/content-protocol-v2.md).

`release-publication.ts` reads every advertised language for the complete publisher baseline, stages immutable originals and locale artifacts, verifies every remote byte/hash, then activates v2 followed by v1. `publication-state.json` retains observed pointer identities and exact targets before any upload. The channels are not an atomic transaction: a later failure retains this intent, and the next publishing run finishes the same target before collection, media or paid model work, then exits. New removals rebuild that retained target without new preparation. Foreign pointer changes and corrupt/missing advertised packs fail closed.

If the complete catalog exceeds the old 10 MB limit, v1 retains its last compatible snapshots and receives only explicit removals; it does not silently regain new content if a later catalog becomes smaller. V2 remains the complete retention and rollback baseline. Originals plus any one locale retain the 10 MB decoded cap and 1,000-item limit. If removing every v1 item would create an unsupported empty v1 catalog, staging fails before activation; it does not fabricate a placeholder.

`npm run daily` still makes no paid model calls and never resumes/activates pending work. With v2 selected it reads the complete baseline and stages both channels locally. Pending publication must first be resumed or explicitly rolled back. Held publishing runs now stop before collection; use ordinary non-publishing staging to inspect candidates. `status.json.channels` reports each version and `v1Frozen`; `recoveredPublication` marks a run that only completed retained publication work.

## Editorial reviews

When a prior `reserved` or `failed` attempt blocks paid editorial or visual requests below the configured daily ceiling, the report uses `prior-attempt-blocked` and includes `blockedAttempt` (`ordinal`, `state`, `reservedAt`). For example, attempt 60 can block a 64-request day without exhausting its quota. The persisted reservation stays consumed and no provider is retried or ledger rewritten; a genuinely exhausted configured count still reports `daily-limit`. The next UTC day retains the existing fresh-ledger behavior. A saved `reservedAt` is the recorded runner timestamp, not proof of when a provider request completed or whether it was billed.

Every community source requires an editorial review before publication, including YouMind image/video entries and prompts.chat roles. Daily collection is discovery, not automatic quality approval: new or changed source text stays out of public editions until its exact fingerprint is reviewed. An unchanged cached snapshot can reuse its matching review. Review a candidate with `npm run review -- <candidate-id> /absolute/path/editorial-metadata.json`. The metadata requires title, summary, example, tags and previewLabel; optional cover contains text, eyebrow and tone (`sage`, `clay`, `ink`, `sky`, `cream`). Optional imageURL and demoURL select inspected HTTPS previews; web entries require both. Optional priority (0–100) controls editorial selection before upstream featured items.

Reviews live in the external content directory, preserve source text and attribution, and match the exact text fingerprint. Changed text must be reviewed again. Inspect each manually selected image against the prompt: the first image in an upstream post can belong to a different example. The review command accepts all allowlisted repositories, the video archive, and official Skill snapshots, and shares the content lock with publishing. It does not publish. Run daily staging and checks before activating a new edition. Procedural video studies have been removed from the shipping catalog and app resources. The offline studio catalog contains original text, generated image examples and working website examples; real community video examples arrive through a content update.

An optional bounded metadata editor closes the recurring intake loop. After upgrading the scheduled runtime, set `PROMPIX_EDITORIAL_PROVIDER=codex` in `~/.config/prompix/editorial.env` (optionally `PROMPIX_CODEX` for the executable path). It uses `gpt-5.6-luna`, defaults to **four requests per UTC day**, and processes at most **three complete candidates and 16,000 serialized input characters per request**. Set `PROMPIX_EDITORIAL_MAX_REQUESTS` to an integer from 0 to 20; 0 disables new calls. One normal publishing invocation processes pending batches until it reaches the remaining daily budget, runs out of eligible work, or encounters a failure. Ordinary non-publishing staging makes no provider calls even when configured. Published edits take priority; remaining items rotate across source/modality shelves. Known CC0 prompts.chat, CC-BY YouMind repositories, and per-directory Apache official Skills are eligible. Missing source revisions, incomplete real previews, or source bodies too large for a complete bounded review are deferred.

The isolated provider has shell and web access disabled and returns strict, fingerprint-bound approve/defer/reject decisions. It may only write titles, purpose summaries, usage guidance, tags and theme covers. Usage text is labeled `使用建议：`; it cannot invent a test result, preview, source URL, license, author, or rewritten instructions. Automatic metadata approval does not claim the model visually inspected a source attachment. Website entries still require a real preview and demo; video entries require a real clip and poster. Existing media verification and publication checks remain in effect.

Reservations live in external `editorial/daily-attempts/YYYY-MM-DD.json` and are written before each provider call. The versioned ledger retains each attempt, its candidates, state and reported token usage; its cumulative request count survives restarts or configuration changes. Old one-request ledgers count as one spent slot, not a fresh day. A run crossing UTC midnight stops before starting another provider call; its conservative old-day reservation stays spent. A timeout, malformed response, persistence failure or interrupted reservation stops all remaining requests for this stage that UTC day. Earlier completed approvals remain reusable; no ambiguous automatic retry occurs that day. Raw provider responses are saved under `editorial/responses/YYYY-MM-DD-NNN.json`, preserving each attempt and older daily response files. Decisions live in `editorial/decisions.json`, keyed by item ID and source fingerprint. Rejected/deferred text is not repeatedly submitted; changed text can be reviewed again. Preflight-only deferrals are reconsidered when missing provenance or media becomes available. Accepted metadata enters the existing `editorial.json` gate, then the independent visual-readiness gate described below before translation/publication. `status.json.editorial` distinguishes pending/eligible candidates, this invocation's reserved `requests`, UTC-day cumulative `dailyRequests`, configured `maxRequests`, attempted candidates, approvals, deferrals, rejections and failures from actual `changes.added` publication growth. This is a bounded single pass, not an autonomous browsing agent. Native X drafts have the separate source gate below.

## Independent visual readiness

Metadata approval, including older cached approval, never proves that a preview matches a prompt. After mirroring, the daily publisher independently checks every new or changed community media item. An unchanged, checksum-verified previous catalog snapshot may be carried forward; it is counted as `previousSnapshots`, not a new visual approval. Original bundled artwork follows its separate reviewed resource path.

Enable the bounded image reviewer with `PROMPIX_VISUAL_PROVIDER=codex` in the existing external `~/.config/prompix/editorial.env`. It uses the same fixed `gpt-5.6-luna` model with actual JPEG attachments and defaults to four requests per UTC day. `PROMPIX_VISUAL_MAX_REQUESTS` accepts an integer from 0 to 20, with 0 disabling new calls and review-media preparation. Each request still contains at most three items, sixteen images, 32 MB of attachments and 32,000 serialized input characters. Galleries stay intact between batches; bounded preparation considers at most three items per remaining request slot. This is a separate, explicit budget from the metadata reviewer. The input includes complete instructions, never truncated instructions. Normal dry-run does not download review images or invoke a provider.

Review identity binds the item, complete published instructions, model, source attribution, and exact ordered selection of content-addressed media. Downloaded bytes must match their `api.prompix.dev/media/<sha256>` address. Images are checked individually; a gallery cannot pass with a missing or uncertain image. Short videos use the real poster and six sampled frames with timestamps, duration, and the video hash recorded. This checks representative visible content, not continuous playback, audio, or frame-by-frame fidelity; a task depending on evidence unavailable in the samples must be deferred. New webpage items use the separate [trusted browser interaction review](website-review.md); this image-only path cannot approve a webpage. Pinned, attributed CC0 prompts.chat entries may pass only with exact hosted artifact/preview hashes and real mobile/desktop interaction records. The daily run rechecks hosted bytes, preserves the approved JPEG without re-encoding, and spends no visual model requests for that verification.

`visual-review/daily-attempts/YYYY-MM-DD.json` records each reservation before the provider call, using the same migration and cumulative accounting as metadata review. Failed or interrupted attempts stop the stage for the rest of the UTC day, without retry. Completed decisions remain reusable. Responses are saved separately as `visual-review/responses/YYYY-MM-DD-NNN.json`. `visual-review/decisions.json` stores exact-identity decisions and the inspected attachment hashes/coverage, never temporary filesystem paths. A changed body or selected image invalidates approval. `status.json.visualReview` reports readiness, this invocation's reserved `requests`, UTC-day `dailyRequests` and `maxRequests` separately from `changes.added`; deferred replacements retain the entire old snapshot under `awaiting-media-review`. No historical metadata record is retroactively labeled visually checked.

The 4/4 review defaults and 36-request daily translation default are engineering throughput settings, not a user-imposed dollar allowance. With Codex, request counts, existing input caps, timeouts and account limits bound usage; they do not establish a measured USD cap. Translation retains its existing bounded retry policy and cumulative reservations. See [configuration example](review.env.example) and [translation operations](../docs/translation-operations.md). Existing explicit settings continue to override defaults. X remains at one search and ten results per UTC day.

## Native X intake

Daily processing reads every date-prefixed cached `x-discovery/*.json`, including search pages and availability checks, even when no new paid search is allowed, and writes reviewable bodies to `candidates/x-native.json`. It deduplicates by numeric post ID, uses the latest snapshot for changed text, and binds metadata reviews to that body's fingerprint. These files remain outside Git. Reading the cache does not request posts, follow links or download media; the existing shared UTC-day search budget is unchanged.

The parser requires one explicit English, Chinese or Japanese prompt marker, including common Markdown or emoji prefixes. A colon-free marker must occupy its whole line, use balanced bold formatting if present, and precede a newline; supported decorations include downward arrows (with optional “below”), a standalone semicolon/period, and explicit GPT Image/Nano Banana/Seedance model-qualified headings. Inline mentions and headings with trailing prose do not qualify. Colon and colon-free markers count together, so multiple boundaries remain blocked. It prefers full `note_tweet` / `note_post` text, preserves the marked instructions, and can extract a closed code fence. A short URL expands only from the selected text’s unambiguous API entities. A trailing media placeholder is removed only when its media key matches an actual safe attachment for this post; unknown or conflicting links stay unresolved. Generic markers use explicit modality/model or attached-media evidence. Generic hosting names such as ChatGPT or Claude do not override a dedicated image/video model or concrete website instructions; ambiguous and conflicting modality signals stay blocked. Announcements without a boundary, API-truncated text, unfinished endings/fences, unresolved `t.co` links and link-only bodies remain discovery records with individual reasons. This is a bounded draft extractor, not proof that arbitrary post text contains a complete usable prompt. It does not follow threads or linked pages.

Drafts retain stable post IDs, numeric author IDs, source URLs and available verified creator profiles. A missing profile gets a truthful numeric-account fallback, not a guessed handle. Attachment keys associate source photos/posters/MP4 variants with their post; source media URLs are captured for review and are not mirrored or published by intake. Complete API-backed drafts record `X-API-Terms`, the original post, author identity and check time; incomplete provenance remains `Unspecified`. A post claiming a license does not create a verified grant. Source revisions are content digests, not Git revisions.

`status.json.sources["x-intake"]` separates `discovered`, `drafted`, parser `blocked`, `publicationBlocked`, fingerprint-matched `reviewedDrafts`, reasons and snapshot errors. `x-intake/status.json` adds the per-post trace, source snapshot, links, attached media keys, candidate ID and an exact source digest. That digest binds raw extracted instructions, modality/model, post URL, numeric author ID and media URLs, independently of editorial wording or refreshed avatars. An X metadata review can be saved with `npm run review -- x-post-<id> /absolute/path/editorial-metadata.json`; the command reports `draft-awaiting-source-review`. Automatic editorial requests exclude native X, and library selection keeps them unpublished even after metadata work. **Native X source/publication review is not implemented by this change.** Repository-backed sources and their existing publication gates continue separately; draft counts must not be reported as new App content.

Search now requests long text and attached media alongside creator expansions, without an extra API request. The established `tweet.fields` query uses `note_tweet`; intake also accepts the renamed `note_post` response. The current [recent-search reference](https://docs.x.com/x-api/posts/search-recent-posts) documents `post.fields`/`note_post`, while the [legacy official field reference](https://docs.x.com/x-api/posts/english-language-firehose-stream) retains `tweet.fields`/`note_tweet`. Media expansion and `variants` are documented in both. Richer search fields require verification in the next budgeted live run; do not spend a second paid request to probe aliases or bypass the daily guard.

Search is now scoped to five real creators already represented in the catalog: ChangningL29508, SheBuildsAI_, xiaoxiaodong, Elvorya and ArtistaNozomu. The query includes English, Chinese and Japanese prompt terms and excludes reposts, replies and quotes. This improves the input strategy; it is not a claim that its next live result has already been verified. The one-request/10-result budget remains unchanged.

The query, endpoint, requested fields, result cap and ordering produce `xSearchFingerprint`. Cursors are stored per fingerprint in `x-state.json.cursors`; legacy unscoped cursors do not constrain this new query. The global UTC `day` reservation still blocks a second request after a query change, timeout, partial response or write failure. `x-search-attempts/YYYY-MM-DD.json` records the credential-free request identity before calling X. A complete snapshot is persisted before advancing its cursor. Missing/invalid response metadata, partial API errors and redirects fail without automatic retries. Each new snapshot includes field-coverage counts for long text, entities, linked attachments and matching author profiles; a zero field count does not prove the posts have no such content.

### Reacquire incomplete cached posts

For an explicitly selected recovery run, set `PROMPIX_X_LOOKUP_IDS` to 1–10 comma-separated numeric IDs already present in cached discovery snapshots. This selects the official [batch post lookup](https://docs.x.com/x-api/posts/lookup/introduction) endpoint, `GET https://api.x.com/2/tweets?ids=...`, **instead of** that day's search. It uses the same durable global UTC reservation, including days already spent by search or a failed lookup. This is a per-run override; leave it unset for normal discovery, and do not add it to the scheduled environment for a one-time repair. Empty, duplicate, unknown or oversized selections fail before a paid request. The latest cached record must have a validated numeric author ID; malformed records need separate source review, and reacquisition cannot change that author.

Lookup requests full note text, selected-text URL entities, media attachments/variants, creator profiles and conversation/reference metadata, but does not expand additional referenced posts. A successful response must account for exactly the selected IDs, in any order. Missing, deleted, withheld, unexpected or duplicate IDs, partial API errors, redirects and invalid responses retain the prior snapshot and consume the reserved day. There is no retry, automatic pagination, alias probe or second request. The ten-ID and 500,000-byte response bounds remain in effect even though X supports larger batches. `x-search-attempts/YYYY-MM-DD.json` records `operation: "lookup"`, selected `request.ids`, endpoint, URL and request fingerprint before the call; the same identity appears in the new dated snapshot. Search cursors remain unchanged. Intake then replaces the old cached versions by ID and runs the existing completeness and publication gates.

The two legacy snapshots inspected on 2026-10-12 contain 20 posts, no full-note fields and no attachment keys/media. The earlier snapshot also lacks URL entities. The earlier colon-required parser reported three marked bodies with unresolved short links and 17 missing prompt boundaries. Recognizing a standalone colon-free heading does not repair a clipped body or supply its missing link entities. Reacquisition can supply omitted API fields, but cannot guarantee that those posts actually contain complete prompts. One cached post refers to an X article and another mentions a thread/reply; neither is silently fetched or assembled. Unknown self-replies require separately budgeted [conversation search](https://docs.x.com/x-api/fundamentals/conversation-id), with author and reply-chain verification; this mode does not implement it. Linked-page permissions, explicit prompt boundaries, source licensing and native-X publication review remain required. Synthetic tests verify recovery into unpublished drafts; no successful live recovery is claimed here.

## Additional image source

`YouMind-OpenLab/awesome-gpt-image-1.5` is an explicit fourth YouMind repository source (`youmind-gpt-image-15`). Its CC-BY-4.0 collection retains immutable commit, original post, creator, original instructions and source image. It enters the same current-fingerprint editorial, media, translation, removal and capacity gates; collection alone does not add it to the App. The model label remains GPT Image 1.5 rather than relabeling older examples as a newer model.


When an exact fingerprint-bound review exists, staging and publication expand
the upstream notation `{argument name="…" default="…"}` to its default text.
For JSON prompts, only string values are expanded and the result remains valid
JSON. Source candidates, fingerprints, reviews and attribution stay unchanged;
unreviewed/changed text and unknown notation are left untouched. This is not a
variable engine: editors must explain which defaults to change and how to fill
remaining placeholders or provide reference images in the destination tool.
Compare preview substitutions and limitations with the actual source prompt,
especially when the default differs from the shown result.

An optional `imageURLs` list adds an explicitly reviewed gallery (1–8 HTTPS images,
in presentation order). Its first image becomes `imageURL`, preserving older
clients' cover behavior. Duplicates are removed. Do not turn every upstream image
into a gallery automatically: verify that each one demonstrates this prompt,
including any variable substitutions. Publishing mirrors every selected image;
a media failure excludes the whole candidate. Recovery checks every gallery
asset before activation. A failed replacement preserves the complete prior published item;
a new candidate stays unpublished. Upgrade the scheduled runtime before using this new
editorial field. Saved offline thumbnails still cover the primary image only;
additional images require a connection or an existing browsing cache.

Final assembly keeps every previously published ID unless it has an explicit removal tombstone or an operator quality hold. Upstream edits waiting for review, missing source rows and failed new previews retain the last verified prompt, attribution, mirrored media and translations. A newly preferred cross-source duplicate cannot replace an existing saved ID. `status.json.retainedPrevious` reports the retention pass; `qualityHeldIDs` separately reports IDs subsequently withheld from discovery. Retention still respects the 1,000-item/10 MB protocol limits; overflow stops activation rather than pruning the library.

### Quality holds without personal-data removal

Use `npm run quality:hold -- <id> /absolute/path/operator-review.json /absolute/path/inspected-catalog.json` for a reviewed quality defect that should leave public discovery while keeping saved favorites and drafts. The external review contains `id`, `sourceIdentitySHA256`, `reason`, `evidenceSHA256`, `reviewerID`, and `reviewedAt`. Compute the source/media binding with `qualityHoldIdentity(inspectedPrompt)` and the evidence digest from the actual external review evidence. These are trusted operator assertions, not approval inferred from discovery or automatic model output. The command validates the exact ID and strict record, checks its source/media digest against that item in the external inspected catalog under the shared content lock, then writes only external `quality-holds.json`; it does not publish, change candidates or editorial/visual approvals, or add `removedIDs`.

The hold file has `{ "schemaVersion": 1, "holds": { "<id>": { ...recordWithoutID } } }`. Missing means no holds; malformed, oversized, symlinked or unknown metadata fails closed. Daily filters held IDs **after** prior-snapshot retention and before translation. A hold remains by ID when its source or media changes: repair does not silently clear it. Clear only the relevant active record through explicit operator maintenance under `daily.lock`, after inspecting corrected evidence; preserve that external clearance evidence. This command intentionally only adds or updates holds.

Both channels exclude held IDs, including v1's frozen carryover, without adding removal tombstones. Staging rejects an unfiltered catalog. A rollback or saved pending publication containing a held ID stops with a quality-hold error before either pointer changes; its immutable target is not rewritten or silently resumed. Use a clean explicit target to replace a conflicting pending publication, or review and explicitly clear the hold first. No placeholder is invented if the resulting channel would be empty. Native saved content is not deleted merely because its ID is absent from discovery; existing explicit moderation tombstones retain their separate personal-data removal semantics.

Original image entries are also mirrored during publication. Their local image
name remains in the bundled catalog; public editions add a content-addressed
`imageURL` for older app builds. The scheduled runtime includes only the original
image asset sets needed for this step. A missing or invalid original asset aborts
publication before activation, preserving the existing online edition.

## Video archive backfill

`npm run backfill:video` stages an explicit, immutable snapshot of the existing
allowlisted YouMind Seedance repository (2026-03-25, commit
`145d838af98657e4a45ec0cb58c4df31b55e7e52`). This archive retains complete
prompt/poster/MP4 pairs that are no longer present together in the current README.
It is historical reference content, not a claim about today's trends. The current
repository collector continues to follow upstream updates.

The command downloads only the pinned README and writes draft candidates to
`candidates/youmind-seedance-archive.json` outside Git. It neither publishes nor
calls X, and shares the content-operation lock. Empty/failed fetches preserve the
previous archive. To inspect separately from the active pipeline, set
`PROMPIX_CONTENT_DIR` to an external review directory for this command.

Every archive item requires `npm run review` before entering an edition. Inspect
the actual clip and a representative poster; a successfully fetched MP4 is not
an editorial approval. The daily job resolves current source records by stable
original-post ID before filtering or deduplicating eligible content. Current
posts with missing media remain drafts, preserving their text fingerprint. An
unchanged draft may use the complete archived case, retaining the pinned archive
provenance and editorial requirement. A changed current prompt blocks that older
case even when the current post has only a watch-page link. Reviewing text cannot
make a missing clip/poster pair publishable; existing removal IDs still apply.
The video channel includes every eligible, reviewed example without a source quota. Watch-page links are never
treated as downloadable videos, and third-party material stays outside Git.

Reviewed representative video frames may use a content-addressed JPEG on
`api.prompix.dev` as their editorial `imageURL`. These covers go through the same
download, media validation, conversion and hashed publication path as other
reviewed images; they do not bypass the mirror cache or publication checks.


## Release recovery

`npm run rollback -- <edition-or-rollback-version>` verifies the saved target and stages a removal-safe rollback. V2 prefers its complete local manifest and all language artifacts; a corrupt/incomplete v2 target cannot fall back to v1. Add `--publish` to verify media and activate both channels. Explicit rollback can replace an interrupted ordinary publication without first publishing that unwanted target, while retaining its removals. Automatic retry rechecks media before activation and preserves any existing hold byte-for-byte. Recovery holds automatic publishing until a matching `npm run daily -- --publish --resume-publishing` succeeds; staging remains available. See [operations](../docs/content-operations.md) for procedures and urgent removals.

## Community Skills

The daily job also reads the owner-qualified ClawHub allowlist in `clawhub.ts`. `npm run collect:community-skills` performs only this bounded public intake under the content lock: no installs, execution, model calls or publication. Raw evidence, candidates and availability state stay outside Git. Three initial packages are allowlisted, with at most ten requests per pass, six-hour caching and persistent `Retry-After` handling.

Complete file inventories and exact entrypoint bytes bind the immutable registry revision. Editorial approvals and cached decisions include that revision, so changed supporting files cannot reuse a text-only approval. ClawHub's registry-wide MIT-0 policy is recorded separately from nullable API license fields. Conflicting moderation or a non-clean version scan prevents intake; upstream scans do not replace editorial review or promise safety.

Only matching source identities checked within 24 hours can enter publication. Collection errors and withdrawals cannot revive retained snapshots. Staging, frozen v1 snapshots, pending activation and both rollback protocols enforce the same availability rule without personal-data removal tombstones. If an old pending target no longer qualifies, refresh intake and prepare a corrected edition; immutable targets are never silently edited. See [source contract and actual research](../docs/community-skills.md).

## Independent intake (2026-10-13)

The scheduled pipeline no longer fetches OpenLab repositories or their video archive. Their already-published IDs and attribution survive retention; they are not an expanding upstream. This supersedes the earlier creator-scoped, one-request search description above.

- `npm run collect:x -- --fetch` performs budgeted official X searches across image, video, text, web and Skill topics. Without `--fetch` it processes only local snapshots. Load `X_BEARER_TOKEN` from the external env file.
- `PROMPIX_X_MAX_REQUESTS` defaults to 4 (0–20); `PROMPIX_X_MAX_POSTS` defaults to 200 (0–1000). Each request reserves at most 50 posts before calling. Existing legacy spend is retained. These limits do not include optional creator refresh; X user expansions may also incur resource charges, so the post allowance is not a dollar estimate.
- `x-feed-state.json` stores a cursor per query fingerprint and the next topic. `x-feed-attempts/YYYY-MM-DD.json` preserves reserved/completed/failed requests. Never erase these ledgers to rerun a paid operation. `x-discovery/YYYY-MM-DD-feed-NNN.json` contains source snapshots outside Git.
- `npm run collect:skills` collects the 35 allowlisted official Skill directories directly into the external candidate cache. It does not publish. Each directory is pinned, licensed and inventoried independently; scripts are never executed.
- Native X candidates enter source-bound editorial and preview review as described in [the upgrade plan](../docs/independent-pipeline.md). Counts of raw posts are not counts of usable App content.

The larger official Skills require a complete review input: the metadata batch now allows 36,000 characters and at most three records. External runtime configuration currently allows 32 metadata requests and 120 translation requests daily; those totals include earlier attempts that day. Translation availability is published per item, so incomplete language sets fall back to the original instead of advertising a missing translation.


### Native X publication (0.4.1)

`x-availability.ts` rechecks complete source candidates through the official batch lookup. Its separate ledger reserves at most two requests / 200 posts per UTC day. Explicitly unavailable posts enter removal records; changed or stale versions are withheld after retention. A source without a matching checked revision cannot publish. Editorial approval also binds the captured source digest, and cannot replace the original attachments. The iOS detail retains the full original post, author and timestamp.

The local scheduler now runs at 02:00, 08:00, 14:00 and 20:00. Search and model usage budgets remain shared per UTC day. Editorial/visual request limits accept 0–40 (default 4); increasing a configured ceiling never clears failed or reserved attempts. Current operational settings and actual publication evidence are in `docs/content-operations.md`.

Video policy `sampled-video-relevance-2` checks visible subject, setting, style and sampled story progression. Generic motion/music requests do not make all sampled video evidence unusable, but defining audio/lip-sync or unobserved frame-accurate requirements remain uncertain. Video identities include the policy version so earlier evidence is preserved rather than silently reinterpreted; image identities are unchanged. Match is not a claim of complete reproduction or of listening to audio.

### Public author replies

`npm run collect:x -- --fetch --replies` recovers public reply leads only, using
exactly the same UTC request/post ledger as ordinary discovery. Without
`--replies`, the scheduled collector alternates recovery and topic searches when
leads exist. A source must explicitly point to public replies/comments; private
DM giveaways do not qualify. Query handles are hints; numeric author IDs,
conversation IDs, chronological parent references and completed pagination are
validated separately. The original discovery query identity is unchanged.

Exact page responses live under `x-replies/<root>/<window>/` outside Git.
`analysis.json` reports linked/blocked source chains, not publication approval.
Page cursors survive restarts and expire after 48 hours; completed roots are
eligible again after 24 hours, while posts older than six days leave recent
search recovery. Each window is bounded to twenty pages. Conflicting source text
across pages prevents a complete result; changing engagement metrics do not.
Missing ancestors are never invented. Original root and reply text remain
separate, and the regular single-post intake does not read these snapshots.
Multi-post availability, media attribution and native presentation remain the
next publication integration step.


### Public reply workflows

`x-thread-intake.ts` replays only completed, fingerprint-checked API pagination windows. Reply IDs and bodies remain independent from root media and ordered ancestor context. Fresh lookups must include every dependency; partial checks withhold older approvals, unavailable dependencies withdraw every affected item, and source changes invalidate exact-revision editorial reviews. `PROMPIX_X_AVAILABILITY_MAX_REQUESTS` defaults to 2 and accepts 0–4 requests per UTC day; existing reservations count toward a changed cap. Every lookup contains at most 100 unique post IDs, including ancestors. No additional OpenLab collection or third-party paste crawling is introduced.

### Official publisher package discovery

`publisher-skills.ts` discovers public one-level packages in `expo/skills` (`plugins/expo/skills`), `supabase/agent-skills` (`skills`), and author-maintained `coreyhaines31/marketingskills` (`skills`). A pinned recursive Git tree supplies file inventory and nearest license; entry and license bytes must match their Git blobs. No source instructions or scripts execute. `publisher-skill-daily.ts` persists six-hour per-publisher attempts, candidates and evidence outside Git; failed refreshes retain prior pinned candidates. Both daily publication and `collect:skills` include these sources.

New publisher approvals bind source commit as well as body fingerprint. Review cache identities include package evidence; reviewed candidates are not retried again on the same UTC day. Metadata input explicitly distinguishes Skill semantics from text storage. Editorial request limits now accept 0–64 (default 4), preserving prior ledger consumption and unfinished-call blocking. Publishing remains separately gated by review and existing quality controls.

### Reviewed X source excerpts

When a complete prompt has prose headings or a promotional tail, an editor may select one contiguous instruction body from a cached standalone post. Prepare an external JSON file with `sourceSHA256`, `start`, `end`, `kind` and `includeMedia`. The digest is produced by `xExcerptSourceSHA256(post, fullXText(post).text)`; offsets use JavaScript UTF-16 indices into that complete text, not the shortened display text. Select trimmed boundaries without splitting surrogate pairs. Keep the whole instruction, required context and any constraints; do not add or rewrite missing text. `includeMedia: false` omits attachments that are not examples of the selected prompt.

Run `npm run review:x-excerpt -- <post-id> /external/selection.json` to preview, then add `--save` to persist under the content lock in `x-excerpt-reviews.json`. Replay with `npm run collect:x` without `--fetch`. No command here fetches paid sources or publishes. The normal metadata review, live source recheck, media checks and publication still apply. Verified short links use the existing API entity expansion; unverified links, truncation and link-only bodies remain blocked.

Source or author changes invalidate the saved range and never fall back to a different automatically extracted body. API availability checks replay the same selection and withhold prior editions after a changed or unavailable source. A changed selection has a new body/source review identity; it cannot inherit approval for another excerpt. This first entry point supports one selection per standalone post; reply chains and multi-card collections are not silently flattened. Removing a local selection is not a takedown operation: use the existing removal/quality-hold workflow to withdraw a published item.
