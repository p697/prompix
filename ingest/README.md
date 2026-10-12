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

Reservations live in external `editorial/daily-attempts/YYYY-MM-DD.json` and are written before the provider call. Timeouts, empty or invalid responses consume the attempt; no ambiguous automatic retry occurs that day. Decisions live in `editorial/decisions.json`, keyed by item ID and source fingerprint. Rejected/deferred text is not repeatedly submitted; changed text can be reviewed again. Preflight-only deferrals are reconsidered when missing provenance or media becomes available. Accepted metadata enters the existing `editorial.json` gate, then the translation cache/publisher. `status.json.editorial` distinguishes pending/eligible candidates, actual requests, attempted candidates, approvals, deferrals, rejections and failures from actual `changes.added` publication growth. This is a bounded single pass, not an autonomous browsing agent. Raw X posts remain discovery records and are not automatically treated as complete, licensed prompt sources.

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
