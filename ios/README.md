# Prompix for iOS

Native SwiftUI app, iOS 17+. Development version **0.4.2 (13)** adds original X posts, verified creator links, model-specific tool destinations and the native Prompt/Skill use sheet. Current production has 405 items and 32 Skills. This iteration uses only the dedicated simulator; no user phone installation. See the [independent pipeline](../docs/independent-pipeline.md) for source and language coverage.

Version 0.3.3 (10) refines discovery density, pinned kind navigation, compact creator discovery, native card context menus and motion-aware detail transitions. See the [visual review](../docs/design-polish-2026-10.md). It has not been signed or installed on a user device.

Version 0.3.2 (9) adds original-base and on-demand language downloads, transactional cache activation, and detail language download/retry controls while retaining the [Granola-inspired paper design](../docs/design-granola-2026-10.md). All 148 model tests pass cleanly; production-upgrade UI, Release performance and the final current-production language UI run after all fixes also pass in the simulator. Production recovery and the following normal daily replay both exited successfully; v1 and v2 now share `edition-v2-d8f7fc6af6de6061`, with 346 items and nine locales. Inactive artifact pruning is verified across synthetic editions and the actual new edition. The latest signed candidate is 0.3.2 (9), from commit `8118eeb`; its archive and exported IPA passed independent local strict-signature and resource audits. See the [binary evidence](../docs/quality-release.md). Version 0.3.0 was previously installed on the user's requested test phone, and this iteration has not been installed there. See [release goals](../docs/next-release.md) for remaining gates.

Open `Prompix.xcodeproj`, choose the Prompix scheme, then run on an iPhone simulator. No third-party Swift dependencies. The app downloads verified editions from api.prompix.dev while cached or bundled content remains browsable. Once v2 is installed, its same-edition committed projection can retain usable content when an artifact is damaged; it does not silently rewind to an older bundle.

```sh
xcodebuild -project ios/Prompix.xcodeproj -scheme Prompix \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  test -only-testing:PrompixTests CODE_SIGNING_ALLOWED=NO
```

Use a simulator name available on your Mac (`xcrun simctl list devices available`). The project is committed. If adding source/resource files, regenerate with `ruby scripts/generate-project.rb` from the repository root; this requires the `xcodeproj` gem. No personal signing team is committed: choose your own team in Xcode or pass `DEVELOPMENT_TEAM` locally.

## Native discovery and use

The app includes text, image, video and website Prompts, plus a separate Skill channel. Discovery shows a compact creator row, the first six works, purpose-based collections and the remaining complete stream. Accessibility sizes and VoiceOver retain the expanded creator layout. Kind navigation stays pinned, and changing filters returns to the first result. Applying a filter hides the discovery modules and shows the result count and clear action; model and purpose filters use native menus. Search includes content, creator results and clearable local recent searches. Native TabView uses SF Symbols rendered into equal optical template boxes for Discover, Collections and Favorites, avoiding forced filled variants on iOS 27. Card context menus support copying and saving; iOS 18+ detail navigation uses the system zoom transition unless Reduce Motion is enabled.

Creator cards open a searchable directory or profile with source identity, real avatar, collected works, biography when available and an external profile link. The unfiltered Discover page retains the creator heading and directory entry even when the loaded cache has no structured creator metadata; its empty state explains the update requirement and offers a retry. Missing avatars use initials. Creator bookmarks are local and independent from content bookmarks. A profile’s count describes items in this catalog, not followers or external popularity. Content cards open the detail directly, with separate creator and bookmark actions. Text and Skill details prioritize reading without a decorative media hero; genuine image, video and website previews retain their media controls.

Skills show their full SKILL.md, source directory pinned to a commit, checked file paths and installation guidance. Users can read, edit, copy, share and save them, then open the source instructions; the phone does not install or execute the Skill. Source ingestion and identity rules are documented in [creators and Skills](../docs/creators-and-skills.md).

The main interface, navigation, search, editor and app controls are native. Images use UIScrollView zoom and video uses AVKit, with explicit playback and background/close pausing. WebKit is used only to preview six bundled first-party website artifacts. JavaScript is enabled for these allowlisted local files, with an ephemeral data store, bounded file navigation and a Content Security Policy blocking network requests. External user-activated HTTPS/mailto links open through the system. The website preview state is scoped to that preview environment.

Compact layouts use two content columns and regular-width layouts use three. Accessibility text sizes or VoiceOver switch the feed to a single ordered column. Native controls, multiline identity labels and vertical metadata layouts accommodate larger text; visual and spoken-flow acceptance still requires actual simulator checks.

## Catalog and local persistence

Launch and foreground refresh check `/v2/latest.json`, verify the original base, and fetch only missing packs needed for the App language. Explicit detail selection requests only the selected locale, without an English fallback or a dependency on the App's preferred pack. An already-cached selected locale works offline even when the preferred pack is missing. A matching version alone never skips a missing language. Within the running library, successful checks use a 15-minute interval between automatic attempts. After a failed check the interval is 30 seconds from the previous attempt; a later foreground event or refresh can then retry. This is eligibility, not an automatic retry timer. Cancellation clears the attempt timestamp. Pull to refresh bypasses these intervals, and explicit language selection supersedes an older refresh.

`CatalogSync` uses a task-level `URLSessionDataDelegate` to receive chunks, with `URLRequest.timeoutInterval` set to 60 seconds rather than a deadline for the entire refresh. V2 rejects responses from a different URL, redirects, invalid HTTP status, oversize declared lengths, and any chunk beyond the descriptor or client cap. The manifest cap is 32,000 bytes; each artifact and the base plus each requested locale must fit 10,000,000 decoded bytes. Missing or dishonest Content-Length cannot bypass these limits. Progress updates are coalesced; compressed responses use an unknown total until completion. Hashing, decoding and artifact staging run away from the main actor before the verified result enters the existing catalog transaction.

`LanguagePackCache` stores verified immutable bytes by hash in `v2-artifacts`. The active `language-packs.json` index contains the exact manifest bytes and downloaded locale hashes; `catalog.json` is the readable projection of that edition. Launch loads the cached App language, and additional cached languages can be selected offline. Artifact staging and readback precede the transaction that commits the index, catalog and personal-store migrations. A healthy unchanged check succeeds without rewriting those active files, even if the transaction writer is unavailable. Corrupt regular artifacts are repaired before that no-op decision. Staging leases protect artifacts until their owner commits or rejects the result, including cancellation, concurrent stages and ancestor directory aliases. After stage settlement, MainActor cleanup reads the current disk index and retains the base, every downloaded locale and all live leases. A missing/invalid index or any rollback journal suppresses pruning. Only regular files with exact SHA JSON names can be removed; cleanup neither follows final symlinks nor recurses into directories. Deletion failures are best effort and cannot undo a successful commit.

After successful cleanup with no pending stages or recovery, at most ten managed active artifacts remain (one base plus nine locales), bounded by the protocol at approximately 90 MB. Five successive synthetic nine-locale editions each retained exactly ten artifacts after pruning. This verifies the retention rule, not months of real usage or a global hard disk quota: pending leases/journals or filesystem errors can retain older files, and the index, catalog projection and personal stores are additional. Image-cache cleanup remains independent.

`Library.syncState` exposes idle, checking, downloading, installing, current and failed states. Discover retains update progress and retry. Detail separately tracks its requested language: current content stays visible and usable until success, failure offers retry, and Original cancels its request. Request identities guard progress and installation; an already-cancelled caller entering late cannot cancel a newer request. Successful explicit installation also supersedes older downloads, including those with unchanged source text but different availability. Failed explicit installation leaves the existing request owned and completable. The older 68-item-cache creator-entry fix remains in place.

The server retains v1 for older clients. This build reads v2, can migrate a legacy local catalog and personal stores, and rejects a later v1 install after v2 activation. The initial production bootstrap preserved the old v1 pointer and full catalog. A subsequent daily replay exposed a legacy trim/identity collision; PR40 fixes it with the `edition-v2-` namespace and is installed as runtime `1791804467868158000`. Recovery after a network interruption published `edition-v2-d8f7fc6af6de6061` to both channels, left v1 unfrozen and cleared the pending intent. The next ordinary run also exited 0 with `published: true`, the same version and all 346 items. Required-v2 live checks pass checksum, capacity, GET/304, Range, HEAD, all nine packs and full reassembly. The initial unchanged-v1 claim is historical, not the current pointer state. See the [protocol record](../docs/content-protocol-v2.md) for evidence.

Content favorites, creator bookmarks and editor drafts use independent atomic files. The active language index and catalog join their identity/removal migrations in one rollback journal; late failures restore prior bytes, and launch recovers the journal before reading personal data. A failed rollback retains the journal and blocks mutations and offline-media cleanup. Stale details cannot re-save explicitly removed items. Favorite enrichment requires the full source fingerprint: title, summary, prompt, example, preview label and cover text/eyebrow must agree. A change preserves the entire old snapshot. Matching snapshots retain earlier downloaded translations while they remain advertised, merge newly verified ones, and remove explicitly revoked languages. Reload after an unreadable favorites file follows the same policy. Original and language-specific drafts use `id` and `id::locale`, remain byte-for-byte unchanged by downloads, and are removed together only for explicitly removed item IDs in a successful transaction.

Community images use bounded memory/disk caches. Saved cover thumbnails and creator avatars are retained separately in Application Support and survive browsing-cache cleanup. Retention is the union of content-favorite covers, their creator avatars and bookmarked-creator avatars; unreadable favorite stores prevent destructive cleanup. Failed retained-image downloads have a retry action in Favorites. Videos are not downloaded for offline playback. There is no account, tracking or generation service; drafts and recent searches stay local.

Catalog-origin details resolve the current item; Favorites-origin details preserve the saved source. Un-saving an open detail still applies matching current availability, so its old navigation snapshot cannot resurrect a revoked language or discard a newly downloaded one. The editor captures its Prompt and effective language when opened; later installs cannot change its baseline or draft identity. Drafts save atomically after a short debounce, on dismissal and when the app backgrounds; restoring the captured language requires confirmation. Detail selection applies to displayed text, editing, copying and sharing. Collapsing a long body does not truncate copied or shared text.

## Development fixtures and checks

Run only `PrompixTests` for deterministic model validation. `GlobalDiscoveryTests` covers creator identity and persistence, locale matching and fallback, Skill/type filtering, independent language drafts, favorite enrichment and offline avatar retention, including write-failure and corrupt-store recovery. UI tests include offline journeys, creator/Skill/localization flows and explicitly selected live community image/video tests; live tests require the content service. Use fresh result bundles and keep Xcode/simulator runs serialized.

The final model run, `~/.local/share/prompix/native-language-downloads/model-tests-6.xcresult`, passed 148 tests with zero failures, zero skips, empty runtime warnings and xcodebuild exit 0. Original synthetic fixtures and isolated URLProtocol sessions cover same-version downloads, offline reuse, stale-request ownership, explicit-install races, availability revocation, every transaction stage, real journal replay, unchanged refresh and pruning leases/file boundaries. A new regression verifies that selecting cached Japanese succeeds with zero requests when the preferred pack is missing and all network access would fail. A test-only MainActor semaphore warning and stalled diagnostic collector in the earlier 147-test run were resolved by nonblocking fixture waits; the latest summary is `model-tests-6-summary.json`.

`release-language-performance.xcresult` passed two Release tests in 136.003 seconds with exit 0 on the dedicated iPhone 18 Pro / iOS 27 simulator. The 346-item `edition-9dfa3763da42be10` catalog had its English pack fully cached. Five process launches measured 3.602329, 3.537746, 3.594224, 3.720082 and 3.663645 seconds (mean 3.624). Three scrolling rounds averaged 135,465.600 kB peak memory (about 135.47 MB), 6.207 seconds CPU and 17.781 seconds clock time, including XCTest gestures and accessibility queries. OS, file and media caches were retained; these are not cold-boot, FPS or direct before/after regression measurements. The run preceded the final one-line explicit-locale selection fix, which does not change startup or scrolling. Evidence and summary remain in the same external directory.

Two earlier live simulator UI journeys passed in that external directory: `production-upgrade.xcresult` (one test, 60.55 seconds) verifies the 68-to-346-item upgrade, creators, favorites, original and Japanese drafts, and restart; `language-download-2.xcresult` (one test, 35.50 seconds) downloads Japanese into the same edition from a Chinese-only cache, leaves exactly `zh-Hans` and `ja` in the active index with no English pack, preserves the existing Japanese editor draft, and checks Japanese/Original after cached relaunch. Host clipboard verification matched all 738 UTF-8 bytes of the expected Japanese content (`clipboard-verification.json`). Visual inspection of the upgraded home creator row/count and Japanese detail found no overlap or clipping. These runs preceded pruning. A separate English-interface draft-isolation run passed in 34.04 seconds (`english-draft-isolation.xcresult`).

After all fixes, `final-language-ui.xcresult` passed one test in 33.416 seconds with exit 0 and no runtime warnings against current production `edition-v2-d8f7fc6af6de6061`. The verification JSON confirms Chinese-only to Chinese/Japanese, exactly three active artifacts totaling 2,435,000 bytes, no English pack or old-edition artifacts, unchanged draft bytes, the same 738-byte Japanese clipboard hash, and cached-relaunch Original/Japanese/editor behavior. The dedicated simulator's original App Support snapshot was then restored with all nine file hashes matching; the post-test state was backed up separately (`acceptance-fixture-restored.json`). No user phone was touched. Physical-device acceptance remains separate.

The `--offline` launch argument uses the bundled edition for deterministic UI fixtures. The `studio-005` fallback contains 30 original text, image and website prompts with nine validated content locales. Video examples arrive with the first successful content update; the offline Video channel explains this and offers update and browse actions. Existing downloaded editions, saved snapshots and drafts are preserved. The simulator-only `--cached-only` argument prevents refresh from replacing a staged, validated local catalog with the public edition; it does not bypass catalog validation or create fixture content. Keep third-party staged catalogs and media outside the repository.

First-party assets:

- `catalog.json`: original Prompix prompts and editorial example text, CC0-1.0.
- `citrus` and `lake`: images generated for the two corresponding prompts; explicitly labeled AI output.
- `studio-paper-forms`, `studio-object-poster`, `studio-quiet-book` and `studio-color-memory`: generated template examples with their substituted input recorded in the catalog. Exact generation prompts and the built-in tool provenance are in `scripts/original-image-examples.json`.
- Text/abstract/web covers: original SwiftUI illustrations, explicitly labeled editorial concepts.
- `WebExamples/`: six original, functional portfolio/studio/recipe/travel/timer/gallery artifacts. All illustrations are original CSS/SVG; no third-party scripts, tracking or remote assets. Native cards use real WebKit screenshots of these artifacts.

The release catalog must not silently replace editorial studies with unverified model-result claims. Third-party datasets/media stay outside the repository.

The editor prevents interactive dismissal while changes are unsaved. A failed write keeps the current text visible and offers retry or an explicit choice to copy and leave, discard and leave, or keep editing. Leaving without saving preserves the last successful draft and stops pending lifecycle saves. Catalog transport tests use isolated injected sessions to verify offline, timeout and checksum-failure recovery, cancellation and retry eligibility, bounded chunk progress, compressed and dishonest lengths, and a creatorless 68-item cache upgrading to 345 synthetic items while preserving personal data. These tests do not modify global networking or the deployed API.

`testDraftWriteFailureKeepsBufferUntilExplicitExit` is an opt-in simulator test. Pass `PROMPIX_DRAFT_FIXTURE_CONTAINER` to the test runner with the simulator's Prompix data-container path; it verifies the running simulator and app metadata before temporarily introducing a write collision. Back up the draft file outside the simulator first and restore it in the host runner's cleanup even if XCTest aborts. The test also registers teardown restoration. Compare its expected clipboard attachment with `simctl pbpaste` for that simulator; reading the clipboard from the test-runner app can be denied by iOS and is not proof of a copy failure. Never run this fixture against a physical device.

`testVoiceOverDetailEditorAndSavedRoundTrip` records actual speech on Xcode 27 / iOS 27 and uses targeted synthetic double-taps to activate spoken controls; it does not replace physical VoiceOver gesture acceptance. Long-draft persistence runs separately from visible-keyboard layout: opt into `testVisibleSoftwareKeyboardLongDraftLayout` with `PROMPIX_VISIBLE_SOFTWARE_KEYBOARD=1` only when the simulator draws an interactive software keyboard. `testReducedMotionImageZoomAndReturn` requires the simulator's Reduce Motion setting to be enabled. Restore simulator settings after these checks.

For the largest-text recovery layout, set the simulator to its largest accessibility content size and add `PROMPIX_DRAFT_LAYOUT_ONLY=1` to the write-collision fixture. It checks the editor's visible area above the fixed Copy footer and scrolls the bounded status area to activate recovery controls. Keep the same external backup and cleanup requirements, and inspect the screenshots rather than relying only on element existence.

A first-party procedural MP4 remains only in `PrompixTests/Resources/playback-fixture.mp4` for AVPlayer recovery tests. It is not bundled in the app or listed as a prompt example. The live UI test still verifies remote community video playback.

All six first-party image prompts have real generated examples in `studio-005`.
The publisher also mirrors these images to the content API, allowing older
installations to display newly added art. New builds prefer the bundled original
when available; additional community gallery pages remain remote.

## Interface languages

The native interface follows the system or app-specific language setting in iOS Settings. UI resources cover nine locales: English (`en`), Simplified Chinese (`zh-Hans`), Traditional Chinese (`zh-Hant`), Japanese (`ja`), Korean (`ko`), Spanish (`es`), Brazilian Portuguese (`pt-BR`), French (`fr`) and German (`de`). Chinese script identifiers take precedence over regions; without an explicit script, Taiwan, Hong Kong and Macao select Traditional Chinese. Portuguese variants use `pt-BR`.

Prompt source fields remain intact. Detail offers Original plus downloaded or advertised downloadable languages, identifies AI translations, and uses the source when a requested translation is unavailable or unsupported. Pending or failed downloads keep the previous displayed language; no unrelated translation or implicit English pack is substituted. The global preference remains the iOS App language, with no separate in-app language setting. Names, code, placeholders, parameters and URLs must remain usable. Bundled website artifacts retain their original content. The published edition and 30-item offline bundle include all nine content locales. Translation validation and agent review do not constitute professional native-speaker proofreading.

UI translations live in `Prompix/Resources/Localizable.xcstrings`. Keep identifiers stable and localize only their displayed labels so filtering remains consistent. From the repository root, run `python3 scripts/check-localizations.py` for coverage, translated states, placeholders and plurals. This resource check does not replace runtime checks for untranslated metadata, long labels or layout. See [translation operations](../docs/translation-operations.md) for the separately budgeted, cached content pipeline and [localization QA](../docs/localization-qa.md) for current evidence.

## Privacy and submission

`Resources/PrivacyInfo.xcprivacy` is bundled with the app. It declares no tracking and describes operational request data retained by the content service; it does not claim that local drafts or searches are uploaded. Required-reason API declarations must reflect actual code use. Store metadata, review instructions and the final submission checklist are in [App Store preparation](../docs/app-store.md).

Performance checks are explicitly selected UI tests: `testRepeatedLaunchPerformance`
and `testScrollingResourcePerformance`. Run with `-configuration Release
ENABLE_TESTABILITY=YES`. Use a simulator for development; record those results
separately from any later physical-device run with your signing team. The current
0.3.2 assignment requires simulator evidence only; do not install on a user device
without a subsequent request.
The launch test terminates and relaunches the process five times; it does not clear
OS caches. The scroll test measures CPU and memory over three passes through the
bundled offline catalog. These provide a repeatable baseline, not a substitute for
live-image/network, video, thermal, or long-session measurements. Save each run to
a new result bundle and report the actual metric values and device conditions.

Live release journeys are explicitly selected: `testLiveFiveScreenBrowsingPreservesReturnPosition`
checks five consecutive screens and return positions, while
`testExpandedLibraryBrowsingAndSearch` requires at least 100 distinct, actually
visible cards, checks return positions, and searches/copies newly reviewed text.
`testEveryPublishedVideoPlaysAndBackgroundPauses` reads the published inventory and
requires each video playback clock to advance. Keep the content edition unchanged
during the latter run. `testShareCancellationKeepsDetailUsable` and
`testCopiedPromptCanOpenExternalToolAndReturn` cover cancellation and external-tool
return; opening Safari is not proof of tool login, prompt prefill or generation.
Native tab selection supports both the iPhone bottom bar and iPad floating tabs.

## Production upgrade and complete-catalog performance

`GlobalDiscoveryUITests/testProductionCatalogUpgradePreservesSavedContentAndDrafts`
is opt-in with `PROMPIX_PRODUCTION_UPGRADE_TEST=1`. Back up the dedicated simulator
app data, then stage the external creatorless 68-item catalog, a saved prompt still
present in production (for example `gentle-tarot`), and a nonempty edited original
draft. Additional language drafts exercise preservation of the whole draft store.
Pass `PROMPIX_ACCEPTANCE_CONTAINER` with that simulator's explicit App data-container
path. The test validates the simulator UUID and bundle metadata, and re-resolves
the container after each launch because XCTest may change its UUID on reinstall.
It uses the real production endpoint, observes available update stages, opens a
downloaded creator, verifies saved source text and all drafts, and repeats the
checks after a cached restart. It does not fake a slow network or guarantee that a
fast transfer renders every intermediate progress stage.

After a complete translated catalog is present, opt into
`testTranslatedCatalogBrowsingPerformance` and
`testTranslatedCatalogProcessLaunchPerformance` with
`PROMPIX_FULL_CATALOG_PERFORMANCE=1` and the same explicit container variable.
Run the Release build with testability enabled. The first probe records three
rounds of viewport drags and confirms that different real cards become visible;
CPU and clock values include XCTest gestures and accessibility queries, not FPS.
The second measures five process launches until responsive, without clearing OS
or filesystem caches. Both require more than 68 items and complete English prompt
translations; the small bundled catalog cannot satisfy these gates.

Supply these variables through the UI test runner environment (for example an
external `.xctestrun` file). Keep fixtures, screenshots, logs and result bundles
outside Git. Restore the simulator data and settings after acceptance work; never
stage these fixtures in a user's physical-device container.

`LanguagePackCatalog` now validates the v2 download path. Its shared original
fixture in `PrompixTests/Resources/language-pack-fixture.json` is also verified by
TypeScript. It checks immutable descriptors, exact locale coverage, complete
source fingerprints, intact UTF-8 text and byte limits before producing the
existing `Catalog` model. An earlier external native harness reconstructed all
346 items and 3,114 translations byte-for-byte; that pure-codec evidence is
separate from the Library/pruning integration runs and the passing live UI journeys.
See the [protocol migration record](../docs/content-protocol-v2.md) for evidence
and the remaining physical-device acceptance.
