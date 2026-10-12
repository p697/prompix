import XCTest

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
        app.launch()
        XCTAssertTrue(app.buttons["searchButton"].waitForExistence(timeout: 10))
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func reveal(_ element: XCUIElement, attempts: Int = 8) {
        for _ in 0..<attempts {
            // XCTest can report partially covered controls as hittable. Keep
            // their entire target above the detail screen's fixed action bar.
            let copy = app.buttons["copyPrompt"]
            let bottom = copy.exists ? copy.frame.minY - 12 : app.frame.maxY - 100
            if element.exists && element.isHittable && element.frame.minY >= 110 && element.frame.maxY <= bottom { return }
            let scrollDown = element.exists && element.frame.minY < 110
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: scrollDown ? 0.4 : 0.7))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: scrollDown ? 0.7 : 0.4))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        XCTAssertTrue(element.isHittable)
    }

    private func selectSkill() {
        let skill = app.buttons["kind-skill"]
        let picker = app.scrollViews["kindPicker"]
        for _ in 0..<5 {
            let visible = skill.frame.intersection(picker.frame)
            // iOS 27 can throw instead of returning false when an offscreen
            // accessibility button has no activation point.
            if !visible.isNull && visible.width >= min(44, skill.frame.width) && skill.isHittable { break }
            picker.swipeLeft()
        }
        XCTAssertTrue(skill.isHittable)
        skill.tap()
        XCTAssertTrue(skill.isSelected)
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
        reveal(app.buttons["editPrompt"])
        app.buttons["editPrompt"].tap()
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
        reveal(app.buttons["editPrompt"])
        app.buttons["editPrompt"].tap()
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
        app.navigationBars.buttons.element(boundBy: 0).tap()
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
        XCTAssertTrue(app.staticTexts["68"].exists)
        XCTAssertTrue(app.buttons["allCreators"].isHittable)
        XCTAssertTrue(app.buttons["loadCreators"].isHittable)
        capture("legacy-catalog-creator-entry")
        app.buttons["allCreators"].tap()
        XCTAssertTrue(app.buttons["loadCreatorsDirectory"].waitForExistence(timeout: 5))
        capture("legacy-catalog-creator-directory")
    }

    func testRefinedDiscoveryNavigationAndQuickCopy() {
        launch()
        capture("polish-01-home")
        let creator = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'creator-' ")).firstMatch
        XCTAssertTrue(creator.isHittable)
        creator.tap()
        XCTAssertTrue(app.buttons["saveCreator"].waitForExistence(timeout: 5))
        capture("polish-02-creator")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        app.swipeUp(); app.swipeUp()
        let textChannel = app.buttons["kind-text"]
        XCTAssertTrue(textChannel.isHittable, "Content channels stay available while browsing.")
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
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["kind-text"].isSelected)
        app.selectPrompixTab("专题")
        capture("polish-08-collections")
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
            reveal(app.buttons["editPrompt"])
            app.buttons["editPrompt"].tap()
            XCTAssertTrue(app.textViews["promptEditor"].waitForExistence(timeout: 5))
            capture("editorial-\(language)-editor")
            app.terminate()
        }
    }

    func testIndependentProductionContentAndNewSkill() throws {
        guard ProcessInfo.processInfo.environment["PROMPIX_INDEPENDENT_ACCEPTANCE"] == "1" else {
            throw XCTSkip("This journey verifies the live independent-source edition on the dedicated simulator.")
        }
        let before = try acceptanceDirectory()
        let drafts = try? Data(contentsOf: before.appendingPathComponent("drafts.json"))
        launch(online: true)
        let downloaded = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard let directory = try? self.acceptanceDirectory(),
                  let catalog = try? self.readSnapshot(CatalogSnapshot.self, from: directory, file: "catalog.json") else { return false }
            return catalog.prompts.count >= 387 && catalog.prompts.contains { $0.id == "skill-openai-transcribe" }
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [downloaded], timeout: 90), .completed)
        XCTAssertEqual(try? Data(contentsOf: try acceptanceDirectory().appendingPathComponent("drafts.json")), drafts)
        XCTAssertTrue(app.buttons["allCreators"].exists)
        capture("independent-01-refreshed-discovery")
        app.buttons["searchButton"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap(); search.typeText("transcribe")
        let card = app.buttons["prompt-skill-openai-transcribe"]
        reveal(card); card.tap()
        XCTAssertTrue(app.buttons["usePrompt"].waitForExistence(timeout: 5))
        capture("independent-02-new-official-skill")
        app.buttons["usePrompt"].tap()
        XCTAssertTrue(app.buttons["copyInstallCommand"].waitForExistence(timeout: 5))
        app.buttons["copyInstallCommand"].tap()
        capture("independent-03-new-skill-use")
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
            targets = ["image", "video"].compactMap { kind in native.first { $0["kind"] as? String == kind } }
            return targets.count == 2
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [downloaded], timeout: 90), .completed)
        capture("native-x-01-updated-discovery")
        for target in targets {
            let id = try XCTUnwrap(target["id"] as? String)
            let title = try XCTUnwrap(target["title"] as? String)
            let kind = try XCTUnwrap(target["kind"] as? String)
            app.buttons["searchButton"].tap()
            let search = app.searchFields.firstMatch
            XCTAssertTrue(search.waitForExistence(timeout: 5)); search.tap(); search.typeText(title)
            let card = app.buttons["prompt-\(id)"]
            reveal(card); card.tap()
            XCTAssertTrue(app.buttons["usePrompt"].waitForExistence(timeout: 5))
            capture("native-x-\(kind)-detail")
            let original = app.buttons["originalXPost"]
            reveal(original); original.tap()
            capture("native-x-\(kind)-original-post")
            app.buttons["usePrompt"].tap()
            XCTAssertTrue(app.buttons["handoffOpen"].waitForExistence(timeout: 5))
            XCTAssertGreaterThan(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'destination-' ")).count, 0)
            capture("native-x-\(kind)-tool-destination")
            app.buttons["handoffOpen"].tap(); app.activate()
            XCTAssertFalse(app.staticTexts["handoffOpenError"].exists)
            app.navigationBars.buttons["完成"].tap()
            launch()
        }
    }

    func testPromptAndSkillHandoff() {
        launch()
        app.buttons["kind-text"].tap()
        let prompt = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-' ")).firstMatch
        reveal(prompt); prompt.tap()
        let use = app.buttons["usePrompt"]
        XCTAssertTrue(use.waitForExistence(timeout: 5)); use.tap()
        XCTAssertTrue(app.buttons["handoffOpen"].waitForExistence(timeout: 5))
        let alternative = app.buttons["destination-claude"]
        if alternative.exists { alternative.tap(); XCTAssertTrue(alternative.isSelected) }
        app.buttons["handoffCopy"].tap()
        XCTAssertTrue(app.buttons["handoffCopy"].label.contains("已复制"))
        capture("handoff-01-tool-choice")
        app.navigationBars.buttons["完成"].tap()
        use.tap()
        if alternative.exists { XCTAssertTrue(alternative.isSelected) }
        app.buttons["handoffOpen"].tap()
        app.activate()
        XCTAssertFalse(app.staticTexts["handoffOpenError"].exists)
        capture("handoff-02-return-after-opening-tool")
        app.navigationBars.buttons["完成"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        selectSkill()
        let skill = app.buttons["prompt-skill-openai-pdf"]
        reveal(skill); skill.tap()
        app.buttons["usePrompt"].tap()
        XCTAssertTrue(app.buttons["copyInstallCommand"].waitForExistence(timeout: 5))
        app.buttons["copyInstallCommand"].tap()
        XCTAssertTrue(app.buttons["copyInstallCommand"].label.contains("已复制"))
        app.buttons["handoffPreview"].tap()
        capture("handoff-03-pinned-skill-installation")
    }

    func testCreatorAndSkillJourney() {
        launch()
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
        app.selectPrompixTab("发现")
        selectSkill()
        XCTAssertFalse(app.buttons["allCreators"].exists, "Filtering should put results before discovery rails.")
        capture("05-skills-channel")
        let skill = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-skill-' ")).firstMatch
        reveal(skill)
        skill.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        let source = app.descendants(matching: .any).matching(identifier: "skillSource").firstMatch
        reveal(source)
        capture("06-skill-source-and-files")
        app.buttons["copyPrompt"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].label.contains("已复制"))
        app.buttons["detailFavorite"].tap()
    }

    func testNineInterfaceLanguages() {
        let languages = [("en", "English"), ("zh-Hans", "简体中文"), ("zh-Hant", "繁體中文"),
                         ("ja", "日本語"), ("ko", "한국어"), ("es", "Español"),
                         ("pt-BR", "Português (Brasil)"), ("fr", "Français"), ("de", "Deutsch")]
        for (language, contentLanguage) in languages {
            launch(language)
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
            XCTAssertTrue(app.buttons["contentLanguage"].exists)
            XCTAssertTrue(app.buttons["contentLanguage"].label.contains(contentLanguage), "Content must follow the selected interface language.")
            capture("language-\(language)-detail")
            let beforeCopy = app.buttons["copyPrompt"].label
            app.buttons["copyPrompt"].tap()
            XCTAssertNotEqual(app.buttons["copyPrompt"].label, beforeCopy)
            app.terminate()
        }
    }

    private func fullPerformanceCatalog() throws -> CatalogSnapshot {
        guard ProcessInfo.processInfo.environment["PROMPIX_FULL_CATALOG_PERFORMANCE"] == "1" else {
            throw XCTSkip("Stage the complete translated production catalog and run this opt-in probe with the Release configuration.")
        }
        let directory = try acceptanceDirectory()
        let catalog = try readSnapshot(CatalogSnapshot.self, from: directory, file: "catalog.json")
        XCTAssertGreaterThan(catalog.prompts.count, 68, "Performance evidence must exercise the expanded catalog.")
        XCTAssertTrue(catalog.prompts.allSatisfy { !($0.localization?.translations["en"]?.prompt.isEmpty ?? true) },
                      "Use the full translated catalog, not the lightweight legacy fixture.")
        return catalog
    }

    func testTranslatedCatalogProcessLaunchPerformance() throws {
        let catalog = try fullPerformanceCatalog()
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        measure(metrics: [XCTApplicationLaunchMetric(waitUntilResponsive: true)], options: options) {
            app.terminate()
            launch("en")
            XCTAssertTrue(app.staticTexts[catalog.prompts.count.formatted()].exists)
            XCTAssertTrue(app.buttons["allCreators"].exists)
            XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'creator-' ")).firstMatch.exists)
        }
        let directory = try acceptanceDirectory()
        XCTAssertEqual(try readSnapshot(CatalogSnapshot.self, from: directory, file: "catalog.json").version, catalog.version)
        capture("translated-catalog-after-process-launches")
        let evidence = XCTAttachment(string: "Release configuration must be supplied by the runner. Catalog: \(catalog.version), \(catalog.prompts.count) fully English-translated items. Five measured process launches with XCTApplicationLaunchMetric(waitUntilResponsive: true), each verifying catalog count and the creator entry. Catalog refresh is disabled to measure loading the complete persisted catalog. OS, file, and media caches are not cleared; this is not a reboot or an empty-cache cold-start measurement.")
        evidence.name = "translated-catalog-process-launch-scope"
        evidence.lifetime = .keepAlways
        add(evidence)
    }

    func testTranslatedCatalogBrowsingPerformance() throws {
        let catalog = try fullPerformanceCatalog()
        launch("en")
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
        XCTAssertTrue(app.buttons["searchButton"].exists)
        XCTAssertGreaterThan(visitedIDs.count, initialIDs.count)
        let directory = try acceptanceDirectory()
        XCTAssertEqual(try readSnapshot(CatalogSnapshot.self, from: directory, file: "catalog.json").version, catalog.version)
        capture("translated-catalog-after-repeated-scroll")
        let evidence = XCTAttachment(string: "Release configuration must be supplied by the runner. Catalog: \(catalog.version), \(catalog.prompts.count) fully English-translated items. Visible cards sampled: \(visitedIDs.sorted().joined(separator: ", ")). Three rounds of five forward/five reverse viewport drags. Clock and CPU include XCTest gestures and accessibility queries; these are not frame-rate measurements.")
        evidence.name = "translated-catalog-performance-scope"
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

    func testRepeatedCreatorAndTypeNavigation() {
        launch("en")
        for iteration in 0..<20 {
            let creator = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'creator-' ")).firstMatch
            reveal(creator)
            creator.tap()
            XCTAssertTrue(app.buttons["saveCreator"].waitForExistence(timeout: 5))
            app.navigationBars.buttons.element(boundBy: 0).tap()
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
        let edit = app.buttons["editPrompt"]
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
    @MainActor func selectPrompixTab(_ title: String) {
        // iPadOS exposes floating native tabs as ordinary buttons.
        let tab = tabBars.buttons[title]
        let target = tab.exists ? tab : buttons.matching(NSPredicate(format: "label == %@", title)).firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 5))
        target.tap()
    }
}
