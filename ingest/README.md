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

The checked-in app catalog contains 36 original Prompix prompts. Edit `ios/Prompix/Resources/catalog.json` directly; this is the canonical first-party fixture. TypeScript and Swift contract tests validate that same fixture. Model-generated media and editorial illustrations are labeled separately in the app.

## Daily publishing

`npm run daily` collects and stages candidates outside Git. `npm run daily -- --publish` mirrors verified media and activates a catalog only after its remote checksum matches. `npm run check:deployment` verifies the deployed read-only API and byte ranges. `npm run remove -- <id> <reason>` stages a removal for the next publish.

Install the Mac daily job with `python3 scripts/install-scheduler.py`. See [operations](../docs/content-operations.md) for credentials, logs, recovery and cost limits.

## Editorial reviews

Raw prompts.chat roles remain drafts, including older cached snapshots. Review a candidate with `npm run review -- <candidate-id> /absolute/path/editorial-metadata.json`. The metadata requires title, summary, example, tags and previewLabel; optional cover contains text, eyebrow and tone (`sage`, `clay`, `ink`, `sky`, `cream`). Optional imageURL and demoURL select inspected HTTPS previews; web entries require both. Optional priority (0–100) controls editorial selection before upstream featured items.

Reviews live in the external content directory, preserve source text and attribution, and match the exact text fingerprint. Changed text must be reviewed again. Inspect each selected image against the prompt: the first image in an upstream post can belong to a different example. The review command does not publish. Run daily staging and checks before activating a new edition. Procedural video studies and image placeholders stay in the labeled offline studio catalog; they are excluded from live editions.

An optional `imageURLs` list adds an explicitly reviewed gallery (1–8 HTTPS images,
in presentation order). Its first image becomes `imageURL`, preserving older
clients' cover behavior. Duplicates are removed. Do not turn every upstream image
into a gallery automatically: verify that each one demonstrates this prompt,
including any variable substitutions. Publishing mirrors every selected image;
a media failure excludes the whole candidate. Recovery checks every gallery
asset before activation. Upgrade the scheduled runtime before using this new
editorial field. Saved offline thumbnails still cover the primary image only;
additional images require a connection or an existing browsing cache.

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
The video channel admits up to 12 eligible examples. Watch-page links are never
treated as downloadable videos, and third-party material stays outside Git.


## Release recovery

`npm run rollback -- <edition-or-rollback-version>` validates the saved target manifest against the public catalog and stages a removal-safe rollback. Add `--publish` to verify media and activate it. Recovery holds automatic publishing until `npm run daily -- --publish --resume-publishing` succeeds. Collection continues while held. See [operations](../docs/content-operations.md) for the complete procedure, report paths and urgent removals.
