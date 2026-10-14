# Prompix for iOS

Integrated candidate **0.7.0 (31)** uses bounded v3 card pages, server search and browse metadata, revision-bound details/languages, creator pagination and bounded offline caches. Personal favorites and drafts stay local. The existing v2 cache remains an offline fallback and is no longer downloaded on ordinary launches. See [database acceptance](../docs/database-feed-v3.md) and [operations](../docs/database-operations.md). The 0.6.6 onboarding and use-panel changes are included; this task does not install on physical phones.

Previous simulator candidate **0.6.5 (29)** refines discovery's feathered top chrome and edge-to-edge media previews. The user's iPhone Air remains on **0.6.4 (28)**. See the latest validation section in [the reading implementation record](../docs/immersive-reading-0.6.0.md). Earlier release records below remain historical.

Native SwiftUI app, iOS 17+. Current simulator candidate **0.6.0 (23)** adds a dedicated Search destination and immersive Markdown reading. See [implementation, reference research and scoped validation](../docs/immersive-reading-0.6.0.md). The user's iPhone Air remains on the successfully installed **0.5.1 (22)**. Further Duo work is deferred while ordinary iPhone acceptance takes priority.

Production v2 edition `edition-v2-3f5988eec9fb6296` contains **527 items, 70 Skills and 242 creator identities**. English records cover 526 items and Simplified Chinese 514, with original-text fallback elsewhere. Source review withheld one Expo Skill whose version-check instructions included a publishing command. The Duo simulator has received the actual 528-to-527 update; one newly translated Skill was opened and its full 5,494-byte copied text matched publication. Personal files remained byte-identical. This focused update check does not extend the earlier 465-item posture/UI evidence to every new item. The last ten-Skill batch has passed publication and focused simulator checks; other seven-language coverage and test boundaries are recorded in [content operations](../docs/content-operations.md#2026-10-13十个作者-skill-发布与客户端验收收尾). Routine collection and translation now remain with the scheduler while development focuses on native browsing, editing, use and iPhone Duo adaptation. Duo posture, editing, selected accessibility checks and final normal-phone regression have run; the evidence separates passed paths from known limits. See the [Duo evidence and remaining gates](../docs/iphone-duo.md).

The app retains documented website prefill links, mobile Claude Code handoff for pinned Skill commands, original X posts, verified creator links and copy/share fallback. Reply workflows separately attribute the instruction post, ancestor context and media owner; the shared strict codec validates the entire chain. Remotion video workflows show desktop prerequisites and copy/share actions. See the [independent pipeline](../docs/independent-pipeline.md) for source and language coverage.

Version 0.3.3 (10) refines discovery density, pinned kind navigation, compact creator discovery, native card context menus and motion-aware detail transitions. See the [visual review](../docs/design-polish-2026-10.md). It has not been signed or installed on a user device.

Version 0.3.2 (9) adds original-base and on-demand language downloads, transactional cache activation, and detail language download/retry controls while retaining the [Granola-inspired paper design](../docs/design-granola-2026-10.md). All 148 model tests pass cleanly; production-upgrade UI, Release performance and the final current-production language UI run after all fixes also pass in the simulator. Production recovery and the following normal daily replay both exited successfully; v1 and v2 now share `edition-v2-d8f7fc6af6de6061`, with 346 items and nine locales. Inactive artifact pruning is verified across synthetic editions and the actual new edition. That stage's signed candidate was 0.3.2 (9), from commit `8118eeb`; its archive and exported IPA passed independent local strict-signature and resource audits. See the [binary evidence](../docs/quality-release.md). Version 0.3.0 was previously installed on the user's requested test phone, and this iteration has not been installed there. See [release goals](../docs/next-release.md) for remaining gates.

Open `Prompix.xcodeproj`, choose the Prompix scheme, then run on an iPhone simulator. No third-party Swift dependencies. The app downloads verified editions from api.prompix.dev while cached or bundled content remains browsable. Once v2 is installed, its same-edition committed projection can retain usable content when an artifact is damaged; it does not silently rewind to an older bundle.

```sh
xcodebuild -project ios/Prompix.xcodeproj -scheme Prompix \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  test -only-testing:PrompixTests CODE_SIGNING_ALLOWED=NO
```

Use a simulator name available on your Mac (`xcrun simctl list devices available`). The project is committed. If adding source/resource files, regenerate with `ruby scripts/generate-project.rb` from the repository root; this requires the `xcodeproj` gem. No personal signing team is committed: choose your own team in Xcode or pass `DEVELOPMENT_TEAM` locally.

## Native discovery and use

The app includes text, image, video and website Prompts, plus a separate Skill channel. Discovery shows a horizontally scrollable creator directory preview, purpose-based collections, then one continuous masonry stream. Splitting that stream around a collection section previously left a tall blank area beneath the shorter column. Accessibility sizes and VoiceOver retain the expanded creator entry. Kind navigation stays pinned, and changing filters returns to the first result. Applying a filter hides the discovery modules and shows the result count and clear action; model and purpose filters use native menus. Search includes content, creator results and clearable local recent searches. Native TabView uses SF Symbols rendered into equal optical template boxes for Discover, Collections and Favorites, avoiding forced filled variants on iOS 27. Card context menus support copying and saving; iOS 18+ detail navigation uses the system zoom transition unless Reduce Motion is enabled.

Creator cards open a searchable directory or profile with source identity, real avatar, collected works, biography when available and an external profile link. The unfiltered Discover page retains the creator heading and directory entry even when the loaded cache has no structured creator metadata; its empty state explains the update requirement and offers a retry. Missing avatars use initials. Creator bookmarks are local and independent from content bookmarks. A profile’s count describes items in this catalog, not followers or external popularity. Content cards open the detail directly, with separate creator and bookmark actions. Text and Skill details prioritize reading without a decorative media hero; genuine image, video and website previews retain their media controls.

Skills show their full SKILL.md, source directory pinned to a commit, checked file paths and installation guidance. Users can read, edit, copy, share and save them, then open the source instructions; the phone does not install or execute the Skill. Source ingestion and identity rules are documented in [creators and Skills](../docs/creators-and-skills.md).

The main interface, navigation, search, editor and app controls are native. Images use UIScrollView zoom; on iOS 18+ their full-screen preview uses the system interactive zoom return, disabled while the image is enlarged. iOS 17 and Reduce Motion retain downward dismissal without the source zoom. Video uses AVKit, with explicit playback and background/close pausing. WebKit is used only to preview six bundled first-party website artifacts. JavaScript is enabled for these allowlisted local files, with an ephemeral data store, bounded file navigation and a Content Security Policy blocking network requests. External user-activated HTTPS/mailto links open through the system. The website preview state is scoped to that preview environment.

Prompt grids derive two or four columns from their own measured container width, including inside a detail pane. Four columns require at least 760 points. On iOS 27.1, a division-region gutter is used only when at least 148 points remain on each side; a four-column layout additionally requires 302 points on each side of that region. Accessibility text sizes or VoiceOver switch the feed to a single ordered column. Native controls, multiline identity labels and vertical metadata layouts accommodate larger text; visual and spoken-flow acceptance still requires actual simulator checks.

On iOS 27.1, details with media use a horizontal `ArrangementView`: the primary pane contains reading content and a compact preview entry, while the secondary pane contains the larger media preview. The system adapts the arrangement to available space within the existing navigation stack. Detail Edit, Copy and Use actions use a native `.bottomBar` toolbar. The editor's Copy action now uses `.primaryAction`, replacing its interim bottom-toolbar placement, and Share lives in the editing-options menu. Earlier OS versions retain the single-scroll detail and safe-area action bars.

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

`StablePromptEditor` keeps the editing task stable while the default `TextEditor(text:)` manages selection and marked input. Its focus binding now comes from the parent editor, which dismisses the keyboard when the user explicitly chooses to leave before showing the unsaved-changes confirmation; the final largest-text, Pinyin-keyboard, failed-write and Continue Editing path passed without manual intervention in `concise-alert-final.xcresult`. An earlier explicit `TextSelection` binding lost text during Pinyin input; removing only that parameter restored the complete buffer. There is no selection binding, UIKit wrapper or iOS 18 branch, and iOS 17 support and the draft store remain intact. Manual Duo testing preserved a selected word across closed/open/partial/rotation states, replaced it using the software keyboard and committed the Chinese candidate. See the [scoped input evidence](../docs/iphone-duo.md#本轮实跑与必要修改).

The final build retained the selected range through posture changes and correctly replaced it with software-keyboard input. A later open-to-closed transition ended uncommitted Pinyin candidates while retaining all 19 text characters. A small leaf-owned-focus experiment did not establish improvement and was reverted. This is a reproduced candidate limitation, not a confirmed Apple runtime defect; the earlier successful composition trace does not establish universal continuity.

## Development fixtures and checks

Run only `PrompixTests` for deterministic model validation. `GlobalDiscoveryTests` covers creator identity and persistence, locale matching and fallback, Skill/type filtering, independent language drafts, favorite enrichment and offline avatar retention, including write-failure and corrupt-store recovery. UI tests include offline journeys, creator/Skill/localization flows and explicitly selected live community image/video tests; live tests require the content service. Use fresh result bundles and keep Xcode/simulator runs serialized.

On Duo / iOS 27.1, nine-language UI assertions passed in 281.445 seconds, Reduce Motion image zoom/return passed in 26.252 seconds with the runtime flag enabled, discovery VoiceOver traversal passed in 91.796 seconds, and Skill handoff VoiceOver traversal passed in 34.787 seconds. Discovery reached Search and Settings at spoken entries 139 and 140; this establishes reachability, not an efficient order. Earlier failures remain separate. All 27 initial language screenshots captured inactive display 0 and are black, so they are not visual evidence. Final active-display screenshots for all nine home screens were subsequently captured and visually checked in `final-validation/delivery-languages/`; they do not establish all nine detail screens or full-catalog translation coverage. The cancellation fixture's display-0/popover-display-3 mismatch was corrected with a window anchor and successfully rerun.

The earlier largest-text recovery check passed in 30.286 seconds. All six Chinese/German/Japanese website and Skill handoff paths completed their UI actions and accessibility audits, but the final raw-favorites comparison failed after legitimate German/Japanese translation refreshes added 100 bytes. IDs, order and saved source fields were unchanged, as were all 541 draft bytes. The test now checks personal-data semantic invariants; the final six-path rerun passed in `handoff-geometry-final.xcresult`. The final concise native alert also passed with all three actions visible and the full buffer retained; the earlier failed and interrupted runs remain separate. Final normal-phone regression passed in 41.629 seconds, with all three personal files restored byte-for-byte. See the [Duo record](../docs/iphone-duo.md#辅助功能语言与性能的阶段证据).

Manual media checks on commit `174b751` retained gallery page 2/4 through folding, supported double-tap zoom and returned to the same detail. A real video advanced, survived posture changes, remained paused after a Home/return round trip, resumed on explicit play and returned to its title; the existing WKWebView interaction check also remains valid. A separate browsing journey retained Japanese content and bookmark state through posture changes, returned to the seven-item Website channel, and preserved the “网站” search plus Website filter with six results through folding and rotation. These continuity claims come from the operation record, not the screenshots alone; they cover the recorded items and paths. Details are in [manual media and state acceptance](../docs/iphone-duo.md#媒体与浏览状态的手工验收). The candidate App/test hashes are recorded in `final-validation/delivery-build-identity.json`; results and known limits are summarized in the Duo record.

The Duo Debug launch check used `--offline` and the 30-item bundle: five launches averaged 4.866 seconds with 3.722% relative standard deviation. It is not a Release, hardware, cold-boot or 465-item production measurement. Raw values and `final-validation/voiceover-launch-summary.json` are recorded in the Duo evidence; do not combine this result with the older Release measurements below.

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

For the largest-text recovery layout, set the simulator to its largest accessibility content size and add `PROMPIX_DRAFT_LAYOUT_ONLY=1` to the write-collision fixture. It checks that the editor remains hittable with at least one full preferred-body text line inside its window and clear of the visible keyboard, then scrolls the bounded status area to activate recovery controls. The Copy control's frame is diagnostic only: a native toolbar may place it beside the editor, so it does not define the editor's bottom edge. Keep the same external backup and cleanup requirements, and inspect the screenshots rather than relying only on element existence.

`testPublishedEditorialBatch` accepts `PROMPIX_EDITORIAL_ACCEPTANCE_IDS` (comma-separated reviewed item IDs) and the same `PROMPIX_ACCEPTANCE_CONTAINER` simulator guard. It downloads the live edition, searches each item's published title, checks detail/copy/use actions, inspects Skill files and installation-copy feedback, and compares the personal stores before and after. Capture the final simulator clipboard from the host and compare it with the expected original text or pinned command; the test alone does not assert clipboard bytes or execution in a target app. Keep live content and screenshots outside Git.

`testPublishedTranslationCatchUp` accepts `PROMPIX_TRANSLATION_ACCEPTANCE_IDS`, an exact `PROMPIX_TRANSLATION_ACCEPTANCE_VERSION`, and the same container guard. Choose items without existing drafts and back up personal files first. The test checks each item's Chinese and English selection, complete editor body, copy feedback, cached restart and downloaded-pack availability. Drafts and creator bookmarks must remain byte-for-byte unchanged; favorites retain identity, ordering and source fields, while their cached translations may update only to verified published records. Compare the final host clipboard separately. The 465-item edition passed two focused runs on iPhone 18 Pro / iOS 27.0 (24A434): one covered all ten new Skills, and one covered three of them in both languages. These runs do not validate the in-progress 0.4.7 editor changes, Duo layouts, full-catalog translation quality or execution in an external tool.

A first-party procedural MP4 remains only in `PrompixTests/Resources/playback-fixture.mp4` for AVPlayer recovery tests. It is not bundled in the app or listed as a prompt example. The live UI test still verifies remote community video playback.

All six first-party image prompts have real generated examples in `studio-005`.
The publisher also mirrors these images to the content API, allowing older
installations to display newly added art. New builds prefer the bundled original
when available; additional community gallery pages remain remote.

## Interface languages

The native interface follows the system or app-specific language setting in iOS Settings. UI resources cover nine locales: English (`en`), Simplified Chinese (`zh-Hans`), Traditional Chinese (`zh-Hant`), Japanese (`ja`), Korean (`ko`), Spanish (`es`), Brazilian Portuguese (`pt-BR`), French (`fr`) and German (`de`). Chinese script identifiers take precedence over regions; without an explicit script, Taiwan, Hong Kong and Macao select Traditional Chinese. Portuguese variants use `pt-BR`.

Prompt source fields remain intact. Detail offers Original plus downloaded or advertised downloadable languages, identifies AI translations, and uses the source when a requested translation is unavailable or unsupported. Pending or failed downloads keep the previous displayed language; no unrelated translation or implicit English pack is substituted. The global preference remains the iOS App language, with no separate in-app language setting. Names, code, placeholders, parameters and URLs must remain usable. Bundled website artifacts retain their original content. The 30-item offline bundle has complete nine-language content. Production publishes nine language packs, but coverage varies: the current 465-item edition has en 465, zh-Hans 465, zh-Hant 377, ja 376, ko 375, es 375, pt-BR 376, fr 376 and de 377 complete records. A downloadable pack does not imply full-catalog coverage. Translation validation and agent review do not constitute professional native-speaker proofreading.

UI translations live in `Prompix/Resources/Localizable.xcstrings`. Keep identifiers stable and localize only their displayed labels so filtering remains consistent. From the repository root, run `python3 scripts/check-localizations.py` for coverage, translated states, placeholders and plurals. This resource check does not replace runtime checks for untranslated metadata, long labels or layout. See [translation operations](../docs/translation-operations.md) for the separately budgeted, cached content pipeline and [localization QA](../docs/localization-qa.md) for current evidence.

## Privacy and submission

`Resources/PrivacyInfo.xcprivacy` is bundled with the app. It declares no tracking and describes operational request data retained by the content service; drafts and saved history remain local; v3 search terms are sent to the content service to process the current query. The Feed Worker redacts query strings and does not persist search history. Required-reason API declarations must reflect actual code use. Store metadata, review instructions and the final submission checklist are in [App Store preparation](../docs/app-store.md).

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
requires each video playback clock to advance. It uses one continuous App session,
returns from every preview to its detail and preserved search text, then clears the
search for the next item. Process-launch performance is measured separately. Keep
the content edition unchanged during this run. Leave at least 5 GB free on the
system volume: simulator recordings and temporary data use it even when DerivedData
and result bundles live on an external SSD. Failed and interrupted results must be
retained separately from a completed inventory. `testShareCancellationKeepsDetailUsable` and
`testCopiedPromptCanOpenExternalToolAndReturn` cover cancellation and external-tool
return; opening Safari is not proof of tool login, prompt prefill or generation.
Native tab selection supports both the iPhone bottom bar and iPad floating tabs.

Search now owns a NavigationStack inside its dedicated tab on iPhone and iPad. The
global journey helper scopes reveal gestures to the scroll view containing the
target, so drags do not start on the fixed action bar or outside the sheet.
`testPublisherSkillPackages` uses `PROMPIX_PUBLISHER_ACCEPTANCE=1` and the explicit
`PROMPIX_ACCEPTANCE_CONTAINER` for real production refresh; back up personal data
first. The creator journey intentionally changes bookmarks: restore their original
files after testing. Current 345-to-448 iPad upgrade and four portrait flows are
recorded in [release quality](../docs/quality-release.md).

## Cached content during network failure

`GlobalDiscoveryUITests/testCachedNetworkFailureEditingAndLiveRetry` is opt-in with
`TEST_RUNNER_PROMPIX_NETWORK_ACCEPTANCE=1` and the explicit
`TEST_RUNNER_PROMPIX_ACCEPTANCE_CONTAINER`. Use a **Debug simulator build**, with a
backed-up real catalog, language packs, and personal files. Do not stage or run it
on a physical device. The journey temporarily edits the original `gentle-tarot`
draft, verifies it across a failed-network relaunch and live retry, then restores
the original draft file on teardown. Host-side byte comparison and restoration
are still required after a test-runner crash.

The simulator-only `--simulate-network-failure` argument registers a URLProtocol
that rejects HTTP(S) URLSession requests with `notConnectedToInternet`. The test
creates `Library/Caches/prompix-ui-network-restored` in the metadata-verified App
container to stop intercepting requests, then taps the real retry button against
production. A new fault-injected launch clears the marker; teardown removes it.
Neither the argument handling nor the protocol is compiled into Release builds.

This exercises catalog/image URLSession failures and the cached text/edit/use
flow; it is not an OS airplane-mode, AVPlayer, external-App, or slow-link test.
The final clipboard must match the edited text attached by XCTest: detail copy
copies the displayed source, while the **use panel** transfers the saved draft.

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

After staging the actual production catalog and its downloaded language pack,
opt into `testCurrentCatalogBrowsingPerformance` and
`testCurrentCatalogProcessLaunchPerformance`. Supply these runner variables:

- `PROMPIX_FULL_CATALOG_PERFORMANCE=1`
- `PROMPIX_ACCEPTANCE_CONTAINER`: the explicit simulator App data-container path
- `PROMPIX_PERFORMANCE_VERSION`: the exact staged edition identity
- `PROMPIX_PERFORMANCE_COUNT`: its total item count
- `PROMPIX_PERFORMANCE_LOCALE`: the downloaded locale to browse
- `PROMPIX_PERFORMANCE_TRANSLATED_COUNT`: that locale's actual nonempty prompt count

Use `TEST_RUNNER_` prefixes when passing these variables directly to `xcodebuild`.
Run with `-configuration Release ENABLE_TESTABILITY=YES ONLY_ACTIVE_ARCH=YES`.
The probes reject mismatched edition, count, translation coverage or missing
language-pack registration. Partial translation coverage is valid: untranslated
items use the production original-text fallback; never manufacture translations
just to satisfy a performance fixture. The small bundled catalog is rejected.

The first probe records three rounds of viewport drags and confirms that different
real cards become visible; CPU and clock include XCTest gestures and accessibility
queries, not FPS. The second measures five process launches until responsive,
without clearing OS or filesystem caches. Both compare drafts and favorites before
and after measurement, and attach the exact edition, locale and translation scope.

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

Version 0.4.5 adds documented Lovable and Claude Code composer links for website prompts, plus a Code composer action for verified pinned Skill installation commands. Every open retains the complete clipboard text. URL payloads use strict UTF-8 percent encoding and a conservative 8192-byte transport bound; longer text falls back without truncation. No repository, branch or automatic-send parameter is supplied. Nine-language UI guidance distinguishes account prerequisites, prefill and copy fallback. Browser verification is not evidence of installed native Claude behavior; device acceptance remains a release gate.

Current 0.4.5 production-workload Release evidence: 448 items, 376 cached Simplified Chinese translations plus original fallback. Five process launches averaged 3.655 seconds; three scroll rounds averaged 145.79 MB peak physical memory. Both probes passed, with catalog, language index, favorites and drafts byte-identical. This retains OS/file/media caches and is not a cold boot, FPS or device result. See the latest section in [quality evidence](../docs/quality-release.md).

## Handoff accessibility and search relevance

Search ranks exact titles, title terms, creator identity, model/tags, then incidental body matches, preserving editorial ties and all filters. All 165 native model tests pass. The 448-item simulator workload passed six largest-text handoff panels (zh-Hans, de, ja; website and Skill), with hit-region/description audits and expanded payloads. Actual VoiceOver reached the Skill Code action, guidance, disclosure, share and copy-install action without activating external tools. See [quality evidence](../docs/quality-release.md).

Run `GlobalDiscoveryUITests/testHandoffLargestTextAccessibility` with `TEST_RUNNER_PROMPIX_HANDOFF_ACCESSIBILITY=1`, the existing explicit acceptance-container variable, and simulator content size `accessibility-extra-extra-extra-large`. Restore the prior size afterward. Run `testSkillHandoffVoiceOverTraversal` separately at the normal size with the same environment; it requires the iOS 27 SDK/service and disables VoiceOver on exit. These opt-in tests use public entries and preserve drafts/favorites.


## Media recovery acceptance (build 20)

Image galleries keep the saved thumbnail visible while requesting a full-quality
image. The native progress label replaces the retry button during that request;
failure restores the retry action. Status controls leave room for the system
page indicator. Cancelled thumbnail requests cannot overwrite a newer view task.
Video loading follows AVPlayer's transport state: item readiness alone does not
clear buffering, and pausing through native AVKit controls cancels the deadline.
This follows Apple's [transport guidance](https://developer.apple.com/documentation/avfoundation/controlling-the-transport-behavior-of-a-player).

`testRetainedImagePreviewCanRetryAndReturnToPrompt` takes a published multi-image
item ID in `PROMPIX_IMAGE_RECOVERY_ID` plus the existing explicit simulator-container
guard. It saves an offline thumbnail, clears only the image URL cache, then uses
`--simulate-network-failure --simulate-slow-image-failure` to observe progress,
retained-preview retry, an uncached page failure, return/copy and real network
recovery. The image session explicitly installs the Debug simulator protocol;
global URLProtocol registration alone did not intercept that custom session in
the initial run. The optional slow fixture delays media failure by three seconds.
The recovery marker restores real requests. Back up and restore the whole local
Prompix data directory from the host even if an assertion aborts teardown.
Neither fixture flag/protocol is present in Release.

`testRemoteVideoBufferingDeadlineAndSameURLRecovery` requires
`PROMPIX_MEDIA_FIXTURE_URL`, an isolated HTTPS server with a first-party fast-start
MP4 at `/stall.mp4` and test-only `POST /reset` and `/recover` controls. The test
uses a unique query per run, an eight-second test deadline, verifies failure,
restarts the same URL, requires the actual AVPlayer clock to advance, then checks
pause and release. Production retains its 25-second deadline and media allowlist.
The external reproducible fixture and request traces are in
`Prompix-Codex/Evidence/media-recovery-20261013/` on the development SSD; it serves
only the test MP4, withholds data after byte 2578, and is stopped after acceptance.
This is real AVPlayer networking, not the URLProtocol image fixture. Its stalled
startup result does not prove every mid-playback stall or an airplane-mode run.

`testRemoteVideoInterruptionPauseAndSameURLRecovery` is a separate opt-in test for
an already-playing stream. Set `TEST_RUNNER_PROMPIX_INTERRUPTED_MEDIA_FIXTURE_URL`
when invoking xcodebuild; XCTest receives `PROMPIX_INTERRUPTED_MEDIA_FIXTURE_URL`.
The isolated HTTPS fixture must serve `/stall.mp4`, withhold bytes after complete
interleaved audio/video samples at 20 seconds, and keep the incomplete response
open for 60 seconds. `POST /reset` and `/recover` return HTTP 200 with the exact
bodies `stalling` and `ready`; recovery affects subsequent requests. The fixture
must honor byte ranges and advertise the original full requested length.

The test uses a visible AVKit player and increasing decoded-frame timestamps,
pauses for nine seconds past its eight-second deadline, resumes the stalled item,
then retries the same URL and requires decoded frames beyond 20.6 seconds. This
does not change the production 25-second deadline. A clock that advances without
decoded frames, shortened Content-Range responses, and startup failures do not
satisfy this test. It skips in CI unless explicitly configured. Use a dedicated
simulator, preserve its personal files, and stop the isolated fixture/tunnel
after the run. The first-party media, server, exact commands and failed/passing
evidence are retained outside Git at
`Prompix-Codex/Evidence/video-interleaved-20261013/` on the development SSD.

### Prepared-text save failure

`PromptUseSheet` prevents interactive dismissal while a prepared variable result has failed to save. Done offers the existing native copy-and-leave, discard-and-leave and continue-editing choices; copying uses the complete in-memory result. The parent editor remains unchanged until an explicit return to editing or successful save.

The three `testPreparedVariables…AfterFailedSave` / `testPreparedVariablesSurviveFailedSaveAndReturnToEditor` journeys in `GlobalDiscoveryUITests` share the guarded production-cache fixture. Set `PROMPIX_VARIABLE_ACCEPTANCE=1` and `PROMPIX_ACCEPTANCE_CONTAINER`, use a separate backed-up simulator, and restore its personal files after any interruption. The copy test attaches the expected buffer; compare host `simctl pbpaste` bytes independently. These tests must not replace the user's running acceptance build.


### iPhone welcome and Cosmos visual acceptance (0.5.0)

`OnboardingTests` covers skip, forward/back, completion persistence, Settings replay and English/German layout. The Debug simulator-only `--reset-onboarding` argument removes only the welcome-completion preference; it never clears content, favorites or drafts. Existing journeys call `launchPrompix()` to begin in discovery. Use `simctl ui <dedicated-device> content_size accessibility-extra-extra-extra-large` and `appearance dark` for the stress-layout pass, then restore `large` / `light`. The welcome body scrolls independently of its actions; decorative artwork is omitted at accessibility sizes.

`python3 scripts/check-localizations.py` checks every `.xcstrings` catalog by default, including the new Onboarding table. Actual evidence, scope and limitations are recorded in [the iPhone visual review](../docs/design-cosmos-iphone.md).

## Database acceptance tests

`DatabaseFeedUITests` uses a new UUID under the dedicated simulator app's Caches/FeedAcceptance directory. Four deterministic journeys use 10,000 first-party records; two live journeys require `TEST_RUNNER_PROMPIX_DATABASE_LIVE_UI=1` on xcodebuild. Native live API coverage similarly requires `TEST_RUNNER_PROMPIX_LIVE_FEED=1`. The prefix passes settings into the test runner; a plain host variable does not. No paid ingestion or production writes occur. Keep `-parallel-testing-enabled NO` for these serial simulator journeys.

The opt-in legacy journey actually downloads v2 using retained legacy code, creates a favorite/draft, and reopens the same isolated directory using v3. It verifies exact personal-file preservation, not a physical-device binary upgrade. The copy journey saves expected UTF-8 text inside that namespace; validate the actual simulator clipboard from the host with `simctl pbpaste` because iOS may deny clipboard reads from XCTest's separate runner. Release builds exclude simulator service fixtures and isolated launch modes.
