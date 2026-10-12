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

## Editorial reviews

Every community source requires an editorial review before publication, including YouMind image/video entries and prompts.chat roles. Daily collection is discovery, not automatic quality approval: new or changed source text stays out of public editions until its exact fingerprint is reviewed. An unchanged cached snapshot can reuse its matching review. Review a candidate with `npm run review -- <candidate-id> /absolute/path/editorial-metadata.json`. The metadata requires title, summary, example, tags and previewLabel; optional cover contains text, eyebrow and tone (`sage`, `clay`, `ink`, `sky`, `cream`). Optional imageURL and demoURL select inspected HTTPS previews; web entries require both. Optional priority (0–100) controls editorial selection before upstream featured items.

Reviews live in the external content directory, preserve source text and attribution, and match the exact text fingerprint. Changed text must be reviewed again. Inspect each manually selected image against the prompt: the first image in an upstream post can belong to a different example. The review command accepts all allowlisted repositories, the video archive, and official Skill snapshots, and shares the content lock with publishing. It does not publish. Run daily staging and checks before activating a new edition. Procedural video studies have been removed from the shipping catalog and app resources. The offline studio catalog contains original text, generated image examples and working website examples; real community video examples arrive through a content update.

An optional bounded metadata editor closes the recurring intake loop. After upgrading the scheduled runtime, set `PROMPIX_EDITORIAL_PROVIDER=codex` in `~/.config/prompix/editorial.env` (optionally `PROMPIX_CODEX` for the executable path). It uses `gpt-5.6-luna`, at most **one request and three complete candidates per UTC day**, with at most 16,000 serialized input characters. Ordinary non-publishing staging makes no provider calls even when configured. Published edits take priority; remaining items rotate across source/modality shelves. Known CC0 prompts.chat, CC-BY YouMind repositories, and per-directory Apache official Skills are eligible. Missing source revisions, incomplete real previews, or source bodies too large for a complete bounded review are deferred.

The isolated provider has shell and web access disabled and returns strict, fingerprint-bound approve/defer/reject decisions. It may only write titles, purpose summaries, usage guidance, tags and theme covers. Usage text is labeled `使用建议：`; it cannot invent a test result, preview, source URL, license, author, or rewritten instructions. Automatic metadata approval does not claim the model visually inspected a source attachment. Website entries still require a real preview and demo; video entries require a real clip and poster. Existing media verification and publication checks remain in effect.

Reservations live in external `editorial/daily-attempts/YYYY-MM-DD.json` and are written before the provider call. Timeouts, empty or invalid responses consume the attempt; no ambiguous automatic retry occurs that day. Decisions live in `editorial/decisions.json`, keyed by item ID and source fingerprint. Rejected/deferred text is not repeatedly submitted; changed text can be reviewed again. Preflight-only deferrals are reconsidered when missing provenance or media becomes available. Accepted metadata enters the existing `editorial.json` gate, then the translation cache/publisher. `status.json.editorial` distinguishes pending/eligible candidates, actual requests, attempted candidates, approvals, deferrals, rejections and failures from actual `changes.added` publication growth. This is a bounded single pass, not an autonomous browsing agent. Native X drafts have the separate source gate below.

## Native X intake

Daily processing reads every cached `x-discovery/YYYY-MM-DD.json`, including days with no new paid request, and writes reviewable bodies to `candidates/x-native.json`. It deduplicates by numeric post ID, uses the latest snapshot for changed text, and binds metadata reviews to that body's fingerprint. These files remain outside Git. Reading the cache does not request posts, follow links or download media; the existing once-per-UTC-day search budget is unchanged.

The parser requires one explicit English, Chinese or Japanese prompt marker, including common Markdown or emoji prefixes. It prefers full `note_tweet` / `note_post` text, preserves the marked instructions, and can extract a closed code fence. A short URL expands only from the selected text’s unambiguous API entities. A trailing media placeholder is removed only when its media key matches an actual safe attachment for this post; unknown or conflicting links stay unresolved. Generic markers use explicit modality/model or attached-media evidence; ambiguous and conflicting modality signals stay blocked. Announcements without a boundary, API-truncated text, unfinished endings/fences, unresolved `t.co` links and link-only bodies remain discovery records with individual reasons. This is a bounded draft extractor, not proof that arbitrary post text contains a complete usable prompt. It does not follow threads or linked pages.

Drafts retain stable post IDs, numeric author IDs, source URLs and available verified creator profiles. A missing profile gets a truthful numeric-account fallback, not a guessed handle. Attachment keys associate source photos/posters/MP4 variants with their post; source media URLs are captured for review and are not mirrored or published by intake. Licenses remain `Unspecified`; post text claiming a license does not create a verified grant, and post IDs are not represented as Git revisions.

`status.json.sources["x-intake"]` separates `discovered`, `drafted`, parser `blocked`, `publicationBlocked`, fingerprint-matched `reviewedDrafts`, reasons and snapshot errors. `x-intake/status.json` adds the per-post trace, source snapshot, links, attached media keys, candidate ID and an exact source digest. That digest binds raw extracted instructions, modality/model, post URL, numeric author ID and media URLs, independently of editorial wording or refreshed avatars. An X metadata review can be saved with `npm run review -- x-post-<id> /absolute/path/editorial-metadata.json`; the command reports `draft-awaiting-source-review`. Automatic editorial requests exclude native X, and library selection keeps them unpublished even after metadata work. **Native X source/publication review is not implemented by this change.** Repository-backed sources and their existing publication gates continue separately; draft counts must not be reported as new App content.

Search now requests long text and attached media alongside creator expansions, without an extra API request. The established `tweet.fields` query uses `note_tweet`; intake also accepts the renamed `note_post` response. The current [recent-search reference](https://docs.x.com/x-api/posts/search-recent-posts) documents `post.fields`/`note_post`, while the [legacy official field reference](https://docs.x.com/x-api/posts/english-language-firehose-stream) retains `tweet.fields`/`note_tweet`. Media expansion and `variants` are documented in both. Richer search fields require verification in the next budgeted live run; do not spend a second paid request to probe aliases or bypass the daily guard.

Search is now scoped to five real creators already represented in the catalog: ChangningL29508, SheBuildsAI_, xiaoxiaodong, Elvorya and ArtistaNozomu. The query includes English, Chinese and Japanese prompt terms and excludes reposts, replies and quotes. This improves the input strategy; it is not a claim that its next live result has already been verified. The one-request/10-result budget remains unchanged.

The query, endpoint, requested fields, result cap and ordering produce `xSearchFingerprint`. Cursors are stored per fingerprint in `x-state.json.cursors`; legacy unscoped cursors do not constrain this new query. The global UTC `day` reservation still blocks a second request after a query change, timeout, partial response or write failure. `x-search-attempts/YYYY-MM-DD.json` records the credential-free request identity before calling X. A complete snapshot is persisted before advancing its cursor. Missing/invalid response metadata, partial API errors and redirects fail without automatic retries. Each new snapshot includes field-coverage counts for long text, entities, linked attachments and matching author profiles; a zero field count does not prove the posts have no such content.

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

Final assembly keeps every previously published ID unless it has an explicit removal tombstone. Upstream edits waiting for review, missing source rows and failed new previews retain the last verified prompt, attribution, mirrored media and translations. A newly preferred cross-source duplicate cannot replace an existing saved ID. `status.json.retainedPrevious` reports counts and known reasons. Retention still respects the 1,000-item/10 MB protocol limits; overflow stops activation rather than pruning the library.

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

`npm run rollback -- <edition-or-rollback-version>` validates the saved target manifest against the public catalog and stages a removal-safe rollback. Add `--publish` to verify media and activate it. Recovery holds automatic publishing until `npm run daily -- --publish --resume-publishing` succeeds. Collection continues while held. See [operations](../docs/content-operations.md) for the complete procedure, report paths and urgent removals.
