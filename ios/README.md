# Prompix for iOS

Native SwiftUI app, iOS 17+. Version 0.3.0 added creator discovery, Agent Skills and internationalization to the four Prompt kinds and was installed on the user's requested test phone. The current 0.3.1 work adopts the [Granola-inspired paper design](../docs/design-granola-2026-10.md), keeps the unfiltered Discover page's creator entry visible with an older cache, and makes catalog updates observable and retryable. Validate this iteration in the simulator; a further phone installation requires a user request. The published edition contains 345 items in all nine content locales. See [release goals](../docs/next-release.md) for remaining gates.

Open `Prompix.xcodeproj`, choose the Prompix scheme, then run on an iPhone simulator. No third-party Swift dependencies. The app downloads verified editions from api.prompix.dev and falls back to bundled content offline.

```sh
xcodebuild -project ios/Prompix.xcodeproj -scheme Prompix \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  test -only-testing:PrompixTests CODE_SIGNING_ALLOWED=NO
```

Use a simulator name available on your Mac (`xcrun simctl list devices available`). The project is committed. If adding source/resource files, regenerate with `ruby scripts/generate-project.rb` from the repository root; this requires the `xcodeproj` gem. No personal signing team is committed: choose your own team in Xcode or pass `DEVELOPMENT_TEAM` locally.

## Native discovery and use

The app includes text, image, video and website Prompts, plus a separate Skill channel. Discovery combines real creators, purpose-based collections and the complete content stream. Applying a filter hides the discovery modules and shows the result count and clear action; model and purpose filters use native menus. Search includes content, creator results and clearable local recent searches. Native TabView uses SF Symbols for Discover, Collections and Favorites.

Creator cards open a searchable directory or profile with source identity, real avatar, collected works, biography when available and an external profile link. The unfiltered Discover page retains the creator heading and directory entry even when the loaded cache has no structured creator metadata; its empty state explains the update requirement and offers a retry. Missing avatars use initials. Creator bookmarks are local and independent from content bookmarks. A profile’s count describes items in this catalog, not followers or external popularity. Content cards open the detail directly, with separate creator and bookmark actions. Text and Skill details prioritize reading without a decorative media hero; genuine image, video and website previews retain their media controls.

Skills show their full SKILL.md, source directory pinned to a commit, checked file paths and installation guidance. Users can read, edit, copy, share and save them, then open the source instructions; the phone does not install or execute the Skill. Source ingestion and identity rules are documented in [creators and Skills](../docs/creators-and-skills.md).

The main interface, navigation, search, editor and app controls are native. Images use UIScrollView zoom and video uses AVKit, with explicit playback and background/close pausing. WebKit is used only to preview six bundled first-party website artifacts. JavaScript is enabled for these allowlisted local files, with an ephemeral data store, bounded file navigation and a Content Security Policy blocking network requests. External user-activated HTTPS/mailto links open through the system. The website preview state is scoped to that preview environment.

Compact layouts use two content columns and regular-width layouts use three. Accessibility text sizes or VoiceOver switch the feed to a single ordered column. Native controls, multiline identity labels and vertical metadata layouts accommodate larger text; visual and spoken-flow acceptance still requires actual simulator checks.

## Catalog and local persistence

Launch and foreground refresh download a hash-checked remote catalog while the cached or bundled edition remains browsable. Within the running library, successful checks use a 15-minute interval between automatic attempts. After a failed check the interval is 30 seconds from the previous attempt; the next foreground event or non-forced refresh can then try again. This is eligibility for a later trigger, not a timer that automatically retries after 30 seconds. Cancellation clears the attempt timestamp so the next trigger can retry immediately. Pull to refresh and explicit retry actions bypass these intervals; an already-running refresh is never duplicated.

`CatalogSync` uses a task-level `URLSessionDataDelegate` to receive chunks, with `URLRequest.timeoutInterval` set to 60 seconds rather than a deadline for the entire refresh. It rejects invalid HTTP status, non-HTTPS or cross-host responses and redirects, oversize declared lengths, and any chunk that would exceed the accumulated byte cap. The manifest cap is 32,000 bytes and the catalog cap is 10,000,000 bytes. Missing or dishonest Content-Length cannot bypass the cap. Progress updates are coalesced to roughly 100 ms plus start and completion; compressed responses use an unknown total until completion because the delivered chunks are decoded bytes. Hashing, decoding and catalog validation run in a nonisolated async function away from the main actor; the verified result then enters the existing atomic catalog transaction.

`Library.syncState` exposes idle, checking, downloading, installing, current and failed states. The Discover page presents in-progress updates and failures with a retry action; progress from a superseded or cancelled refresh cannot overwrite a newer state. An older 68-item cache without structured creator metadata previously caused the creator section to disappear until a new edition installed. The visible creator entry and update states address this confirmed behavior; per-byte transport overhead alone has not been established as the cause of the phone's observed update delay.

The v1 protocol keeps its four base kinds; optional creator, Skill and localization fields add 0.3.0 capabilities while older clients can still read the original text. A staged catalog in development is separate from the currently published catalog.

Content favorites, creator bookmarks and editor drafts use independent atomic files. A catalog install and its identity/removal migrations commit through one rollback journal; late write failures restore prior bytes, and interrupted transactions recover before the next launch loads state. A failed rollback retains the journal and blocks further mutations and offline-media cleanup until recovery succeeds. Stale details cannot re-save explicitly removed items. Saved items keep snapshots. Current catalog metadata and translations enrich an older favorite only when its original prompt body is exactly unchanged; otherwise the entire saved snapshot remains intact. Original and language-specific drafts remain independent across catalog refreshes and relaunches. Restoring a draft affects only the selected language, and removed item IDs remove all of that item’s draft variants after a successful catalog update. Corrupt stores are retained and block unsafe writes until reloaded successfully.

Community images use bounded memory/disk caches. Saved cover thumbnails and creator avatars are retained separately in Application Support and survive browsing-cache cleanup. Retention is the union of content-favorite covers, their creator avatars and bookmarked-creator avatars; unreadable favorite stores prevent destructive cleanup. Failed retained-image downloads have a retry action in Favorites. Videos are not downloaded for offline playback. There is no account, tracking or generation service; drafts and recent searches stay local.

Editor drafts save atomically after a short debounce, on dismissal and when the app backgrounds; restoring the selected version requires confirmation. The detail language choice applies to displayed text, editing, copying and sharing. Collapsing a long body does not truncate the copied or shared text.

## Development fixtures and checks

Run only `PrompixTests` for deterministic model validation. `GlobalDiscoveryTests` covers creator identity and persistence, locale matching and fallback, Skill/type filtering, independent language drafts, favorite enrichment and offline avatar retention, including write-failure and corrupt-store recovery. UI tests include offline journeys, creator/Skill/localization flows and explicitly selected live community image/video tests; live tests require the content service. Use fresh result bundles and keep Xcode/simulator runs serialized.

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

Prompt source fields remain intact. Detail offers the original and available complete translations, identifies AI translations and falls back to the source when a requested translation is missing or unsupported. It never substitutes an unrelated language’s translation. Names, code, placeholders, parameters and URLs must remain usable. Bundled website artifacts retain their original content. The published edition and 30-item offline bundle include all nine content locales. Translation validation and agent review do not constitute professional native-speaker proofreading.

UI translations live in `Prompix/Resources/Localizable.xcstrings`. Keep identifiers stable and localize only their displayed labels so filtering remains consistent. From the repository root, run `python3 scripts/check-localizations.py` for coverage, translated states, placeholders and plurals. This resource check does not replace runtime checks for untranslated metadata, long labels or layout. See [translation operations](../docs/translation-operations.md) for the separately budgeted, cached content pipeline and [localization QA](../docs/localization-qa.md) for current evidence.

## Privacy and submission

`Resources/PrivacyInfo.xcprivacy` is bundled with the app. It declares no tracking and describes operational request data retained by the content service; it does not claim that local drafts or searches are uploaded. Required-reason API declarations must reflect actual code use. Store metadata, review instructions and the final submission checklist are in [App Store preparation](../docs/app-store.md).

Performance checks are explicitly selected UI tests: `testRepeatedLaunchPerformance`
and `testScrollingResourcePerformance`. Run with `-configuration Release
ENABLE_TESTABILITY=YES`. Use a simulator for development; record those results
separately from any later physical-device run with your signing team. The current
0.3.1 assignment requires simulator evidence only; do not install on a user device
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
