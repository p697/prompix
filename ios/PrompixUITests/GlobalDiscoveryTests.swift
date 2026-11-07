import XCTest
import UIKit
import CryptoKit

/// These opt-in journeys use a staged, validated catalog in the simulator's
/// Application Support directory. They never install or launch on a phone.
@MainActor final class GlobalDiscoveryUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        #if targetEnvironment(simulator)
        app = XCUIApplication()
        #else
        throw XCTSkip("Global discovery acceptance is simulator-only.")
        #endif
    }

    private func launch(_ language: String = "zh-Hans", online: Bool = false) {
        app.launchArguments = ["-AppleLanguages", "(\(language))", "-AppleLocale", language]
        if !online { app.launchArguments.insert("--cached-only", at: 0) }
        app.launchPrompix()
        XCTAssertTrue(app.buttons["discoveryFilters"].waitForExistence(timeout: 10))
    }

    private func capture(_ name: String) {
        for (index, screen) in XCUIScreen.screens.enumerated() {
            let attachment = XCTAttachment(screenshot: screen.screenshot())
            attachment.name = "\(name)-display-\(index)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    private func reveal(_ element: XCUIElement, attempts: Int = 8) {
        for _ in 0..<attempts {
            if ["copyPrompt", "editPromptAction", "copyPrompt"].contains(element.identifier), element.isHittable { return }
            // Search presents a centered sheet on iPad. Whole-display gestures
            // can start on its fixed action bar instead of scrolling the content.
            var viewport: XCUIElement = app
            // Lazy Form rows may not have an accessibility snapshot until scrolled onscreen.
            if element.exists {
                let containingScroll = app.scrollViews.containing(.any, identifier: element.identifier).firstMatch
                if containingScroll.exists { viewport = containingScroll }
            }
            // XCTest can report partially covered controls as hittable. Keep
            // their entire target above the detail screen's fixed action bar.
            let copy = app.buttons["copyPrompt"]
            let top = max(110, viewport.frame.minY + 12)
            let bottom = min(viewport.frame.maxY - 12, copy.exists ? copy.frame.minY - 12 : app.frame.maxY - 100)
            if element.exists && element.frame.minY >= top && element.frame.maxY <= bottom && element.isHittable { return }
            let scrollDown = element.exists && element.frame.minY < top
            let start = viewport.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: scrollDown ? 0.4 : 0.7))
            let end = viewport.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: scrollDown ? 0.7 : 0.4))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        XCTAssertTrue(element.isHittable)
    }

    // Decode only the fields needed for acceptance. Fixture files stay outside
    // the repository, and assertions never print the user's full prompt/draft.
    private struct CatalogSnapshot: Decodable {
        let version: String
        let prompts: [SavedPromptSnapshot]
    }

    private struct SavedPromptSnapshot: Decodable {
        let id: String
        let prompt: String
        let creator: CreatorSnapshot?
        let localization: LocalizationSnapshot?
    }

    private struct CreatorSnapshot: Decodable { let id: String }
    private struct LocalizationSnapshot: Decodable {
        let translations: [String: TranslationSnapshot]
    }
    private struct TranslationSnapshot: Decodable { let prompt: String }
    private struct LanguagePackIndexSnapshot: Decodable {
        let downloadedLocales: [String: String]
    }

    func testFeedMediaAndScrollVisualAcceptance() throws {
        guard ProcessInfo.processInfo.environment["PROMPIX_FEED_VISUAL_ACCEPTANCE"] == "1" else {
            throw XCTSkip("Requires the backed-up published catalog on a dedicated simulator.")
        }
        let catalog = try readSnapshot(CatalogSnapshot.self, from: acceptanceDirectory(), file: "catalog.json")
        let imageID = "x-post-2109653076499902934"
        let videoID = "x-post-2109618758180634959"
        XCTAssertTrue([imageID, videoID].allSatisfy { id in catalog.prompts.contains { $0.id == id } })
        launch()
        capture("feed-01-home")
        func drag(_ from: CGFloat, _ to: CGFloat) {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: from))
                .press(forDuration: 0.01, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: to)))
        }
        for index in 0..<3 {
            drag(0.78, 0.32)
            capture("feed-02-scroll-\(index)")
        }
        XCTAssertFalse(app.buttons["discoveryFilters"].isHittable)
        drag(0.42, 0.58)
        XCTAssertTrue(app.buttons["discoveryFilters"].waitForExistence(timeout: 3))
        capture("feed-03-header-return")
        app.selectPrompixTab("搜索")
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        for (query, id, name) in [("盐水礼服", imageID, "portrait"), ("微型机械师", videoID, "video")] {
            field.tap()
            // Tapping a long accessibility-size query places the caret mid-text.
            // Use the native clear action rather than assuming an end position.
            if field.buttons["清除文本"].exists { field.buttons["清除文本"].tap() }
            field.typeText(query + "\n")
            let card = app.buttons["prompt-\(id)"]
            XCTAssertTrue(card.waitForExistence(timeout: 5))
            capture("feed-04-\(name)-card")
            card.tap()
            XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
            XCTAssertFalse(app.tabBars.buttons["收藏"].isHittable)
            capture("feed-05-\(name)-detail")
            app.goBackInPrompix()
            XCTAssertTrue(card.waitForExistence(timeout: 5))
            XCTAssertTrue(app.tabBars.buttons["收藏"].isHittable)
        }
        app.selectPrompixTab("发现")
    }


    func testProductionLanguageDownloadAndCachedRelaunch() throws {
        guard ProcessInfo.processInfo.environment["PROMPIX_LANGUAGE_PACK_ACCEPTANCE"] == "1" else {
            throw XCTSkip("Stage a production v2 edition containing only Simplified Chinese in the backed-up simulator.")
        }
        var directory = try acceptanceDirectory()
        let before = try readSnapshot(CatalogSnapshot.self, from: directory, file: "catalog.json")
        let index = try readSnapshot(LanguagePackIndexSnapshot.self, from: directory, file: "language-packs.json")
        XCTAssertEqual(Set(index.downloadedLocales.keys), ["zh-Hans"])
        let draftsURL = directory.appendingPathComponent("drafts.json")
        let draftsBefore = try? Data(contentsOf: draftsURL)

        launch()
        app.buttons["kind-text"].tap()
        let card = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-' ")).firstMatch
        reveal(card)
        let id = String(card.identifier.dropFirst("prompt-".count))
        card.tap()
        let menu = app.buttons["contentLanguage"]
        reveal(menu)
        menu.tap()
        let japanese = app.buttons["contentLanguage-ja"]
        XCTAssertTrue(japanese.waitForExistence(timeout: 3))
        japanese.tap()
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            menu.exists && menu.label.contains("日本語")
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 60), .completed)
        XCTAssertFalse(app.otherElements["languageDownloadFailure"].exists)
        directory = try acceptanceDirectory()
        let after = try readSnapshot(CatalogSnapshot.self, from: directory, file: "catalog.json")
        let downloaded = try readSnapshot(LanguagePackIndexSnapshot.self, from: directory, file: "language-packs.json")
        XCTAssertEqual(before.version, after.version, "Selecting another language must work without a new content edition.")
        XCTAssertEqual(Set(downloaded.downloadedLocales.keys), ["zh-Hans", "ja"])
        let expected = try XCTUnwrap(after.prompts.first { $0.id == id }?.localization?.translations["ja"]?.prompt)
        XCTAssertFalse(expected.isEmpty)
        let savedDrafts = draftsBefore.flatMap { try? JSONDecoder().decode([String: String].self, from: $0) } ?? [:]
        let expectedEditor = savedDrafts[id + "::ja"] ?? expected
        let clipboardEvidence = XCTAttachment(string: expected)
        clipboardEvidence.name = "copied-japanese-prompt-expected"
        clipboardEvidence.lifetime = .keepAlways
        add(clipboardEvidence)
        capture("language-pack-01-japanese-downloaded")
        app.buttons["copyPrompt"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].label.contains("已复制"))
        reveal(app.buttons["editPromptAction"])
        app.buttons["editPromptAction"].tap()
        let editor = app.textViews["promptEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertTrue(editor.value as? String == expectedEditor, "The editor must use the selected language's existing draft, or its full translation when no draft exists.")
        capture("language-pack-02-japanese-editor")
        app.navigationBars.buttons["完成"].tap()
        XCTAssertEqual(try? Data(contentsOf: directory.appendingPathComponent("drafts.json")), draftsBefore)
        app.terminate()

        // No automatic refresh on this relaunch. The Japanese pack remains on
        // disk while startup loads only the preferred Simplified Chinese pack.
        launch()
        app.buttons["kind-text"].tap()
        let sameCard = app.buttons["prompt-\(id)"]
        reveal(sameCard)
        sameCard.tap()
        reveal(menu)
        menu.tap()
        app.buttons["contentLanguage-ja"].tap()
        let cachedReady = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            menu.exists && menu.label.contains("日本語")
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [cachedReady], timeout: 10), .completed)
        directory = try acceptanceDirectory()
        let reloaded = try readSnapshot(CatalogSnapshot.self, from: directory, file: "catalog.json")
        XCTAssertTrue(reloaded.prompts.first { $0.id == id }?.localization?.translations["ja"]?.prompt == expected)
        XCTAssertEqual(try? Data(contentsOf: directory.appendingPathComponent("drafts.json")), draftsBefore)
        menu.tap()
        app.buttons["contentLanguage-original"].tap()
        XCTAssertTrue(menu.label.contains("原文"))
        capture("language-pack-03-cached-switch-and-original")
    }

    private func acceptanceDirectory() throws -> URL {
        let environment = ProcessInfo.processInfo.environment
        let path = try XCTUnwrap(environment["PROMPIX_ACCEPTANCE_CONTAINER"], "Pass the explicitly staged simulator app-container path.")
        let simulatorID = try XCTUnwrap(environment["SIMULATOR_UDID"].flatMap { UUID(uuidString: $0) })
        let container = URL(fileURLWithPath: path).standardizedFileURL
        let parent = container.deletingLastPathComponent()
        let expectedSuffix = "/CoreSimulator/Devices/\(simulatorID.uuidString)/data/Containers/Data/Application"
        XCTAssertTrue(parent.path.hasSuffix(expectedSuffix), "Only the explicitly selected running simulator may be inspected.")
        XCTAssertNotNil(UUID(uuidString: container.lastPathComponent))
        guard parent.path.hasSuffix(expectedSuffix), UUID(uuidString: container.lastPathComponent) != nil else {
            throw CocoaError(.fileReadNoPermission)
        }
        // XCTest may reinstall between host-side staging and launch, changing
        // the UUID. Resolve only Prompix within the same explicit simulator.
        let matches = try FileManager.default.contentsOfDirectory(at: parent, includingPropertiesForKeys: nil).filter { candidate in
            guard UUID(uuidString: candidate.lastPathComponent) != nil,
                  let data = try? Data(contentsOf: candidate.appendingPathComponent(".com.apple.mobile_container_manager.metadata.plist")),
                  let fields = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else { return false }
            return fields["MCMMetadataIdentifier"] as? String == "com.p697.prompix"
        }
        XCTAssertEqual(matches.count, 1, "The selected simulator must contain exactly one metadata-verified Prompix container.")
        return try XCTUnwrap(matches.count == 1 ? matches.first : nil)
            .appendingPathComponent("Library/Application Support/Prompix", isDirectory: true)
    }

    private func readSnapshot<T: Decodable>(_ type: T.Type, from directory: URL, file: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(contentsOf: directory.appendingPathComponent(file)))
    }

    func testCachedNetworkFailureEditingAndLiveRetry() throws {
        guard ProcessInfo.processInfo.environment["PROMPIX_NETWORK_ACCEPTANCE"] == "1" else {
            throw XCTSkip("Back up the dedicated simulator's production cache and personal files before this network-failure journey.")
        }
        let directory = try acceptanceDirectory()
        let catalogBytes = try Data(contentsOf: directory.appendingPathComponent("catalog.json"))
        let catalog = try JSONDecoder().decode(CatalogSnapshot.self, from: catalogBytes)
        XCTAssertGreaterThan(catalog.prompts.count, 100, "Exercise a downloaded catalog, not the small bundled fixture.")
        let drafts = try Data(contentsOf: directory.appendingPathComponent("drafts.json"))
        let favorites = try Data(contentsOf: directory.appendingPathComponent("favorites.json"))
        func recoveryURL(_ current: URL) -> URL {
            current.deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("Caches/prompix-ui-network-restored")
        }
        defer {
            app.terminate()
            do {
                let current = try acceptanceDirectory()
                try drafts.write(to: current.appendingPathComponent("drafts.json"), options: .atomic)
                try? FileManager.default.removeItem(at: recoveryURL(current))
                XCTAssertEqual(try Data(contentsOf: current.appendingPathComponent("drafts.json")), drafts)
            } catch { XCTFail("Restore the backed-up simulator draft file after this run: \(error)") }
        }
        func launchWithFailure() {
            app.launchArguments = ["--legacy-feed", "--simulate-network-failure", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh-Hans"]
            app.launchPrompix()
            XCTAssertFalse(app.otherElements["catalogUpdateStatus"].exists)
            app.revealDiscoveryRails()
            XCTAssertTrue(app.buttons["allCreators"].exists)
        }
        func openOriginalEditor() {
            app.buttons["kind-text"].tap()
            let card = app.buttons["prompt-gentle-tarot"]
            reveal(card); card.tap()
            XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
            let language = app.buttons["contentLanguage"]
            if language.exists {
                reveal(language); language.tap(); app.buttons["contentLanguage-original"].tap()
            }
            app.buttons["编辑后使用"].tap()
            XCTAssertTrue(app.textViews["promptEditor"].waitForExistence(timeout: 5))
        }
        launchWithFailure()
        capture("network-01-cached-discovery-with-retry")
        openOriginalEditor()
        let editor = app.textViews["promptEditor"]
        let original = try XCTUnwrap(editor.value as? String)
        XCTAssertFalse(original.isEmpty)
        let marker = " PROMPIX NETWORK ACCEPTANCE CHECK "
        XCTAssertFalse(original.contains(marker))
        editor.tap(); editor.typeText(marker)
        let edited = try XCTUnwrap(editor.value as? String)
        XCTAssertTrue(edited.contains(marker))
        app.navigationBars.buttons["完成"].tap()
        let saved = try readSnapshot([String: String].self, from: try acceptanceDirectory(), file: "drafts.json")
        XCTAssertEqual(saved["gentle-tarot"], edited)
        capture("network-02-edit-saved-without-network")
        app.terminate()
        launchWithFailure()
        openOriginalEditor()
        XCTAssertEqual(editor.value as? String, edited)
        app.buttons["copyEditedPrompt"].tap()
        XCTAssertTrue(app.buttons["copyEditedPrompt"].label.contains("已复制"))
        capture("network-03-reopened-edited-draft")
        app.navigationBars.buttons["完成"].tap()
        app.goBackInPrompix()
        let current = try acceptanceDirectory()
        XCTAssertEqual(try Data(contentsOf: current.appendingPathComponent("catalog.json")), catalogBytes)
        XCTAssertEqual(try Data(contentsOf: current.appendingPathComponent("favorites.json")), favorites)
        // Let the registered protocol defer to URLSession's normal HTTP loader.
        // Retry now reaches the real production manifest and language artifacts.
        try FileManager.default.createDirectory(at: recoveryURL(current).deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("restored".utf8).write(to: recoveryURL(current), options: .atomic)
        app.openPrompixSettings()
        let check = app.buttons["检查内容更新"]
        reveal(check); check.tap()
        XCTAssertTrue(check.waitForExistence(timeout: 90))
        XCTAssertTrue(check.isEnabled)
        XCTAssertFalse(app.staticTexts["内容更新未完成"].exists)
        app.buttons["完成"].tap()
        app.selectPrompixTab("发现")
        XCTAssertTrue(app.buttons["discoveryFilters"].isHittable)
        capture("network-04-live-retry-completed")
        openOriginalEditor()
        XCTAssertEqual(editor.value as? String, edited)
        app.navigationBars.buttons["完成"].tap()
        // Detail copy follows the displayed source. The use panel transfers the
        // saved language-specific draft, which is the edited-content contract.
        app.buttons["copyPrompt"].tap()
        let handoffCopy = app.buttons["copyPrompt"]
        XCTAssertTrue(handoffCopy.waitForExistence(timeout: 5)); handoffCopy.tap()
        XCTAssertTrue(handoffCopy.label.contains("已复制"))
        capture("network-05-edited-content-after-recovery")
        let expected = XCTAttachment(string: edited)
        expected.name = "network-expected-clipboard"; expected.lifetime = .keepAlways; add(expected)
        XCTAssertEqual(try Data(contentsOf: try acceptanceDirectory().appendingPathComponent("favorites.json")), favorites)
    }

    func testRetainedImagePreviewCanRetryAndReturnToPrompt() throws {
        guard let id = ProcessInfo.processInfo.environment["PROMPIX_IMAGE_RECOVERY_ID"] else {
            throw XCTSkip("Requires a backed-up simulator with a published remote image gallery.")
        }
        let before = try acceptanceDirectory()
        let favorites = try Data(contentsOf: before.appendingPathComponent("favorites.json"))
        let drafts = try Data(contentsOf: before.appendingPathComponent("drafts.json"))
        let catalog = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: before.appendingPathComponent("catalog.json"))) as? [String: Any])
        let prompts = try XCTUnwrap(catalog["prompts"] as? [[String: Any]])
        let target = try XCTUnwrap(prompts.first { $0["id"] as? String == id })
        let title = try XCTUnwrap(target["title"] as? String)
        let media = try XCTUnwrap(target["media"] as? [String: Any])
        let url = try XCTUnwrap(media["imageURL"] as? String)
        XCTAssertNil(media["image"])
        XCTAssertGreaterThan((media["imageURLs"] as? [String])?.count ?? 0, 1)
        func recoveryURL(_ directory: URL) -> URL {
            directory.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Caches/prompix-ui-network-restored")
        }
        defer {
            app.terminate()
            do {
                let current = try acceptanceDirectory()
                try favorites.write(to: current.appendingPathComponent("favorites.json"), options: .atomic)
                try? FileManager.default.removeItem(at: recoveryURL(current))
                XCTAssertEqual(try Data(contentsOf: current.appendingPathComponent("drafts.json")), drafts)
            } catch { XCTFail("Restore the simulator backup after this run: \(error)") }
        }
        func preview() -> XCUIElement {
            let compact = app.buttons["compactPreviewButton"]
            return compact.exists ? compact : app.buttons["previewButton"]
        }
        func openTarget() {
            app.selectPrompixTab("搜索")
            let search = app.searchFields.firstMatch
            XCTAssertTrue(search.waitForExistence(timeout: 5)); search.tap(); search.typeText(title)
            let card = app.scrollViews["searchResults"].buttons["prompt-\(id)"]
            reveal(card); card.tap()
            XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
            XCTAssertTrue(preview().waitForExistence(timeout: 5))
        }
        launch()
        openTarget()
        let save = app.buttons["detailFavorite"]
        XCTAssertTrue(save.exists)
        if !save.label.contains("取消") { save.tap() }
        let current = try acceptanceDirectory()
        let hash = SHA256.hash(data: Data(url.utf8)).map { String(format: "%02x", $0) }.joined()
        let thumbnail = current.appendingPathComponent("OfflineImages/\(hash).jpg")
        let retained = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in FileManager.default.fileExists(atPath: thumbnail.path) }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [retained], timeout: 30), .completed)
        app.terminate()
        let cache = current.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Caches/PrompixImages")
        if FileManager.default.fileExists(atPath: cache.path) { try FileManager.default.removeItem(at: cache) }
        app.launchArguments = ["--cached-only", "--simulate-network-failure", "--simulate-slow-image-failure", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh-Hans"]
        app.launchPrompix()
        XCTAssertTrue(app.buttons["discoveryFilters"].waitForExistence(timeout: 10))
        openTarget()
        preview().tap()
        let retry = app.buttons["loadFullImage"]
        XCTAssertTrue(app.descendants(matching: .any)["loadingFullImage"].waitForExistence(timeout: 2))
        capture("image-recovery-00-loading-full-image")
        XCTAssertTrue(retry.waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["loadedImage-0"].exists)
        capture("image-recovery-01-retained-preview")
        app.descendants(matching: .any)["loadedImage-0"].swipeLeft()
        XCTAssertTrue(app.buttons["retryImage"].waitForExistence(timeout: 10))
        capture("image-recovery-02-uncached-page-failure")
        app.buttons["closeImageViewer"].tap()
        app.buttons["copyPrompt"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].label.contains("已复制"))
        capture("image-recovery-03-prompt-still-usable")
        preview().tap()
        XCTAssertTrue(retry.waitForExistence(timeout: 10))
        let restored = recoveryURL(try acceptanceDirectory())
        try Data("restored".utf8).write(to: restored, options: .atomic)
        retry.tap()
        let completed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            !retry.exists && !self.app.descendants(matching: .any)["loadingFullImage"].exists && self.app.descendants(matching: .any)["loadedImage-0"].exists
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [completed], timeout: 65), .completed)
        capture("image-recovery-04-live-full-image")
        app.buttons["完成"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].isHittable)
    }

    private func assertSavedDraft(_ item: SavedPromptSnapshot, expected: String, evidence: String) {
        app.selectPrompixTab("收藏")
        let prompt = app.buttons["prompt-\(item.id)"]
        reveal(prompt)
        prompt.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["detailFavorite"].label, "取消收藏")
        let language = app.buttons["contentLanguage"]
        if language.exists {
            reveal(language)
            language.tap()
            app.buttons["原文"].tap()
        }
        reveal(app.buttons["editPromptAction"])
        app.buttons["editPromptAction"].tap()
        let editor = app.textViews["promptEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertTrue(editor.value as? String == expected, "The original-language saved draft must remain unchanged.")
        capture(evidence)
        app.navigationBars.buttons["完成"].tap()
    }

    private func assertSavedStorage(in directory: URL, favorites: [SavedPromptSnapshot], drafts: [String: String]) throws {
        let updated = try readSnapshot([SavedPromptSnapshot].self, from: directory, file: "favorites.json")
        XCTAssertEqual(updated.map(\.id), favorites.map(\.id), "Updating the catalog must preserve saved items and their order.")
        XCTAssertTrue(zip(updated, favorites).allSatisfy { pair in pair.0.prompt == pair.1.prompt }, "Enriching saved metadata must not replace the saved source prompt.")
        XCTAssertTrue(try readSnapshot([String: String].self, from: directory, file: "drafts.json") == drafts,
                      "All original-language and translated drafts must survive the update and restart.")
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("catalog-transaction.json").path),
                       "A successful update must finish its storage transaction.")
    }

    func testProductionCatalogUpgradePreservesSavedContentAndDrafts() throws {
        guard ProcessInfo.processInfo.environment["PROMPIX_PRODUCTION_UPGRADE_TEST"] == "1" else {
            throw XCTSkip("Explicitly stage the creatorless 68-item catalog, a favorite, and its edited original-language draft before enabling this production-network test.")
        }
        var directory = try acceptanceDirectory()
        var directoryHistory = ["Before first launch: \(directory.path)"]
        let oldCatalog = try readSnapshot(CatalogSnapshot.self, from: directory, file: "catalog.json")
        let favorites = try readSnapshot([SavedPromptSnapshot].self, from: directory, file: "favorites.json")
        let drafts = try readSnapshot([String: String].self, from: directory, file: "drafts.json")
        XCTAssertEqual(oldCatalog.prompts.count, 68, "This is the legacy-cache migration fixture, not an already-updated installation.")
        XCTAssertTrue(oldCatalog.prompts.allSatisfy { $0.creator == nil })
        let seed = try XCTUnwrap(favorites.first { item in
            guard let draft = drafts[item.id] else { return false }
            return !draft.isEmpty && draft != item.prompt
        }, "Seed a saved legacy prompt with an edited original-language draft, preferably gentle-tarot.")
        let expectedDraft = try XCTUnwrap(drafts[seed.id])
        XCTAssertTrue(oldCatalog.prompts.contains { $0.id == seed.id })

        launch()
        directory = try acceptanceDirectory()
        directoryHistory.append("After cached launch: \(directory.path)")
        XCTAssertEqual(try readSnapshot(CatalogSnapshot.self, from: directory, file: "catalog.json").version, oldCatalog.version,
                       "The app launched by XCTest must use the staged legacy catalog.")
        app.revealDiscoveryRails()
        XCTAssertTrue(app.staticTexts["68"].exists)
        XCTAssertTrue(app.buttons["allCreators"].isHittable)
        XCTAssertTrue(app.buttons["loadCreators"].isHittable)
        capture("production-upgrade-01-legacy-home")
        assertSavedDraft(seed, expected: expectedDraft, evidence: "production-upgrade-02-seeded-draft")
        app.terminate()

        // No fixture endpoint or networking override: this launch uses the
        // production manifest, bounded download, validation, and transaction.
        launch(online: true)
        // XCTest can replace the app's data-container UUID at launch, after
        // setUp and the initial fixture read. Never poll a pre-launch URL.
        directory = try acceptanceDirectory()
        directoryHistory.append("After production launch: \(directory.path)")
        let status = app.descendants(matching: .any).matching(identifier: "catalogUpdateStatus").firstMatch
        let creator = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'creator-' ")).firstMatch
        var observedStages = Set<String>()
        if status.exists {
            observedStages.formUnion(status.staticTexts.allElementsBoundByIndex.map(\.label))
            capture("production-upgrade-03-visible-update")
        }
        var observations: [String] = []
        var lastObservation = ""
        let waitStarted = Date()
        let updated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let statusExists = status.exists
            let retryExists = self.app.buttons["retryCatalogUpdate"].exists
            let creatorExists = creator.exists
            if statusExists {
                observedStages.formUnion(status.staticTexts.allElementsBoundByIndex.map(\.label))
            }
            var versionChanged = false
            var countIncreased = false
            let diskState: String
            do {
                let catalog = try self.readSnapshot(CatalogSnapshot.self, from: directory, file: "catalog.json")
                versionChanged = catalog.version != oldCatalog.version
                countIncreased = catalog.prompts.count > oldCatalog.prompts.count
                diskState = "version=\(catalog.version), count=\(catalog.prompts.count), versionChanged=\(versionChanged), countIncreased=\(countIncreased)"
            } catch {
                diskState = "catalog read/decode error: \(error)"
            }
            let observation = "\(diskState); creatorExists=\(creatorExists), statusExists=\(statusExists), retryExists=\(retryExists)"
            if observation != lastObservation {
                observations.append(String(format: "%.2fs: %@", Date().timeIntervalSince(waitStarted), observation))
                lastObservation = observation
            }
            return retryExists || (versionChanged && countIncreased && creatorExists && !statusExists)
        }, object: nil)
        let result = XCTWaiter.wait(for: [updated], timeout: 90)
        let conditionEvidence = XCTAttachment(string: (directoryHistory + ["Wait result: \(result)", "Observed condition changes:"] + observations).joined(separator: "\n"))
        conditionEvidence.name = "production-update-condition-diagnostics"
        conditionEvidence.lifetime = .keepAlways
        add(conditionEvidence)
        let stageEvidence = XCTAttachment(string: observedStages.isEmpty
            ? "No in-flight stage was captured through XCTest. Fast updates can finish before the first accessibility snapshot; this run does not establish intermediate progress rendering."
            : "Observed update labels:\n" + observedStages.sorted().joined(separator: "\n"))
        stageEvidence.name = "production-update-observed-stages"
        stageEvidence.lifetime = .keepAlways
        add(stageEvidence)
        capture("production-upgrade-04-result")
        XCTAssertFalse(app.buttons["retryCatalogUpdate"].exists, "Production refresh failed; inspect the visible retry state and network evidence.")
        XCTAssertEqual(result, .completed, "The real production catalog must finish updating within the bounded acceptance timeout. Last observation: \(lastObservation)")

        let catalog = try readSnapshot(CatalogSnapshot.self, from: directory, file: "catalog.json")
        XCTAssertNotEqual(catalog.version, oldCatalog.version)
        XCTAssertGreaterThan(catalog.prompts.count, oldCatalog.prompts.count)
        let creatorIDs = Set(catalog.prompts.compactMap { $0.creator?.id })
        XCTAssertFalse(creatorIDs.isEmpty)
        XCTAssertTrue(favorites.allSatisfy { saved in catalog.prompts.contains { $0.id == saved.id } },
                      "The acceptance seeds must still be published; restage if they were intentionally removed.")
        app.revealDiscoveryRails()
        XCTAssertTrue(app.staticTexts[catalog.prompts.count.formatted()].exists)
        XCTAssertFalse(app.buttons["loadCreators"].exists)
        XCTAssertTrue(app.buttons["allCreators"].isHittable)
        XCTAssertTrue(creatorIDs.contains(String(creator.identifier.dropFirst("creator-".count))), "The visible creator must come from the downloaded catalog.")
        creator.tap()
        XCTAssertTrue(app.buttons["saveCreator"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.links["creatorExternalProfile"].exists || app.buttons["creatorExternalProfile"].exists)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-' ")).firstMatch.exists)
        capture("production-upgrade-05-real-creator-profile")
        // Creator detail intentionally hides the tab bar. Return through the
        // native back action before switching to the saved collection.
        app.goBackInPrompix()
        XCTAssertTrue(app.buttons["allCreators"].waitForExistence(timeout: 5))
        assertSavedDraft(seed, expected: expectedDraft, evidence: "production-upgrade-06-draft-after-update")
        try assertSavedStorage(in: directory, favorites: favorites, drafts: drafts)
        app.terminate()

        launch()
        directory = try acceptanceDirectory()
        XCTAssertTrue(app.staticTexts[catalog.prompts.count.formatted()].exists)
        XCTAssertTrue(creator.exists)
        XCTAssertFalse(app.buttons["loadCreators"].exists)
        capture("production-upgrade-07-updated-home-after-restart")
        assertSavedDraft(seed, expected: expectedDraft, evidence: "production-upgrade-08-draft-after-restart")
        try assertSavedStorage(in: directory, favorites: favorites, drafts: drafts)
        let finalCatalog = try readSnapshot(CatalogSnapshot.self, from: directory, file: "catalog.json")
        XCTAssertEqual(finalCatalog.version, catalog.version)
        XCTAssertEqual(finalCatalog.prompts.count, catalog.prompts.count)
        let evidence = XCTAttachment(string: "Production upgrade: \(oldCatalog.version) (\(oldCatalog.prompts.count) items) → \(catalog.version) (\(catalog.prompts.count) items, \(creatorIDs.count) creator IDs). Preserved \(favorites.count) favorites and \(drafts.count) drafts through update and cached restart.")
        evidence.name = "production-upgrade-summary"
        evidence.lifetime = .keepAlways
        add(evidence)
    }

    func testLegacyCatalogKeepsCreatorEntry() throws {
        guard ProcessInfo.processInfo.environment["PROMPIX_LEGACY_CATALOG_TEST"] == "1" else {
            throw XCTSkip("Stage the legacy creatorless catalog in a dedicated simulator before this test.")
        }
        launch()
        app.revealDiscoveryRails()
        XCTAssertTrue(app.staticTexts["68"].exists)
        XCTAssertTrue(app.buttons["allCreators"].isHittable)
        XCTAssertTrue(app.buttons["loadCreators"].isHittable)
        capture("legacy-catalog-creator-entry")
        app.buttons["allCreators"].tap()
        XCTAssertTrue(app.buttons["loadCreatorsDirectory"].waitForExistence(timeout: 5))
        capture("legacy-catalog-creator-directory")
    }

    func testHomeSectionsContinuousFeedAndSavedHeader() {
        launch()
        let creators = app.scrollViews["creatorRail"]
        XCTAssertTrue(creators.waitForExistence(timeout: 5))
        let firstCreator = creators.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'creator-' ")).firstMatch
        let initialCreator = firstCreator.identifier
        capture("feedback-01-home")
        creators.swipeLeft()
        let visibleCreators = creators.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'creator-' ")).allElementsBoundByIndex.filter {
            $0.frame.intersects(creators.frame) && $0.isHittable
        }
        XCTAssertTrue(visibleCreators.contains { $0.identifier != initialCreator })
        let originalCreator = creators.buttons[initialCreator]
        XCTAssertTrue(!originalCreator.exists || !originalCreator.frame.intersects(creators.frame), "Creator discovery must scroll beyond the first entries.")
        capture("feedback-02-creators-scrolled")
        let collection = app.buttons["home-collection-portraits"]
        let firstCard = app.buttons["prompt-gentle-tarot"]
        XCTAssertLessThan(creators.frame.maxY, collection.frame.minY)
        XCTAssertLessThan(collection.frame.maxY, firstCard.frame.minY)
        XCTAssertTrue(firstCard.isHittable, "Discovery still shows real content on the first screen.")
        for index in 0..<4 {
            app.swipeUp()
            XCTAssertTrue(app.buttons["kind-all"].isHittable)
            if index > 0 {
                let top = app.scrollViews["kindPicker"].frame.maxY + 8
                let bottom = app.frame.maxY - 100
                let cards = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-' ")).allElementsBoundByIndex.map(\.frame)
                for right in [false, true] {
                    let intervals = cards.filter { ($0.midX > app.frame.midX) == right && $0.maxY > top && $0.minY < bottom }.sorted { $0.minY < $1.minY }
                    XCTAssertFalse(intervals.isEmpty)
                    var end = top
                    for frame in intervals {
                        XCTAssertLessThan(max(0, frame.minY - end), 100, "The feed must not leave a tall blank column between cards.")
                        end = max(end, frame.maxY)
                    }
                    XCTAssertGreaterThanOrEqual(end, bottom - 100)
                }
            }
            capture("feedback-03-scroll-\(index)")
        }
        app.selectPrompixTab("收藏")
        let settings = app.buttons["savedSettings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.isHittable)
        XCTAssertLessThan(search.frame.minY, settings.frame.maxY + 50, "Search must follow the compact header without a blank large-title region.")
        capture("feedback-04-saved")
        settings.tap()
        XCTAssertTrue(app.buttons["replayOnboarding"].waitForExistence(timeout: 5))
        app.buttons["完成"].tap()
        XCTAssertTrue(search.waitForExistence(timeout: 5))
    }

    func testSavedHeaderAndCreatorEntryAtLargeText() throws {
        launch()
        app.revealDiscoveryRails()
        let allCreators = app.buttons["allCreators"]
        XCTAssertTrue(allCreators.isHittable)
        capture("feedback-large-home")
        app.selectPrompixTab("收藏")
        let settings = app.buttons["savedSettings"]
        let search = app.searchFields.firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        XCTAssertTrue(settings.isHittable && search.isHittable)
        XCTAssertLessThan(search.frame.minY, settings.frame.maxY + 50)
        capture("feedback-large-saved")
        try app.performAccessibilityAudit(for: [.hitRegion, .sufficientElementDescription])
        settings.tap()
        XCTAssertTrue(app.buttons["replayOnboarding"].waitForExistence(timeout: 5))
        app.buttons["完成"].tap()
        XCTAssertTrue(search.waitForExistence(timeout: 5))
    }

    func testRefinedDiscoveryNavigationAndQuickCopy() {
        launch()
        capture("polish-01-home")
        let creator = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'creator-' ")).firstMatch
        XCTAssertTrue(creator.isHittable)
        creator.tap()
        XCTAssertTrue(app.buttons["saveCreator"].waitForExistence(timeout: 5))
        capture("polish-02-creator")
        app.goBackInPrompix()

        app.swipeUp(); app.swipeUp()
        let textChannel = app.buttons["kind-text"]
        app.swipeDown()
        XCTAssertTrue(textChannel.isHittable, "Content channels return when browsing upward.")
        capture("polish-03-pinned-channels")
        textChannel.tap()
        XCTAssertTrue(textChannel.isSelected)
        let firstNote = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-' ")).firstMatch
        XCTAssertTrue(firstNote.isHittable, "Changing channel returns to its first result.")
        capture("polish-04-text")
        firstNote.press(forDuration: 0.8)
        let copy = app.buttons["复制 Prompt"]
        XCTAssertTrue(copy.waitForExistence(timeout: 5))
        capture("polish-05-quick-actions")
        copy.tap()
        XCTAssertTrue(firstNote.waitForExistence(timeout: 5))
        let copiedID = XCTAttachment(string: firstNote.identifier)
        copiedID.name = "polish-copied-prompt-id"; copiedID.lifetime = .keepAlways; add(copiedID)
        firstNote.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        capture("polish-06-reading")
        app.buttons["编辑后使用"].tap()
        XCTAssertTrue(app.textViews["promptEditor"].waitForExistence(timeout: 5))
        capture("polish-07-editor")
        app.buttons["完成"].tap()
        app.goBackInPrompix()
        XCTAssertTrue(app.buttons["kind-text"].isSelected)
        app.openPrompixCollections()
        capture("polish-08-collections")
        app.goBackInPrompix()
        app.selectPrompixTab("收藏")
        capture("polish-09-saved")
        app.selectPrompixTab("发现")
        app.buttons["kind-all"].tap()
        capture("polish-10-home-return")
    }

    func testEditorialReadingScreens() {
        for language in ["zh-Hans", "en", "de"] {
            launch(language)
            capture("editorial-\(language)-home")
            let note = app.buttons["prompt-gentle-tarot"]
            reveal(note)
            capture("editorial-\(language)-notes")
            note.tap()
            XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
            capture("editorial-\(language)-detail")
            let oldLabel = app.buttons["copyPrompt"].label
            app.buttons["copyPrompt"].tap()
            XCTAssertNotEqual(app.buttons["copyPrompt"].label, oldLabel)
            reveal(app.buttons["editPromptAction"])
            app.buttons["editPromptAction"].tap()
            XCTAssertTrue(app.textViews["promptEditor"].waitForExistence(timeout: 5))
            capture("editorial-\(language)-editor")
            app.terminate()
        }
    }




    func testPublishedTranslationCatchUp() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let requested = environment["PROMPIX_TRANSLATION_ACCEPTANCE_IDS"],
              let version = environment["PROMPIX_TRANSLATION_ACCEPTANCE_VERSION"] else {
            throw XCTSkip("Requires an explicitly published translation edition on the dedicated simulator.")
        }
        let ids = requested.split(separator: ",").map(String.init)
        XCTAssertFalse(ids.isEmpty)
        let directory = try acceptanceDirectory()
        let personalFiles = ["drafts.json", "favorites.json", "creators.json"]
        let before = personalFiles.map { try? Data(contentsOf: directory.appendingPathComponent($0)) }
        let drafts = try readSnapshot([String: String].self, from: directory, file: "drafts.json")
        XCTAssertFalse(drafts.keys.contains { key in ids.contains { key == $0 || key.hasPrefix($0 + "::") } })
        launch(online: true)
        let refreshed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard let current = try? self.acceptanceDirectory(),
                  let catalog = try? self.readSnapshot(CatalogSnapshot.self, from: current, file: "catalog.json") else { return false }
            return catalog.version == version
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [refreshed], timeout: 90), .completed)
        let bytes = try Data(contentsOf: try acceptanceDirectory().appendingPathComponent("catalog.json"))
        let catalog = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        let prompts = try XCTUnwrap(catalog["prompts"] as? [[String: Any]])
        for id in ids {
            let item = try XCTUnwrap(prompts.first { $0["id"] as? String == id })
            let title = try XCTUnwrap(item["title"] as? String)
            for (locale, name) in [("zh-Hans", "简体中文"), ("en", "English")] {
                app.terminate(); launch()
                app.selectPrompixTab("搜索")
                let search = app.searchFields.firstMatch
                XCTAssertTrue(search.waitForExistence(timeout: 5))
                search.tap(); search.typeText(title)
                let card = app.scrollViews["searchResults"].buttons["prompt-\(id)"]
                reveal(card); card.tap()
                let language = app.buttons["contentLanguage"]
                reveal(language); language.tap()
                let choice = app.buttons["contentLanguage-\(locale)"]
                XCTAssertTrue(choice.waitForExistence(timeout: 5)); choice.tap()
                let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    language.exists && language.label.contains(name)
                }, object: nil)
                XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 60), .completed)
                XCTAssertFalse(app.otherElements["languageDownloadFailure"].exists)
                let current = try readSnapshot(CatalogSnapshot.self, from: try acceptanceDirectory(), file: "catalog.json")
                let expected = try XCTUnwrap(current.prompts.first { $0.id == id }?.localization?.translations[locale]?.prompt)
                XCTAssertFalse(expected.isEmpty)
                capture("translation-\(id)-\(locale)-detail")
                reveal(app.buttons["editPromptAction"]); app.buttons["editPromptAction"].tap()
                let editor = app.textViews["promptEditor"]
                XCTAssertTrue(editor.waitForExistence(timeout: 5))
                XCTAssertTrue(editor.value as? String == expected, "Editing must retain the complete selected-language body.")
                capture("translation-\(id)-\(locale)-editor")
                app.navigationBars.buttons["完成"].tap()
                app.buttons["copyPrompt"].tap()
                XCTAssertTrue(app.buttons["copyPrompt"].label.contains("已复制"))
                let evidence = XCTAttachment(string: expected)
                evidence.name = "translation-\(id)-\(locale)-expected-clipboard"
                evidence.lifetime = .keepAlways; add(evidence)
            }
        }
        // Keep the authoritative hydrated records before startup loads only the
        // preferred locale. A downloaded pack may legitimately refresh saved translations.
        let hydrated = try Data(contentsOf: try acceptanceDirectory().appendingPathComponent("catalog.json"))
        let hydratedJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: hydrated) as? [String: Any])
        let authoritative = try XCTUnwrap(hydratedJSON["prompts"] as? [[String: Any]])
        app.terminate(); launch()
        let current = try acceptanceDirectory()
        let downloaded = try readSnapshot(LanguagePackIndexSnapshot.self, from: current, file: "language-packs.json")
        XCTAssertTrue(Set(["zh-Hans", "en"]).isSubset(of: Set(downloaded.downloadedLocales.keys)))
        for (index, name) in personalFiles.enumerated() where name != "favorites.json" {
            XCTAssertEqual(try? Data(contentsOf: current.appendingPathComponent(name)), before[index], name)
        }
        let oldFavorites = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(before[1])) as? [[String: Any]])
        let savedFavorites = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: current.appendingPathComponent("favorites.json"))) as? [[String: Any]])
        XCTAssertEqual(oldFavorites.count, savedFavorites.count)
        for (old, saved) in zip(oldFavorites, savedFavorites) {
            var originalFields = old, savedFields = saved
            let oldLocalization = originalFields.removeValue(forKey: "localization") as? [String: Any] ?? [:]
            let savedLocalization = savedFields.removeValue(forKey: "localization") as? [String: Any] ?? [:]
            XCTAssertEqual(originalFields as NSDictionary, savedFields as NSDictionary, "Favorite identity, order and original content must remain unchanged.")
            var oldMetadata = oldLocalization, savedMetadata = savedLocalization
            let oldTranslations = oldMetadata.removeValue(forKey: "translations") as? [String: Any] ?? [:]
            let newTranslations = savedMetadata.removeValue(forKey: "translations") as? [String: Any] ?? [:]
            XCTAssertEqual(oldMetadata as NSDictionary, savedMetadata as NSDictionary)
            XCTAssertTrue(Set(oldTranslations.keys).isSubset(of: Set(newTranslations.keys)))
            let published = authoritative.first { $0["id"] as? String == saved["id"] as? String }
            let expected = (published?["localization"] as? [String: Any])?["translations"] as? [String: Any] ?? [:]
            for (locale, value) in newTranslations {
                let newValue = try XCTUnwrap(value as? [String: Any])
                if (oldTranslations[locale] as? [String: Any]).map({ $0 as NSDictionary }) == newValue as NSDictionary { continue }
                XCTAssertEqual(newValue as NSDictionary, try XCTUnwrap(expected[locale] as? [String: Any]) as NSDictionary,
                               "Only a complete translation from the verified downloaded pack may refresh a favorite.")
            }
        }
    }

    func testPublishedEditorialBatch() throws {
        guard let requested = ProcessInfo.processInfo.environment["PROMPIX_EDITORIAL_ACCEPTANCE_IDS"] else {
            throw XCTSkip("Requires a reviewed live batch on the dedicated simulator.")
        }
        let ids = requested.split(separator: ",").map(String.init)
        XCTAssertFalse(ids.isEmpty)
        XCTAssertEqual(Set(ids).count, ids.count)
        let directory = try acceptanceDirectory()
        let personalFiles = ["drafts.json", "favorites.json", "creators.json"]
        let before = personalFiles.map { try? Data(contentsOf: directory.appendingPathComponent($0)) }
        launch(online: true)
        let refreshed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard let current = try? self.acceptanceDirectory(),
                  let catalog = try? self.readSnapshot(CatalogSnapshot.self, from: current, file: "catalog.json") else { return false }
            return Set(ids).isSubset(of: Set(catalog.prompts.map(\.id)))
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [refreshed], timeout: 90), .completed)
        let bytes = try Data(contentsOf: try acceptanceDirectory().appendingPathComponent("catalog.json"))
        let catalog = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        let prompts = try XCTUnwrap(catalog["prompts"] as? [[String: Any]])
        capture("editorial-batch-discovery")
        for id in ids {
            let item = try XCTUnwrap(prompts.first { $0["id"] as? String == id })
            let title = try XCTUnwrap(item["title"] as? String)
            // Each launch uses the verified local edition after the live refresh.
            app.terminate(); launch()
            app.selectPrompixTab("搜索")
            let search = app.searchFields.firstMatch
            XCTAssertTrue(search.waitForExistence(timeout: 5))
            search.tap(); search.typeText(title)
            let card = app.scrollViews["searchResults"].buttons["prompt-\(id)"]
            reveal(card); card.tap()
            XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
            capture("editorial-batch-\(id)-detail")
            if item["contentType"] as? String == "skill" {
                let skill = try XCTUnwrap(item["skill"] as? [String: Any])
                let files = try XCTUnwrap(skill["files"] as? [String])
                XCTAssertTrue(files.contains("SKILL.md"))
                app.expandPromptInformation()
                let inventory = app.buttons["skillFiles"]
                reveal(inventory); inventory.tap()
                reveal(app.staticTexts[try XCTUnwrap(files.last)])
                XCTAssertTrue(app.descendants(matching: .any)["skillSource"].exists)
                capture("editorial-batch-\(id)-files")
                app.buttons["copyPrompt"].tap()
                let copy = app.buttons["copyPrompt"]
                XCTAssertTrue(copy.waitForExistence(timeout: 5)); copy.tap()
                XCTAssertTrue(copy.label.contains("已复制"))
                let settledAt = Date().addingTimeInterval(0.7)
                XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in Date() >= settledAt }, object: nil)], timeout: 3), .completed)
                capture("editorial-batch-\(id)-installation")
            } else {
                let copy = app.buttons["copyPrompt"]
                copy.tap(); XCTAssertTrue(copy.label.contains("已复制"))
                app.buttons["copyPrompt"].tap()
                XCTAssertTrue(app.buttons["copyPrompt"].exists)
                capture("editorial-batch-\(id)-use")
            }
        }
        let current = try acceptanceDirectory()
        for (index, name) in personalFiles.enumerated() {
            XCTAssertEqual(try? Data(contentsOf: current.appendingPathComponent(name)), before[index], name)
        }
    }

    func testPublisherSkillPackages() throws {
        guard ProcessInfo.processInfo.environment["PROMPIX_PUBLISHER_ACCEPTANCE"] == "1" else {
            throw XCTSkip("Requires live reviewed publisher packages on the dedicated simulator.")
        }
        let directory = try acceptanceDirectory()
        let drafts = try? Data(contentsOf: directory.appendingPathComponent("drafts.json"))
        for id in ["skill-publisher-expo-expo-ui", "skill-publisher-supabase-supabase"] {
            launch(online: true)
            let downloaded = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                guard let current = try? self.acceptanceDirectory(),
                      let catalog = try? self.readSnapshot(CatalogSnapshot.self, from: current, file: "catalog.json") else { return false }
                return catalog.prompts.contains { $0.id == id }
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [downloaded], timeout: 90), .completed)
            let bytes = try Data(contentsOf: try acceptanceDirectory().appendingPathComponent("catalog.json"))
            let catalog = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
            let prompts = try XCTUnwrap(catalog["prompts"] as? [[String: Any]])
            let target = try XCTUnwrap(prompts.first { $0["id"] as? String == id })
            let title = try XCTUnwrap(target["title"] as? String)
            let skill = try XCTUnwrap(target["skill"] as? [String: Any])
            let files = try XCTUnwrap(skill["files"] as? [String])
            XCTAssertGreaterThan(files.count, 1)
            app.selectPrompixTab("搜索")
            let search = app.searchFields.firstMatch
            XCTAssertTrue(search.waitForExistence(timeout: 5)); search.tap(); search.typeText(title)
            let card = app.scrollViews["searchResults"].buttons["prompt-\(id)"]
            reveal(card); card.tap()
            XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
            capture("publisher-\(id)-detail")
            app.expandPromptInformation()
            let inventory = app.buttons["skillFiles"]
            reveal(inventory); inventory.tap()
            reveal(app.staticTexts[try XCTUnwrap(files.last)])
            XCTAssertTrue(app.staticTexts["SKILL.md"].exists)
            XCTAssertTrue(app.descendants(matching: .any)["skillSource"].exists)
            capture("publisher-\(id)-files")
            app.buttons["copyPrompt"].tap()
            let copy = app.buttons["copyPrompt"]
            XCTAssertTrue(copy.waitForExistence(timeout: 5)); copy.tap()
            XCTAssertTrue(copy.label.contains("已复制"))
            let settledAt = Date().addingTimeInterval(0.7)
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in Date() >= settledAt }, object: nil)], timeout: 3), .completed)
            capture("publisher-\(id)-installation")
            XCTAssertEqual(try? Data(contentsOf: try acceptanceDirectory().appendingPathComponent("drafts.json")), drafts)
            app.terminate()
        }
    }

    func testIndependentXImageAndVideoJourney() throws {
        guard ProcessInfo.processInfo.environment["PROMPIX_NATIVE_X_ACCEPTANCE"] == "1" else {
            throw XCTSkip("Requires a published native X image and video, with a backed-up simulator container.")
        }
        launch(online: true)
        var targets: [[String: Any]] = []
        let downloaded = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard let directory = try? self.acceptanceDirectory(),
                  let bytes = try? Data(contentsOf: directory.appendingPathComponent("catalog.json")),
                  let catalog = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
                  let prompts = catalog["prompts"] as? [[String: Any]] else { return false }
            let native = prompts.filter { ($0["source"] as? [String: Any])?["name"] as? String == "X" }
            // Desktop workflows have their own copy/share journey below. This
            // journey exercises destinations available to mobile image/video tools.
            targets = ["image", "video"].compactMap { kind in native.first {
                $0["kind"] as? String == kind && !($0["model"] as? String ?? "").localizedCaseInsensitiveContains("Remotion")
            } }
            return targets.count == 2
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [downloaded], timeout: 90), .completed)
        capture("native-x-01-updated-discovery")
        for target in targets {
            let id = try XCTUnwrap(target["id"] as? String)
            let title = try XCTUnwrap(target["title"] as? String)
            let kind = try XCTUnwrap(target["kind"] as? String)
            app.selectPrompixTab("搜索")
            let search = app.searchFields.firstMatch
            XCTAssertTrue(search.waitForExistence(timeout: 5)); search.tap(); search.typeText(title)
            let card = app.scrollViews["searchResults"].buttons["prompt-\(id)"]
            reveal(card); card.tap()
            XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
            capture("native-x-\(kind)-detail")
            app.buttons["previewButton"].tap()
            let preview = app.descendants(matching: .any)[kind == "video" ? "playingVideo" : "loadedImage-0"]
            XCTAssertTrue(preview.waitForExistence(timeout: 35))
            XCTAssertFalse(app.buttons[kind == "video" ? "retryVideo" : "retryImage"].exists)
            capture("native-x-\(kind)-loaded-preview")
            app.buttons["完成"].tap()
            let byline = app.buttons["creatorByline"]
            if !byline.exists { app.expandPromptInformation() }
            reveal(byline); byline.tap()
            XCTAssertTrue(app.buttons["saveCreator"].waitForExistence(timeout: 5))
            XCTAssertTrue(app.links["creatorExternalProfile"].exists || app.buttons["creatorExternalProfile"].exists)
            capture("native-x-\(kind)-creator-profile")
            app.goBackInPrompix()
            let original = app.buttons["originalXPost"]
            reveal(original); original.tap()
            capture("native-x-\(kind)-original-post")
            app.buttons["copyPrompt"].tap()
            XCTAssertGreaterThan(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'destination-' ")).count, 0)
            capture("native-x-\(kind)-tool-destination")
            app.navigationBars.buttons["完成"].tap()
            launch()
        }
    }

    func testNativeReplyContextAndDesktopWorkflow() throws {
        guard ProcessInfo.processInfo.environment["PROMPIX_THREAD_ACCEPTANCE"] == "1" else {
            throw XCTSkip("Requires a reviewed X reply workflow in the dedicated simulator catalog.")
        }
        let directory = try acceptanceDirectory()
        let drafts = try? Data(contentsOf: directory.appendingPathComponent("drafts.json"))
        launch(online: true)
        let downloaded = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard let current = try? self.acceptanceDirectory(),
                  let bytes = try? Data(contentsOf: current.appendingPathComponent("catalog.json")),
                  let catalog = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
                  let prompts = catalog["prompts"] as? [[String: Any]] else { return false }
            return prompts.contains { ($0["source"] as? [String: Any])?["context"] != nil && $0["model"] as? String == "Remotion" }
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [downloaded], timeout: 90), .completed)
        let bytes = try Data(contentsOf: try acceptanceDirectory().appendingPathComponent("catalog.json"))
        let catalog = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        let prompts = try XCTUnwrap(catalog["prompts"] as? [[String: Any]])
        let target = try XCTUnwrap(prompts.first { ($0["source"] as? [String: Any])?["context"] != nil && $0["model"] as? String == "Remotion" })
        let id = try XCTUnwrap(target["id"] as? String), title = try XCTUnwrap(target["title"] as? String)
        let source = try XCTUnwrap(target["source"] as? [String: Any])
        let context = try XCTUnwrap((source["context"] as? [[String: Any]])?.first)
        let contextID = try XCTUnwrap(context["id"] as? String)
        app.selectPrompixTab("搜索")
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5)); search.tap(); search.typeText(title)
        let card = app.scrollViews["searchResults"].buttons["prompt-\(id)"]
        reveal(card); card.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        capture("thread-01-workflow-detail")
        app.buttons["previewButton"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["playingVideo"].waitForExistence(timeout: 35))
        XCTAssertFalse(app.buttons["retryVideo"].exists)
        capture("thread-02-original-video")
        app.buttons["完成"].tap()
        let original = app.buttons["sourceContext-\(contextID)"]
        reveal(original); original.tap()
        let sourceSettledAt = Date().addingTimeInterval(0.7)
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in Date() >= sourceSettledAt }, object: nil)], timeout: 3), .completed)
        capture("thread-03-separate-original-context")
        original.tap()
        app.buttons["copyPrompt"].tap()
        XCTAssertTrue(app.staticTexts["desktopWorkflowGuidance"].waitForExistence(timeout: 5))
        let copy = app.buttons["copyDesktopWorkflow"]
        XCTAssertTrue(copy.exists); copy.tap()
        XCTAssertTrue(copy.label.contains("已复制"))
        let copySettledAt = Date().addingTimeInterval(0.7)
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in Date() >= copySettledAt }, object: nil)], timeout: 3), .completed)
        capture("thread-04-desktop-copy-and-share")
        let expected = XCTAttachment(data: Data(try XCTUnwrap(target["prompt"] as? String).utf8), uniformTypeIdentifier: "public.utf8-plain-text")
        expected.name = "thread-clipboard-expected"; expected.lifetime = .keepAlways; add(expected)
        XCTAssertEqual(try? Data(contentsOf: try acceptanceDirectory().appendingPathComponent("drafts.json")), drafts)
    }

    func testCreatorJourney() {
        launch()
        app.revealDiscoveryRails()
        XCTAssertTrue(app.buttons["allCreators"].waitForExistence(timeout: 10), "Stage the creator/Skill candidate catalog before running this journey.")
        capture("01-home-creators-and-collections")
        let creator = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'creator-' ")).firstMatch
        XCTAssertTrue(creator.isHittable)
        creator.tap()
        XCTAssertTrue(app.buttons["saveCreator"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.links["creatorExternalProfile"].exists || app.buttons["creatorExternalProfile"].exists)
        capture("02-creator-profile")
        if app.buttons["saveCreator"].label == "取消收藏创作者" { app.buttons["saveCreator"].tap() }
        app.buttons["saveCreator"].tap()
        XCTAssertEqual(app.buttons["saveCreator"].label, "取消收藏创作者")
        let item = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-' ")).firstMatch
        reveal(item)
        item.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        if !app.buttons["creatorByline"].exists { app.expandPromptInformation() }
        reveal(app.buttons["creatorByline"])
        capture("03-work-with-creator-attribution")
        app.buttons["creatorByline"].tap()
        XCTAssertTrue(app.buttons["saveCreator"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["saveCreator"].label, "取消收藏创作者")

        app.terminate()
        launch()
        app.selectPrompixTab("收藏")
        app.segmentedControls["savedContentType"].buttons["创作者"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'saved-creator-' ")).firstMatch.waitForExistence(timeout: 5))
        capture("04-saved-creator-after-relaunch")
    }

    func testNineInterfaceLanguages() {
        let languages = [("en", "English"), ("zh-Hans", "简体中文"), ("zh-Hant", "繁體中文"),
                         ("ja", "日本語"), ("ko", "한국어"), ("es", "Español"),
                         ("pt-BR", "Português (Brasil)"), ("fr", "Français"), ("de", "Deutsch")]
        for (language, contentLanguage) in languages {
            launch(language)
            app.revealDiscoveryRails()
            XCTAssertTrue(app.buttons["allCreators"].waitForExistence(timeout: 5))
            capture("language-\(language)-home")
            app.buttons["allCreators"].tap()
            XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 5))
            capture("language-\(language)-creators")
            app.searchFields.firstMatch.tap()
            app.searchFields.firstMatch.typeText("Artingent")
            let creator = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'creator-' ")).firstMatch
            XCTAssertTrue(creator.waitForExistence(timeout: 5))
            creator.tap()
            XCTAssertTrue(app.buttons["saveCreator"].waitForExistence(timeout: 5))
            let item = app.buttons["prompt-youmind-nano-326c1a15425d6666"]
            reveal(item)
            item.tap()
            XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
            let languageMenu = app.buttons["contentLanguage"]
            XCTAssertTrue(languageMenu.exists)
            // Production editions download translations on demand. A cached-only
            // launch must not pretend that all nine packs are already installed.
            if !languageMenu.label.contains(contentLanguage) {
                reveal(languageMenu); languageMenu.tap()
                let choice = app.buttons["contentLanguage-\(language)"]
                XCTAssertTrue(choice.waitForExistence(timeout: 5)); choice.tap()
                let translated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    languageMenu.exists && languageMenu.label.contains(contentLanguage)
                }, object: nil)
                XCTAssertEqual(XCTWaiter.wait(for: [translated], timeout: 60), .completed)
            }
            XCTAssertTrue(languageMenu.label.contains(contentLanguage), "Downloaded content must use the selected interface language.")
            capture("language-\(language)-detail")
            let beforeCopy = app.buttons["copyPrompt"].label
            app.buttons["copyPrompt"].tap()
            XCTAssertNotEqual(app.buttons["copyPrompt"].label, beforeCopy)
            app.terminate()
        }
    }


    private func performancePersonalState() throws -> [String: Data] {
        let directory = try acceptanceDirectory()
        var state: [String: Data] = [:]
        for file in ["drafts.json", "favorites.json"] {
            let url = directory.appendingPathComponent(file)
            if FileManager.default.fileExists(atPath: url.path) { state[file] = try Data(contentsOf: url) }
        }
        return state
    }

    private func fullPerformanceCatalog() throws -> CatalogSnapshot {
        guard ProcessInfo.processInfo.environment["PROMPIX_FULL_CATALOG_PERFORMANCE"] == "1" else {
            throw XCTSkip("Stage the current production catalog and language pack; supply its exact version, count, locale and translated count; run Release.")
        }
        let directory = try acceptanceDirectory()
        let catalog = try readSnapshot(CatalogSnapshot.self, from: directory, file: "catalog.json")
        XCTAssertGreaterThan(catalog.prompts.count, 68, "Performance evidence must exercise the expanded catalog.")
        let environment = ProcessInfo.processInfo.environment
        let expectedVersion = try XCTUnwrap(environment["PROMPIX_PERFORMANCE_VERSION"])
        let expectedCount = try XCTUnwrap(environment["PROMPIX_PERFORMANCE_COUNT"].flatMap(Int.init))
        let expectedTranslations = try XCTUnwrap(environment["PROMPIX_PERFORMANCE_TRANSLATED_COUNT"].flatMap(Int.init))
        let locale = try XCTUnwrap(environment["PROMPIX_PERFORMANCE_LOCALE"])
        XCTAssertEqual(catalog.version, expectedVersion)
        XCTAssertEqual(catalog.prompts.count, expectedCount)
        XCTAssertEqual(catalog.prompts.filter { !($0.localization?.translations[locale]?.prompt.isEmpty ?? true) }.count, expectedTranslations)
        XCTAssertGreaterThan(expectedTranslations, 0, "Measure a real downloaded language pack with original fallback.")
        let index = try readSnapshot(LanguagePackIndexSnapshot.self, from: directory, file: "language-packs.json")
        XCTAssertNotNil(index.downloadedLocales[locale])
        return catalog
    }

    func testCurrentCatalogProcessLaunchPerformance() throws {
        let catalog = try fullPerformanceCatalog()
        let locale = try XCTUnwrap(ProcessInfo.processInfo.environment["PROMPIX_PERFORMANCE_LOCALE"])
        let personalBefore = try performancePersonalState()
        let translated = catalog.prompts.filter { !($0.localization?.translations[locale]?.prompt.isEmpty ?? true) }.count
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        measure(metrics: [XCTApplicationLaunchMetric(waitUntilResponsive: true)], options: options) {
            app.terminate()
            launch(locale)
            app.revealDiscoveryRails()
            XCTAssertTrue(app.staticTexts[catalog.prompts.count.formatted()].exists)
            XCTAssertTrue(app.buttons["allCreators"].exists)
            XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'creator-' ")).firstMatch.exists)
        }
        let directory = try acceptanceDirectory()
        XCTAssertEqual(try readSnapshot(CatalogSnapshot.self, from: directory, file: "catalog.json").version, catalog.version)
        capture("current-catalog-after-process-launches")
        XCTAssertEqual(try performancePersonalState(), personalBefore, "Performance probes must not change saved drafts or favorites.")
        let evidence = XCTAttachment(string: "Release configuration must be supplied by the runner. Catalog: \(catalog.version), \(catalog.prompts.count) items; \(locale) translations: \(translated), remaining items use original fallback. Five measured process launches with XCTApplicationLaunchMetric(waitUntilResponsive: true), each verifying catalog count and the creator entry. Catalog refresh is disabled to measure loading the complete persisted catalog. OS, file, and media caches are not cleared; this is not a reboot or an empty-cache cold-start measurement.")
        evidence.name = "current-catalog-process-launch-scope"
        evidence.lifetime = .keepAlways
        add(evidence)
    }

    func testCurrentCatalogBrowsingPerformance() throws {
        let catalog = try fullPerformanceCatalog()
        let locale = try XCTUnwrap(ProcessInfo.processInfo.environment["PROMPIX_PERFORMANCE_LOCALE"])
        let personalBefore = try performancePersonalState()
        let translated = catalog.prompts.filter { !($0.localization?.translations[locale]?.prompt.isEmpty ?? true) }.count
        launch(locale)
        XCTAssertTrue(app.staticTexts[catalog.prompts.count.formatted()].exists)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'creator-' ")).firstMatch.exists)
        func visiblePromptIDs() -> Set<String> {
            let viewport = app.frame.insetBy(dx: 0, dy: 110)
            return Set(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-' ")).allElementsBoundByIndex.compactMap { element in
                let visible = element.frame.intersection(viewport)
                return !visible.isNull && visible.width >= 44 && visible.height >= 44 && element.isHittable ? element.identifier : nil
            })
        }
        // Move beyond discovery rails before measuring, so each round can
        // prove that different real cards reached the viewport.
        scrollFeed(forward: true)
        let initialIDs = visiblePromptIDs()
        XCTAssertFalse(initialIDs.isEmpty)
        var visitedIDs = initialIDs
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        measure(metrics: [XCTMemoryMetric(application: app), XCTCPUMetric(application: app), XCTClockMetric()], options: options) {
            let before = visiblePromptIDs()
            for _ in 0..<5 { scrollFeed(forward: true) }
            let after = visiblePromptIDs()
            XCTAssertFalse(after.isEmpty)
            XCTAssertFalse(after.subtracting(before).isEmpty, "Measured gestures must reveal additional catalog cards.")
            visitedIDs.formUnion(after)
            for _ in 0..<5 { scrollFeed(forward: false) }
        }
        XCTAssertTrue(app.buttons["discoveryFilters"].exists)
        XCTAssertGreaterThan(visitedIDs.count, initialIDs.count)
        let directory = try acceptanceDirectory()
        XCTAssertEqual(try readSnapshot(CatalogSnapshot.self, from: directory, file: "catalog.json").version, catalog.version)
        capture("current-catalog-after-repeated-scroll")
        XCTAssertEqual(try performancePersonalState(), personalBefore, "Performance probes must not change saved drafts or favorites.")
        let evidence = XCTAttachment(string: "Release configuration must be supplied by the runner. Catalog: \(catalog.version), \(catalog.prompts.count) items; \(locale) translations: \(translated), remaining items use original fallback. Visible cards sampled: \(visitedIDs.sorted().joined(separator: ", ")). Three rounds of five forward/five reverse viewport drags. Clock and CPU include XCTest gestures and accessibility queries; these are not frame-rate measurements.")
        evidence.name = "current-catalog-performance-scope"
        evidence.lifetime = .keepAlways
        add(evidence)
    }

    private func scrollFeed(forward: Bool) {
        // Begin above the native tab bar; app.swipeUp can start on its fixed
        // surface and produce a passing measurement without moving the feed.
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: forward ? 0.7 : 0.4))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: forward ? 0.4 : 0.7))
        start.press(forDuration: 0.05, thenDragTo: end)
    }

    func testHeatherGreenMasonryBalance() {
        launch()
        app.selectPrompixTab("搜索")
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap(); field.typeText("Heather Green\n")
        let creator = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'creator-' AND label == 'Heather Green'")).firstMatch
        XCTAssertTrue(creator.waitForExistence(timeout: 5)); creator.tap()
        XCTAssertTrue(app.buttons["saveCreator"].waitForExistence(timeout: 5))
        capture("masonry-heather-top")
        app.swipeUp()
        capture("masonry-heather-middle")
        let cards = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-'"))
        XCTAssertEqual(cards.count, 5)
        let frames = cards.allElementsBoundByIndex.map(\.frame)
        let left = frames.filter { $0.midX < app.frame.midX }
        let right = frames.filter { $0.midX > app.frame.midX }
        XCTAssertGreaterThanOrEqual(left.count, 2)
        XCTAssertGreaterThanOrEqual(right.count, 2)
        let leftBottom = left.map(\.maxY).max()!
        let rightBottom = right.map(\.maxY).max()!
        let tallest = frames.map(\.height).max()!
        XCTAssertLessThan(abs(leftBottom - rightBottom), tallest, "The trailing gap should stay below one card, not several tall cards.")
        // Artwork is deliberately hidden from accessibility. A progress-indicator
        // query cannot prove download completion; allow settling, then review the
        // attached pixels alongside the independent geometry assertion.
        let settled = expectation(description: "Allow remote artwork to settle")
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) { settled.fulfill() }
        wait(for: [settled], timeout: 15)
        let loadedFrames = cards.allElementsBoundByIndex.map(\.frame)
        XCTAssertEqual(loadedFrames, frames, "Card placement and reserved sizes must stay stable while artwork loads.")
        capture("masonry-heather-loaded")
    }

    func testLongVideoSkillOpeningAndCompleteEditor() {
        verifyRepeatedOpening(query: "AI 视频制作与生成工作流", id: "skill-publisher-corey-haines-video",
                              minimumCharacters: 10_000, label: "long-video-skill")
    }

    func testReportedBrandVideoOpeningAndCompleteEditor() {
        verifyRepeatedOpening(query: "把品牌网站变成一支动画短片", id: "x-post-2109576638136795289",
                              minimumCharacters: 5_000, label: "reported-brand-video")
    }

    private func verifyRepeatedOpening(query: String, id: String, minimumCharacters: Int, label: String) {
        launch()
        app.selectPrompixTab("搜索")
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap(); field.typeText(query + "\n")
        let card = app.buttons["prompt-" + id]
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        var intervals: [Double] = []
        for attempt in 0..<3 {
            let start = Date()
            card.tap()
            XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 8))
            XCTAssertTrue(app.buttons["copyPrompt"].isHittable)
            intervals.append(Date().timeIntervalSince(start))
            XCTAssertFalse(app.tabBars.buttons["收藏"].isHittable)
            capture("\(label)-\(attempt)")
            app.buttons["closePromptDetail"].tap()
            XCTAssertTrue(card.isHittable)
            XCTAssertTrue(app.tabBars.buttons["收藏"].isHittable)
        }
        let timing = XCTAttachment(string: "XCTest tap-to-hittable intervals (includes automation/idle waits, not first-pixel latency): \(intervals)")
        timing.name = "\(label)-open-intervals"; timing.lifetime = .keepAlways; add(timing)
        card.tap()
        app.buttons["editPromptAction"].tap()
        let editor = app.textViews["promptEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertGreaterThan((editor.value as? String ?? "").count, minimumCharacters)
    }

    func testNestedReadingPresentationKeepsItsParent() {
        launch()
        let creator = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'creator-' ")).firstMatch
        creator.tap()
        let card = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-' ")).firstMatch
        reveal(card); card.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        let byline = app.buttons["creatorByline"]
        if !byline.exists { app.expandPromptInformation() }
        reveal(byline); byline.tap()
        XCTAssertTrue(app.buttons["saveCreator"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons.matching(identifier: "saveCreator").allElementsBoundByIndex.contains { $0.isHittable })
        XCTAssertFalse(app.tabBars.buttons["收藏"].isHittable)
        let nestedCard = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-' ")).allElementsBoundByIndex.first { $0.isHittable }!
        reveal(nestedCard); nestedCard.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        app.goBackInPrompix()
        XCTAssertTrue(app.buttons.matching(identifier: "saveCreator").allElementsBoundByIndex.contains { $0.isHittable })
        XCTAssertFalse(app.tabBars.buttons["收藏"].isHittable)
        app.goBackInPrompix()
        XCTAssertTrue(app.buttons["copyPrompt"].isHittable)
        app.goBackInPrompix()
        XCTAssertTrue(app.buttons.matching(identifier: "saveCreator").allElementsBoundByIndex.contains { $0.isHittable })
        XCTAssertTrue(app.tabBars.buttons["收藏"].isHittable)
        capture("nested-reader-return-to-original-creator")
    }

    func testTabsHideInDetailAndRestoreThroughCreator() {
        launch()
        let creator = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'creator-' ")).firstMatch
        XCTAssertTrue(creator.waitForExistence(timeout: 5)); creator.tap()
        XCTAssertTrue(app.buttons["saveCreator"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.tabBars.buttons["收藏"].isHittable)
        capture("refinement-creator-tabs")
        let item = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-' ")).firstMatch
        reveal(item); item.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.tabBars.buttons["收藏"].isHittable)
        app.buttons["closePromptDetail"].tap()
        XCTAssertTrue(app.buttons["saveCreator"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.tabBars.buttons["收藏"].isHittable)
        app.goBackInPrompix()
        XCTAssertTrue(app.buttons["discoveryFilters"].waitForExistence(timeout: 5))
        app.openPrompixSettings()
        XCTAssertTrue(app.buttons["replayOnboarding"].waitForExistence(timeout: 5))
        capture("refinement-live-settings")
        app.buttons["完成"].tap()
        capture("refinement-live-home")
    }

    func testRepeatedCreatorAndTypeNavigation() {
        launch("en")
        for iteration in 0..<20 {
            let creator = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'creator-' ")).firstMatch
            reveal(creator)
            creator.tap()
            XCTAssertTrue(app.buttons["saveCreator"].waitForExistence(timeout: 5))
            app.goBackInPrompix()
            let kind = iteration.isMultiple(of: 2) ? "kind-text" : "kind-image"
            app.buttons[kind].tap()
            XCTAssertFalse(app.buttons["allCreators"].exists)
            XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-' ")).firstMatch.exists)
            app.buttons["kind-all"].tap()
            XCTAssertTrue(app.buttons["allCreators"].exists)
        }
        capture("after-twenty-creator-and-type-round-trips")
    }

    func testTranslatedPromptCopyAndDraftIsolation() {
        launch()
        app.buttons["kind-text"].tap()
        let prompt = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-' ")).firstMatch
        reveal(prompt)
        prompt.tap()
        let menu = app.buttons["contentLanguage"]
        reveal(menu)
        XCTAssertTrue(menu.exists, "This journey requires completed translations in the staged catalog.")
        menu.tap()
        app.buttons["English"].tap()
        capture("07-english-content-selection")
        app.buttons["copyPrompt"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].label.contains("已复制"))
        let edit = app.buttons["editPromptAction"]
        reveal(edit)
        edit.tap()
        let editor = app.textViews["promptEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        let english = editor.value as? String ?? ""
        XCTAssertFalse(english.isEmpty)
        let marker = " PROMPIX-LANGUAGE-DRAFT-TEST "
        editor.tap()
        editor.typeText(marker)
        XCTAssertTrue((editor.value as? String ?? "").contains(marker))
        capture("08-language-specific-editor")
        app.navigationBars.buttons["完成"].tap()
        reveal(menu)
        menu.tap()
        app.buttons["原文"].tap()
        reveal(edit)
        edit.tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        let original = editor.value as? String ?? ""
        XCTAssertFalse(original.contains(marker), "Editing a translation must preserve the original draft.")
        XCTAssertNotEqual(original, english, "Use a Chinese source with a real English translation for this test.")
        capture("09-original-editor-preserved")
        app.navigationBars.buttons["完成"].tap()
        reveal(menu)
        menu.tap()
        app.buttons["English"].tap()
        reveal(edit)
        edit.tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertTrue((editor.value as? String ?? "").contains(marker), "The English draft must survive closing and reopening the editor.")
        app.buttons["编辑选项"].tap()
        app.buttons["恢复当前语言的内容"].tap()
        app.buttons["恢复译文"].tap()
        XCTAssertEqual(editor.value as? String, english)
        app.navigationBars.buttons["完成"].tap()
    }
}

extension XCUIApplication {
    @MainActor func goBackInPrompix() {
        // A reading presentation has an explicit close control; its toolbar's
        // first accessibility element can be Share, not the back chevron.
        if let close = buttons.matching(identifier: "closePromptDetail").allElementsBoundByIndex.first(where: { $0.isHittable }) { close.tap() }
        else { navigationBars.buttons.firstMatch.tap() }
    }

    @MainActor func openPrompixCollections() {
        selectPrompixTab("发现")
        for _ in 0..<5 {
            if buttons["kind-all"].isHittable { break }
            swipeDown()
        }
        if buttons["kind-all"].isHittable { buttons["kind-all"].tap() }
        let all = buttons["allCollections"]
        revealDiscoveryRails()
        for _ in 0..<3 { if all.isHittable { break }; scrollViews["discoveryScroll"].swipeUp(velocity: .slow) }
        XCTAssertTrue(all.isHittable); all.tap()
    }
    @MainActor func expandPromptInformation() {
        let information = buttons["promptInformation"]
        for _ in 0..<40 {
            // Stop above the floating reading actions, which sit over the scroll content.
            if information.isHittable && information.frame.maxY < frame.height * 0.8 { break }
            coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.72))
                .press(forDuration: 0.01, thenDragTo: coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.32)))
        }
        XCTAssertTrue(information.isHittable); information.tap()
    }

    @MainActor func selectPrompixTab(_ title: String) {
        // iPadOS exposes floating native tabs as ordinary buttons.
        let tab = tabBars.buttons[title]
        let target = tab.exists ? tab : buttons.matching(NSPredicate(format: "label == %@", title)).firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 5))
        target.tap()
    }
    /// Creators and uses sit a screen or two into the discover feed.
    @MainActor func revealDiscoveryRails() {
        let rail = buttons["allCreators"], scroll = scrollViews["discoveryScroll"]
        for _ in 0..<10 {
            if rail.exists && rail.isHittable { return }
            scroll.swipeUp(velocity: .slow)
        }
        XCTAssertTrue(rail.isHittable, "The creator rail must be reachable inside the feed")
    }
    /// Settings live in the Saved tab's header.
    @MainActor func openPrompixSettings() {
        selectPrompixTab("收藏")
        let settings = buttons["savedSettings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
    }
}
