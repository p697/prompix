import XCTest
import UIKit

@MainActor final class DatabaseFeedUITests: XCTestCase {
    private let app = XCUIApplication()
    private var fixtureID = ""
    override func setUp() {
        continueAfterFailure = false
        fixtureID = UUID().uuidString
    }
    private func launch(_ options: [String] = []) {
        app.launchArguments = ["--feed-fixture", fixtureID, "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh-Hans"] + options
        app.launchPrompix()
        XCTAssertTrue(app.buttons["discoverySettings"].waitForExistence(timeout: 15))
    }
    private var firstFixtureCard: XCUIElement {
        app.scrollViews["discoveryScroll"].buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-database-fixture-'" )).firstMatch
    }
    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
    private func directory() throws -> URL {
        let parent = URL(fileURLWithPath: NSHomeDirectory()).deletingLastPathComponent()
        let simulator = try XCTUnwrap(ProcessInfo.processInfo.environment["SIMULATOR_UDID"])
        guard parent.path.hasSuffix("/CoreSimulator/Devices/\(simulator)/data/Containers/Data/Application") else {
            throw CocoaError(.fileReadNoPermission)
        }
        let matches = try FileManager.default.contentsOfDirectory(at: parent, includingPropertiesForKeys: nil).filter { candidate in
            guard let data = try? Data(contentsOf: candidate.appending(path: ".com.apple.mobile_container_manager.metadata.plist")),
                  let value = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else { return false }
            return value["MCMMetadataIdentifier"] as? String == "com.p697.prompix"
        }
        XCTAssertEqual(matches.count, 1)
        return try XCTUnwrap(matches.first).appending(path: "Library/Caches/FeedAcceptance").appending(path: fixtureID)
    }
    private func requests() throws -> [[String: Any]] {
        let data = try Data(contentsOf: directory().appending(path: "requests.jsonl"))
        return try data.split(separator: 10).map { try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0)) as? [String: Any]) }
    }
    private func search(_ query: String) {
        app.selectPrompixTab("搜索")
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap()
        if field.buttons["清除文本"].exists { field.buttons["清除文本"].tap() }
        field.typeText(query + "\n")
    }
    private func firstDetail() {
        search("preview")
        let card = app.buttons["prompt-database-fixture-0"]
        XCTAssertTrue(card.waitForExistence(timeout: 15))
        if !card.isHittable { app.swipeUp() }
        card.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 10))
    }

    func testRecommendedRefreshRotatesSessionAndOffersLocalInterests() async throws {
        launch(["--feed-visual-mix-test"])
        func seeds() -> [String] {
            (try? requests().filter { $0["operation"] as? String == "recommendation-session" }.compactMap { $0["query"] as? String }) ?? []
        }
        for _ in 0..<60 {
            if seeds().count >= 3 { break }
            try await Task.sleep(for: .milliseconds(200))
        }
        let first = try XCTUnwrap(seeds().first)
        XCTAssertEqual(Set(seeds()), [first])
        XCTAssertFalse(app.staticTexts["10,000"].exists)
        capture("recommendations-home")
        let scroll = app.scrollViews["discoveryScroll"]
        scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.93)), withVelocity: .slow, thenHoldForDuration: 0.2)
        for _ in 0..<60 {
            if Set(seeds()).count >= 2 { break }
            try await Task.sleep(for: .milliseconds(200))
        }
        XCTAssertGreaterThanOrEqual(Set(seeds()).count, 2, "Pull refresh must create a new candidate session")
        scroll.swipeUp(); capture("recommendations-refreshed-feed")
        scroll.swipeDown()
        let settings = app.buttons["discoverySettings"]
        if !settings.isHittable { scroll.swipeDown() }
        settings.tap()
        let preferences = app.buttons["recommendationPreferences"]
        for _ in 0..<4 { if preferences.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(preferences.waitForExistence(timeout: 5)); preferences.tap()
        XCTAssertTrue(app.buttons["interest-portrait"].waitForExistence(timeout: 5))
        for id in ["portrait", "product", "illustration"] { app.buttons["interest-\(id)"].tap() }
        XCTAssertTrue(app.buttons["interest-portrait"].isSelected)
        capture("recommendations-local-interests")
    }

    func testVisibleCardsLearnExposureWithoutCountingThePrefetchedPool() async throws {
        launch(["--feed-visual-mix-test"])
        let root = try directory()
        let scroll = app.scrollViews["discoveryScroll"]
        XCTAssertTrue(firstFixtureCard.waitForExistence(timeout: 15))
        scroll.swipeUp(velocity: .slow)
        var seen: [String] = []
        for _ in 0..<30 {
            if let bytes = try? Data(contentsOf: root.appending(path: "recommendation-preferences.json")),
               let value = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
               let entries = value["entries"] as? [String: [String: Any]] {
                seen = entries.filter { $0.value["seenAt"] != nil }.map(\.key)
            }
            if !seen.isEmpty { break }
            try await Task.sleep(for: .milliseconds(200))
        }
        XCTAssertFalse(seen.isEmpty, "Visible feed cards must produce durable exposure learning")
        XCTAssertLessThan(seen.count, 30, "Prefetching three cloud pages must not count them all as viewed")
        XCTAssertTrue(seen.allSatisfy { $0.hasPrefix("database-fixture-") })
        capture("recommendations-visible-exposure")
    }

    func testSearchTabFocusAndTextSurviveRepeatedSwitches() {
        launch()
        for index in 0..<4 {
            app.selectPrompixTab("搜索")
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
            app.typeText(index == 0 ? "preview\n" : "s\n")
            XCTAssertEqual(app.searchFields.firstMatch.value as? String, "preview" + String(repeating: "s", count: index))
            app.selectPrompixTab(index.isMultiple(of: 2) ? "收藏" : "发现")
        }
        capture("database-search-autofocus")
    }

    func testSearchWithPublishedLegacyCache() throws {
        guard let path = ProcessInfo.processInfo.environment["PROMPIX_SEARCH_BENCHMARK_CATALOG"] else {
            throw XCTSkip("Requires an external published catalog in an isolated simulator namespace.")
        }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        launch(); app.terminate()
        try data.write(to: directory().appending(path: "catalog.json"), options: .atomic)
        app.launchArguments = ["--feed-legacy-test", fixtureID, "--cached-only", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh-Hans"]
        app.launchPrompix()
        XCTAssertTrue(app.buttons["discoverySettings"].waitForExistence(timeout: 10))
        app.selectPrompixTab("搜索")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        app.typeText("portrait\n")
        XCTAssertTrue(app.staticTexts["searchResultCount"].waitForExistence(timeout: 5))
        app.selectPrompixTab("收藏"); app.selectPrompixTab("搜索")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        XCTAssertEqual(app.searchFields.firstMatch.value as? String, "portrait")
        app.typeText("zzzzzz")
        XCTAssertTrue(app.staticTexts["没有找到相关内容"].waitForExistence(timeout: 5))
        app.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 6))
        XCTAssertTrue(app.staticTexts["searchResultCount"].waitForExistence(timeout: 5))
        capture("legacy-published-search-focus-and-latest-results")
    }

    func testLiveHomeShowsVisualCardsAcrossTheFirstTwoFeedScreens() async throws {
        guard ProcessInfo.processInfo.environment["PROMPIX_DATABASE_LIVE_UI"] == "1" else { throw XCTSkip("Explicit live API verification only") }
        app.launchArguments = ["--feed-live-test", fixtureID, "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh-Hans"]
        app.launchPrompix()
        let first = app.scrollViews["discoveryScroll"].buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-'" )).firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 30))
        capture("visual-live-01-home")
        let scroll = app.scrollViews["discoveryScroll"]
        for screen in 1...2 {
            scroll.swipeUp(velocity: .slow)
            let visible = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-'"))
                .allElementsBoundByIndex.filter(\.isHittable).map { String($0.identifier.dropFirst(7)) }
            var visualCount = 0
            for id in Set(visible) {
                let (bytes, response) = try await URLSession.shared.data(from: URL(string: "https://api.prompix.dev/v3/contents/\(id)?locale=zh-Hans")!)
                XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
                let detail = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
                let item = try XCTUnwrap(detail["item"] as? [String: Any])
                let media = item["media"] as? [String: Any]
                if media?["imageURL"] is String || media?["image"] is String { visualCount += 1 }
            }
            XCTAssertGreaterThanOrEqual(visualCount, 2, "Each visible feed screen must include real visual cards")
            capture("visual-live-feed-screen-\(screen)")
        }
    }

    func testHomeBlendsVisualWorkBeforeNewTextBatchAndCanSwitchToLatest() throws {
        launch(["--feed-visual-mix-test"])
        let firstVisual = firstFixtureCard
        XCTAssertTrue(firstVisual.waitForExistence(timeout: 15))
        let ids = try XCTUnwrap(requests().first { $0["operation"] as? String == "visual-page-items" }?["query"] as? String)
        let firstIDs = ids.split(separator: ",").compactMap { Int($0) }
        XCTAssertEqual(firstIDs.count, 30)
        XCTAssertTrue(firstIDs.prefix(4).allSatisfy { $0 < 9970 && $0 % 4 != 0 })
        XCTAssertEqual(firstIDs.filter { $0 < 9970 && $0 % 4 != 0 }.count, 24)
        XCTAssertTrue(try requests().contains { $0["operation"] as? String == "page" && $0["query"] as? String == "__discovery__" })
        capture("visual-feed-01-home")
        let scroll = app.scrollViews["discoveryScroll"]
        scroll.swipeUp(); capture("visual-feed-02-first-screen")
        scroll.swipeUp(); capture("visual-feed-03-second-screen")
        app.terminate(); launch(["--feed-visual-mix-test"])
        app.buttons["discoveryFilters"].tap(); app.buttons["最新收录"].tap()
        XCTAssertTrue(app.buttons["prompt-database-fixture-9999"].waitForExistence(timeout: 10))
        XCTAssertTrue(try requests().contains { $0["operation"] as? String == "page" && $0["query"] as? String == "__latest__" })
        capture("visual-feed-04-explicit-latest")
        app.buttons["discoveryFilters"].tap(); app.buttons["推荐"].tap()
        XCTAssertTrue(firstVisual.waitForExistence(timeout: 10))
    }

    func testHomeSkeletonsKeepSectionAnchorsThroughIndependentResponses() throws {
        launch(["--feed-home-loading-test"])
        let root = try directory()
        let creators = app.buttons["allCreators"], collections = app.buttons["allCollections"]
        let heading = app.buttons["discoveryFilters"]
        XCTAssertTrue(collections.waitForExistence(timeout: 5))
        XCTAssertTrue(heading.waitForExistence(timeout: 5))
        let anchors = [creators.frame.minY, collections.frame.minY, heading.frame.minY]
        func checkAnchors() {
            for (index, value) in [creators.frame.minY, collections.frame.minY, heading.frame.minY].enumerated() {
                XCTAssertEqual(value, anchors[index], accuracy: 1, "Section \(index) moved during loading")
            }
        }
        capture("home-loading-01-all-skeletons")
        try FileManager.default.removeItem(at: root.appending(path: "hold-directory"))
        XCTAssertTrue(app.buttons["creator-fixture-author-0"].waitForExistence(timeout: 8))
        checkAnchors(); capture("home-loading-02-creators-ready")
        try FileManager.default.removeItem(at: root.appending(path: "hold-browse"))
        try FileManager.default.removeItem(at: root.appending(path: "hold-feed-refresh"))
        XCTAssertTrue(firstFixtureCard.waitForExistence(timeout: 15))
        checkAnchors(); capture("home-loading-03-loaded")
        app.terminate(); launch(["--feed-fixture-offline"])
        XCTAssertTrue(app.buttons["creator-fixture-author-0"].waitForExistence(timeout: 8))
        checkAnchors(); capture("home-loading-04-cached-offline")
    }

    func testOfflineRecoveryKeepsCardsVisibleWhileRetrying() throws {
        launch(["--feed-home-loading-test"])
        let root = try directory()
        try Data().write(to: root.appending(path: "fail-feed-refresh"))
        for gate in ["directory", "browse", "feed-refresh"] {
            try FileManager.default.removeItem(at: root.appending(path: "hold-" + gate))
        }
        let retry = app.buttons["retryFeed"]
        XCTAssertTrue(retry.waitForExistence(timeout: 12))
        let scroll = app.scrollViews["discoveryScroll"]
        for _ in 0..<3 { if retry.isHittable { break }; scroll.swipeUp(velocity: .slow) }
        XCTAssertTrue(retry.isHittable)
        let card = app.buttons["prompt-gentle-tarot"]
        XCTAssertTrue(card.exists, "A failed first page must immediately offer real offline content")
        XCTAssertFalse(app.staticTexts["内容更新未完成"].exists)
        XCTAssertFalse(app.progressIndicators.firstMatch.exists)
        XCTAssertLessThanOrEqual(retry.frame.height, 60)
        capture("quantum-01-quiet-offline-recovery")
        try Data().write(to: root.appending(path: "hold-feed-refresh"))
        try FileManager.default.removeItem(at: root.appending(path: "fail-feed-refresh"))
        retry.tap()
        XCTAssertTrue(card.exists, "Retry must not replace usable offline cards with a loading page")
        XCTAssertFalse(app.buttons["retryFeed"].exists)
        capture("quantum-02-retry-preserves-offline-cards")
        try FileManager.default.removeItem(at: root.appending(path: "hold-feed-refresh"))
        XCTAssertTrue(firstFixtureCard.waitForExistence(timeout: 12))
        XCTAssertFalse(app.buttons["retryFeed"].exists)
        capture("quantum-03-connected-feed")
    }

    func testOfflineFallbackHonorsLocalDismissals() throws {
        launch(["--feed-home-loading-test"])
        let root = try directory()
        app.terminate()
        let preferences: [String: Any] = ["version": 1, "interests": [], "learningEnabled": true, "reduceSuggestive": true,
            "entries": ["gentle-tarot": ["topics": ["lifestyle"], "kind": "text", "updatedAt": Date().timeIntervalSinceReferenceDate,
                                        "saved": false, "used": false, "dismissed": true]]]
        try JSONSerialization.data(withJSONObject: preferences).write(to: root.appending(path: "recommendation-preferences.json"), options: .atomic)
        launch(["--feed-home-loading-test"])
        try Data().write(to: root.appending(path: "fail-feed-refresh"))
        for gate in ["directory", "browse", "feed-refresh"] {
            try FileManager.default.removeItem(at: root.appending(path: "hold-" + gate))
        }
        XCTAssertTrue(app.buttons["retryFeed"].waitForExistence(timeout: 12))
        XCTAssertTrue(app.staticTexts["离线可用的内容"].exists)
        XCTAssertFalse(app.buttons["prompt-gentle-tarot"].exists, "Offline recommendations must not resurrect dismissed content")
        capture("recommendations-offline-dismissal")
    }

    func testHomeFailureAndRetryKeepReservedSpace() throws {
        launch(["--feed-home-loading-test"])
        let root = try directory()
        let collections = app.buttons["allCollections"], heading = app.buttons["discoveryFilters"]
        XCTAssertTrue(heading.waitForExistence(timeout: 5))
        let positions = [collections.frame.minY, heading.frame.minY]
        for gate in ["directory", "browse"] {
            try Data().write(to: root.appending(path: "fail-" + gate))
            try FileManager.default.removeItem(at: root.appending(path: "hold-" + gate))
        }
        try FileManager.default.removeItem(at: root.appending(path: "hold-feed-refresh"))
        XCTAssertTrue(app.buttons["loadCreators"].waitForExistence(timeout: 10))
        XCTAssertTrue(firstFixtureCard.waitForExistence(timeout: 10))
        XCTAssertEqual(collections.frame.minY, positions[0], accuracy: 1)
        XCTAssertEqual(heading.frame.minY, positions[1], accuracy: 1)
        capture("home-loading-failed")
        try FileManager.default.removeItem(at: root.appending(path: "fail-directory"))
        app.buttons["loadCreators"].tap()
        XCTAssertTrue(app.buttons["creator-fixture-author-0"].waitForExistence(timeout: 10))
        XCTAssertEqual(collections.frame.minY, positions[0], accuracy: 1)
        XCTAssertEqual(heading.frame.minY, positions[1], accuracy: 1)
        capture("home-loading-recovered")
    }

    func testCreatorDirectoryControlsRemainReachableAtLargestText() throws {
        guard ProcessInfo.processInfo.environment["PROMPIX_CREATOR_ACCESSIBILITY"] == "1" else { throw XCTSkip("Explicit largest-text acceptance only") }
        launch()
        app.buttons["allCreators"].tap()
        let filter = app.buttons["creatorDirectoryFilter"], sort = app.buttons["creatorDirectorySort"]
        XCTAssertTrue(filter.waitForExistence(timeout: 10)); XCTAssertTrue(filter.isHittable); XCTAssertTrue(sort.isHittable)
        filter.tap(); app.buttons["网页"].tap()
        sort.tap(); app.buttons["作品数量"].tap()
        XCTAssertTrue(app.buttons["creator-fixture-author-0"].waitForExistence(timeout: 10))
        capture("creator-directory-largest-text-dark")
    }

    func testLiveCreatorDiscoveryShowsVisualWorksAndFiltersDirectory() throws {
        guard ProcessInfo.processInfo.environment["PROMPIX_DATABASE_LIVE_UI"] == "1" else { throw XCTSkip("Explicit live API verification only") }
        app.launchArguments = ["--feed-live-test", fixtureID, "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh-Hans"]
        app.launchPrompix()
        let first = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'creator-'")).firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 25))
        capture("creator-live-home")
        first.tap()
        XCTAssertTrue(app.scrollViews["creatorProfileScroll"].waitForExistence(timeout: 10))
        capture("creator-live-profile")
        if app.buttons["BackButton"].exists { app.buttons["BackButton"].tap() }
        else { app.navigationBars.buttons.element(boundBy: 0).tap() }
        app.buttons["allCreators"].tap()
        XCTAssertTrue(app.buttons["creatorDirectoryFilter"].waitForExistence(timeout: 10))
        app.buttons["creatorDirectoryFilter"].tap(); app.buttons["视频"].tap()
        XCTAssertTrue(first.waitForExistence(timeout: 20))
        capture("creator-live-video-directory")
        app.buttons["creatorDirectorySort"].tap(); app.buttons["最近更新"].tap()
        XCTAssertTrue(first.waitForExistence(timeout: 20))
        capture("creator-live-latest-directory")
        app.swipeDown()
        XCTAssertTrue(first.waitForExistence(timeout: 20))
    }

    func testCreatorDirectoryFiltersSortsSearchesAndOpensMatchingWorks() throws {
        launch(["--feed-detail-preview-test"])
        app.buttons["allCreators"].tap()
        XCTAssertTrue(app.buttons["creatorDirectoryFilter"].waitForExistence(timeout: 10))
        app.buttons["creatorDirectoryFilter"].tap(); app.buttons["视频"].tap()
        XCTAssertTrue(app.buttons["creator-fixture-author-0"].waitForExistence(timeout: 10))
        app.buttons["creatorDirectorySort"].tap(); app.buttons["名称"].tap()
        let field = app.searchFields.firstMatch
        field.tap(); field.typeText("Database Author 49\n")
        let author = app.buttons["creator-fixture-author-49"]
        XCTAssertTrue(author.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["creator-fixture-author-0"].exists)
        capture("creator-directory-filtered-search")
        author.tap()
        let profile = app.scrollViews["creatorProfileScroll"]
        XCTAssertTrue(profile.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["creatorContentFilter"].exists)
        XCTAssertTrue(try requests().contains { $0["operation"] as? String == "creatorWorks" && $0["query"] as? String == "fixture-author-49:video" })
        capture("creator-profile-filter-retained")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["creatorDirectorySort"].waitForExistence(timeout: 5))
        XCTAssertTrue(try requests().contains { $0["operation"] as? String == "creatorDiscovery" && $0["query"] as? String == "database author 49:video:name" })
        app.buttons["creatorDirectoryFilter"].tap(); app.buttons["Skill"].tap()
        XCTAssertTrue(app.staticTexts["未找到结果"].waitForExistence(timeout: 5) || !app.buttons["creator-fixture-author-49"].exists)
        capture("creator-directory-empty-filter")
    }

    func testCreatorPreviewSurvivesFailureAndFilteringNeverShowsOldResults() throws {
        launch()
        let root = try directory()
        try Data().write(to: root.appending(path: "hold-creator"))
        let creator = app.buttons["creator-fixture-author-0"]
        XCTAssertTrue(creator.waitForExistence(timeout: 10)); creator.tap()
        let profile = app.scrollViews["creatorProfileScroll"]
        XCTAssertTrue(profile.waitForExistence(timeout: 5))
        XCTAssertTrue(app.links["creatorExternalProfile"].exists || app.buttons["creatorExternalProfile"].exists)
        XCTAssertTrue(profile.buttons["prompt-database-fixture-0"].waitForExistence(timeout: 3), "Known work should be usable before the profile request completes")
        XCTAssertFalse(app.progressIndicators.firstMatch.exists)
        capture("polish-01-known-work-before-response")
        try Data().write(to: root.appending(path: "fail-creator"))
        try FileManager.default.removeItem(at: root.appending(path: "hold-creator"))
        let retry = app.buttons["retryFeed"]
        for _ in 0..<3 { if retry.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        capture("polish-02-inline-profile-failure")
        try FileManager.default.removeItem(at: root.appending(path: "fail-creator"))
        retry.tap()
        XCTAssertTrue(retry.waitForNonExistence(timeout: 10))
        let loaded = profile.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-database-fixture-'" )).firstMatch
        XCTAssertTrue(loaded.waitForExistence(timeout: 10))
        let loadedID = loaded.identifier
        for _ in 0..<3 { if app.buttons["creatorContentFilter"].isHittable { break }; app.swipeDown() }
        try Data().write(to: root.appending(path: "hold-creator"))
        app.buttons["creatorContentFilter"].tap(); app.buttons["图片"].tap()
        XCTAssertTrue(app.otherElements["feedLoading"].waitForExistence(timeout: 3))
        XCTAssertFalse(profile.buttons["prompt-database-fixture-0"].exists, "The previous text item cannot remain under the image filter")
        XCTAssertFalse(app.progressIndicators.firstMatch.exists)
        capture("polish-03-filter-local-placeholder")
        try FileManager.default.removeItem(at: root.appending(path: "hold-creator"))
        XCTAssertTrue(profile.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-database-fixture-'" )).firstMatch.waitForExistence(timeout: 10))
        XCTAssertFalse(app.otherElements["feedLoading"].exists)
        app.buttons["creatorContentFilter"].tap(); app.buttons["Skill"].tap()
        XCTAssertTrue(app.staticTexts["暂无匹配内容"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.otherElements["feedLoading"].exists, "A confirmed empty result must stop loading")
        capture("polish-04-confirmed-empty-filter")
        try Data().write(to: root.appending(path: "hold-creator"))
        app.buttons["creatorContentFilter"].tap(); app.buttons["全部"].tap()
        XCTAssertTrue(profile.buttons[loadedID].waitForExistence(timeout: 3), "The cached first page must appear while the next network request is held")
        XCTAssertFalse(app.otherElements["feedLoading"].exists)
        capture("polish-08-cache-before-refresh")
        try FileManager.default.removeItem(at: root.appending(path: "hold-creator"))
    }

    func testCreatorDirectoryUsesLocalPlaceholdersAndClearsPreviousQuery() throws {
        launch()
        app.buttons["allCreators"].tap()
        XCTAssertTrue(app.buttons["creator-fixture-author-0"].waitForExistence(timeout: 10))
        let root = try directory()
        try Data().write(to: root.appending(path: "hold-directory"))
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap(); field.typeText("Database Author 49\n")
        XCTAssertTrue(app.otherElements["creatorLoading"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["creator-fixture-author-0"].exists)
        XCTAssertFalse(app.progressIndicators.firstMatch.exists)
        capture("polish-05-directory-placeholder")
        try FileManager.default.removeItem(at: root.appending(path: "hold-directory"))
        XCTAssertTrue(app.buttons["creator-fixture-author-49"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.otherElements["creatorLoading"].exists)
    }

    func testExplorationChangesScopePagesAndKeepsItsSelectionWhenReturning() throws {
        launch(); firstDetail()
        let pane = app.scrollViews["detailReadingPane"]
        for _ in 0..<6 { if app.buttons["explore-model"].isHittable { break }; pane.swipeUp() }
        let model = app.buttons["explore-model"]
        XCTAssertTrue(model.waitForExistence(timeout: 5)); model.tap()
        XCTAssertTrue(app.buttons["prompt-database-fixture-4"].waitForExistence(timeout: 10))
        capture("polish-06-model-exploration")
        app.buttons["allExplorationResults"].tap()
        XCTAssertTrue(app.scrollViews["explorationResults"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.scrollViews["explorationResults"].buttons["prompt-database-fixture-0"].exists, "The starting item should not recommend itself")
        for _ in 0..<16 {
            app.swipeUp()
            if try requests().contains(where: { $0["operation"] as? String == "scopedPage" && $0["query"] as? String == "Model 0" && $0["cursor"] as? String == "30" }) { break }
        }
        XCTAssertTrue(try requests().contains { $0["operation"] as? String == "scopedPage" && $0["query"] as? String == "Model 0" && $0["cursor"] as? String == "30" })
        capture("polish-07-full-model-results-page-two")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(model.waitForExistence(timeout: 5)); XCTAssertTrue(model.isSelected)
        app.buttons["closePromptDetail"].tap()
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(app.searchFields.firstMatch.value as? String, "preview")
    }

    func testCategorySwitchUsesWarmPagesAndCancelsColdRequest() throws {
        launch()
        XCTAssertTrue(firstFixtureCard.waitForExistence(timeout: 15))
        let allID = firstFixtureCard.identifier
        let settings = app.buttons["discoverySettings"], top = settings.frame.minY
        app.buttons["kind-image"].tap()
        XCTAssertTrue(firstFixtureCard.waitForExistence(timeout: 10))
        let imageID = firstFixtureCard.identifier
        app.buttons["kind-video"].tap()
        XCTAssertTrue(firstFixtureCard.waitForExistence(timeout: 10))
        let videoID = firstFixtureCard.identifier
        let before = try requests().filter { $0["operation"] as? String == "page-start" && ($0["cursor"] as? String ?? "").isEmpty }.count
        let gate = try directory().appending(path: "hold-feed-refresh")
        try Data().write(to: gate)
        defer { try? FileManager.default.removeItem(at: gate) }
        for _ in 0..<3 {
            for (kind, id) in [("image", imageID), ("video", videoID), ("all", allID)] {
                app.buttons["kind-" + kind].tap()
                XCTAssertTrue(app.buttons[id].exists)
                XCTAssertEqual(settings.frame.minY, top, accuracy: 1)
                XCTAssertFalse(app.descendants(matching: .any)["feedLoading"].exists)
            }
        }
        let after = try requests().filter { $0["operation"] as? String == "page-start" && ($0["cursor"] as? String ?? "").isEmpty }.count
        XCTAssertEqual(after, before, "Warm category switches must not clear/refetch their pages")
        capture("filter-warm-all")
        app.buttons["kind-text"].tap()
        XCTAssertFalse(app.buttons[videoID].exists)
        XCTAssertFalse(app.buttons[imageID].exists)
        XCTAssertEqual(settings.frame.minY, top, accuracy: 1)
        XCTAssertTrue(app.descendants(matching: .any)["feedLoading"].exists)
        capture("filter-cold-placeholder")
        app.buttons["kind-image"].tap()
        XCTAssertTrue(app.buttons[imageID].exists)
        try FileManager.default.removeItem(at: gate)
        app.buttons["kind-image"].tap() // Repeated selection is a no-op.
        XCTAssertTrue(app.buttons[imageID].exists)
        XCTAssertEqual(firstFixtureCard.identifier, imageID)
        capture("filter-warm-image-after-cancellation")
    }

    func testDiscoveryHeaderCollapsesRevealsAndResetsAfterFiltering() throws {
        launch()
        let scroll = app.scrollViews["discoveryScroll"]
        let settings = app.buttons["discoverySettings"]
        XCTAssertTrue(firstFixtureCard.waitForExistence(timeout: 15))
        XCTAssertTrue(settings.isHittable)
        let expandedSettingsTop = settings.frame.minY
        scroll.swipeUp(velocity: .slow)
        scroll.swipeUp(velocity: .slow)
        capture("header-01-collapsed")
        XCTAssertFalse(settings.isHittable)
        XCTAssertLessThan(settings.frame.maxY, expandedSettingsTop, "Forward reading must move the header out of the content area")
        scroll.swipeDown(velocity: .slow)
        XCTAssertEqual(settings.frame.minY, expandedSettingsTop, accuracy: 1)
        // XCTest reports this SwiftUI overlay as non-hittable after scrolling
        // despite its visible frame. Verify the actual touch and opened sheet.
        capture("header-02-revealed")
        settings.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["replayOnboarding"].waitForExistence(timeout: 5), "Revealed settings must respond to a real tap")
        app.buttons["完成"].tap()
        app.buttons["kind-image"].tap()
        XCTAssertTrue(firstFixtureCard.waitForExistence(timeout: 10))
        XCTAssertTrue(settings.isHittable)
        capture("header-03-filter-reset")
        scroll.swipeUp(velocity: .slow)
        XCTAssertFalse(settings.isHittable)
        XCTAssertLessThan(settings.frame.maxY, expandedSettingsTop)
        scroll.swipeDown(velocity: .slow)
        app.buttons["kind-all"].tap()
        XCTAssertTrue(app.buttons["creator-fixture-author-0"].waitForExistence(timeout: 5))
        XCTAssertTrue(settings.isHittable)
    }

    func testHomeUsesLatestOrderWithoutLaunchBannerAndPullRefreshes() async throws {
        launch()
        app.buttons["discoveryFilters"].tap()
        app.buttons["最新收录"].tap()
        let newest = app.buttons["prompt-database-fixture-9999"]
        XCTAssertTrue(newest.waitForExistence(timeout: 15))
        XCTAssertFalse(app.otherElements["catalogUpdateStatus"].exists)
        XCTAssertFalse(app.staticTexts["latestContentHeading"].exists)
        XCTAssertFalse(app.buttons["showLatestFeed"].exists)
        capture("refresh-01-quiet-home")
        let before = try requests().filter { $0["operation"] as? String == "page" }.count
        let gate = try directory().appending(path: "hold-feed-refresh")
        try Data().write(to: gate)
        defer { try? FileManager.default.removeItem(at: gate) }
        try Data().write(to: directory().appending(path: "publish-new-item"))
        // XCTest waits for the native refresh animation to settle after a
        // gesture. Release the slow response off the main actor so that wait
        // cannot deadlock the test's own server gate.
        let release = Task.detached {
            try await Task.sleep(for: .seconds(8))
            try FileManager.default.removeItem(at: gate)
        }
        defer { release.cancel() }
        let scroll = app.scrollViews["discoveryScroll"]
        scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9)), withVelocity: .slow, thenHoldForDuration: 0.2)
        try await release.value
        XCTAssertTrue(try requests().filter { $0["operation"] as? String == "state" }.count >= 2)
        let added = app.buttons["prompt-database-fixture-10000"]
        XCTAssertTrue(added.waitForExistence(timeout: 10))
        let pages = try requests().filter { $0["operation"] as? String == "page" }
        XCTAssertEqual(pages.count, before + 1)
        XCTAssertTrue(pages.dropFirst(before).allSatisfy { $0["query"] as? String == "__latest__" && $0["cursor"] as? String == "" })
        XCTAssertFalse(app.otherElements["catalogUpdateStatus"].exists)
        XCTAssertTrue(added.exists)
        capture("refresh-03-new-first-item")
        app.buttons["kind-image"].tap()
        XCTAssertTrue(app.buttons["prompt-database-fixture-9997"].waitForExistence(timeout: 10))
        app.buttons["kind-all"].tap()
        XCTAssertTrue(added.waitForExistence(timeout: 10))
        app.terminate(); launch(["--feed-fixture-offline"])
        app.buttons["discoveryFilters"].tap(); app.buttons["最新收录"].tap()
        XCTAssertTrue(added.waitForExistence(timeout: 10))
        XCTAssertFalse(app.otherElements["catalogUpdateStatus"].exists)
        capture("refresh-04-offline-cache")
    }

    func testMediaPrewarmsBeyondVisibleCardsWithoutFetchingEntirePage() throws {
        launch(["--feed-image-prefetch-test"])
        search("preview")
        XCTAssertTrue(app.buttons["prompt-database-fixture-1"].waitForExistence(timeout: 10))
        let file = try directory().appending(path: "image-requests.txt")
        let recorded = try String(contentsOf: file, encoding: .utf8).split(separator: "\n").compactMap { Int($0) }.filter { $0 < 30 }
        let visible = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-database-fixture-'")).allElementsBoundByIndex
            .filter { $0.isHittable }.compactMap { Int($0.identifier.replacingOccurrences(of: "prompt-database-fixture-", with: "")) }
        let lastVisible = try XCTUnwrap(visible.max())
        XCTAssertTrue(recorded.contains { $0 > lastVisible + 1 }, "A future thumbnail should already be downloaded")
        XCTAssertLessThan(try XCTUnwrap(recorded.max()), 25, "Lookahead must not eagerly fetch the whole page")
        let evidence = XCTAttachment(string: "Visible card indices: \(visible); downloaded thumbnails: \(recorded)")
        evidence.name = "media-lookahead-requests"; evidence.lifetime = .keepAlways; add(evidence)
        capture("motion-05-image-lookahead")
    }

    func testNextPageStartsBeforeFooterAndStopsAfterLeavingEdge() throws {
        launch()
        search("preview")
        XCTAssertTrue(app.buttons["prompt-database-fixture-0"].waitForExistence(timeout: 10))
        let root = try directory()
        try Data().write(to: root.appending(path: "hold-next-page"))
        let scroll = app.scrollViews["searchResults"]
        var requested = false
        for _ in 0..<18 {
            let start = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.78))
            start.press(forDuration: 0.05, thenDragTo: scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.48)))
            requested = try requests().contains { $0["operation"] as? String == "page-start" && $0["query"] as? String == "preview" && $0["cursor"] as? String == "30" }
            if requested { break }
        }
        XCTAssertTrue(requested, "Page two should start before the reader reaches the footer")
        XCTAssertFalse(app.buttons["loadMoreFeed"].isHittable, "Request should start with about a screen still to read")
        capture("motion-01-prefetch-before-footer")
        app.swipeUp()
        capture("motion-02-paging-activity")
        try FileManager.default.removeItem(at: root.appending(path: "hold-next-page"))
        XCTAssertTrue(app.buttons["prompt-database-fixture-30"].waitForExistence(timeout: 8))
        let pages = try requests().filter { $0["operation"] as? String == "page-start" && $0["query"] as? String == "preview" && $0["cursor"] as? String != "" }
        XCTAssertEqual(pages.count, 1, "An appended page must not automatically drain the catalog")
    }

    func testSavedLayoutSharesSettingsPositionAndPreservesSearch() throws {
        launch()
        let settingsFrame = app.buttons["discoverySettings"].frame
        firstDetail()
        app.buttons["detailFavorite"].tap()
        app.buttons["closePromptDetail"].tap()
        app.selectPrompixTab("收藏")
        let savedSettings = app.buttons["savedSettings"]
        XCTAssertTrue(savedSettings.waitForExistence(timeout: 5))
        XCTAssertEqual(savedSettings.frame.minX, settingsFrame.minX, accuracy: 1)
        XCTAssertEqual(savedSettings.frame.minY, settingsFrame.minY, accuracy: 1)
        let card = app.buttons["prompt-database-fixture-0"]
        XCTAssertTrue(card.isHittable)
        capture("motion-03-saved-gallery")
        let field = app.searchFields.firstMatch
        field.tap(); field.typeText("no-matching-item\n")
        XCTAssertFalse(card.exists)
        app.buttons["savedCreatorsScope"].tap()
        XCTAssertFalse(card.exists)
        capture("motion-04-saved-search-empty")
    }

    func testSavedLayoutAtAccessibilityTextKeepsControlsReachable() throws {
        launch(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        firstDetail()
        app.buttons["detailFavorite"].tap()
        app.buttons["closePromptDetail"].tap()
        app.selectPrompixTab("收藏")
        XCTAssertTrue(app.buttons["savedSettings"].isHittable)
        XCTAssertTrue(app.searchFields.firstMatch.isHittable)
        XCTAssertTrue(app.buttons["savedPromptsScope"].isHittable)
        XCTAssertTrue(app.buttons["savedCreatorsScope"].isHittable)
        let filter = app.buttons["savedKindFilter"]
        XCTAssertTrue(filter.isHittable)
        XCTAssertFalse(filter.frame.intersects(app.buttons["savedCreatorsScope"].frame))
        capture("motion-accessibility-saved")
        try app.performAccessibilityAudit(for: [.hitRegion, .sufficientElementDescription])
        app.buttons["savedSettings"].tap()
        XCTAssertTrue(app.buttons["replayOnboarding"].waitForExistence(timeout: 5))
    }

    func testProgressiveImageDetailRetainsPreviewAndPositionThenReusesCompleteCache() async throws {
        launch(["--feed-detail-preview-test"])
        search("preview")
        let card = app.buttons["prompt-database-fixture-1"]
        XCTAssertTrue(card.waitForExistence(timeout: 10)); card.tap()
        let title = app.staticTexts["detailTitle"]
        XCTAssertTrue(title.waitForExistence(timeout: 3))
        XCTAssertEqual(title.label, "Database item 0001")
        XCTAssertTrue(app.otherElements["promptBodySkeleton"].exists)
        XCTAssertFalse(app.progressIndicators.firstMatch.exists)
        XCTAssertTrue(app.buttons["copyPrompt"].exists)
        XCTAssertFalse(app.buttons["copyPrompt"].isEnabled)
        XCTAssertTrue(app.buttons["usePrompt"].exists)
        XCTAssertTrue(app.buttons["sharePrompt"].exists)
        XCTAssertTrue(app.buttons["detailFavorite"].exists)
        capture("progressive-01-image-before-response")
        let pane = app.scrollViews["detailReadingPane"]
        pane.swipeUp(velocity: .slow)
        for _ in 0..<30 {
            if app.buttons["usePrompt"].frame.width < 80 { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        let pendingY = title.frame.minY
        let pendingActionWidth = app.buttons["usePrompt"].frame.width
        XCTAssertLessThan(pendingActionWidth, 80, "Scrolling a pending detail should collapse its actions")
        capture("progressive-02-scrolled-before-response")
        try Data().write(to: directory().appending(path: "release-detail"))
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["copyPrompt"].wait(for: \.isEnabled, toEqual: true, timeout: 8))
        XCTAssertFalse(app.otherElements["promptBodySkeleton"].exists)
        XCTAssertEqual(title.frame.minY, pendingY, accuracy: 5, "Completing the body must preserve reading position")
        XCTAssertEqual(app.buttons["usePrompt"].frame.width, pendingActionWidth, accuracy: 2, "Body completion must preserve the compact action bar")
        capture("progressive-03-complete-same-position")
        app.buttons["closePromptDetail"].tap()
        XCTAssertTrue(card.waitForExistence(timeout: 5)); card.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.otherElements["promptBodySkeleton"].exists)
        XCTAssertEqual(try requests().filter { $0["operation"] as? String == "detail" }.count, 1)
        capture("progressive-04-memory-cache")
    }

    func testProgressiveVideoAndWebPreviewDoNotWaitForBodyOrStartPlayback() throws {
        launch(["--feed-detail-preview-test"])
        search("preview")
        for index in [2, 3] {
            let card = app.buttons["prompt-database-fixture-\(index)"]
            XCTAssertTrue(card.waitForExistence(timeout: 10))
            if !card.isHittable { app.swipeUp() }
            card.tap()
            XCTAssertTrue(app.staticTexts["detailTitle"].waitForExistence(timeout: 3))
            XCTAssertEqual(app.staticTexts["detailTitle"].label, String(format: "Database item %04d", index))
            XCTAssertTrue(app.otherElements["promptBodySkeleton"].exists)
            XCTAssertFalse(app.progressIndicators.firstMatch.exists)
            XCTAssertTrue(app.buttons["copyPrompt"].exists)
            XCTAssertFalse(app.buttons["copyPrompt"].isEnabled)
            XCTAssertTrue(app.buttons["usePrompt"].exists)
            XCTAssertTrue(app.buttons["sharePrompt"].exists)
            XCTAssertTrue(app.buttons["detailFavorite"].exists)
            capture("progressive-08-preview-type-\(index)")
            try Data().write(to: directory().appending(path: "release-detail"))
            XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 8))
            XCTAssertTrue(app.buttons["copyPrompt"].wait(for: \.isEnabled, toEqual: true, timeout: 8))
            XCTAssertTrue(app.buttons["previewButton"].exists)
            capture("progressive-09-ready-type-\(index)")
            app.buttons["closePromptDetail"].tap()
            try FileManager.default.removeItem(at: directory().appending(path: "release-detail"))
        }
    }

    func testProgressiveTextFailureRetriesInlineAndCanCloseWhilePending() throws {
        launch(["--feed-detail-preview-test"])
        search("preview")
        let card = app.buttons["prompt-database-fixture-0"]
        XCTAssertTrue(card.waitForExistence(timeout: 10)); card.tap()
        XCTAssertTrue(app.otherElements["promptBodySkeleton"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.progressIndicators.firstMatch.exists)
        capture("progressive-05-text-before-response")
        app.buttons["closePromptDetail"].tap()
        XCTAssertTrue(card.waitForExistence(timeout: 5)); card.tap()
        XCTAssertTrue(app.otherElements["promptBodySkeleton"].waitForExistence(timeout: 3))
        try Data().write(to: directory().appending(path: "fail-detail"))
        try Data().write(to: directory().appending(path: "release-detail"))
        XCTAssertTrue(app.buttons["retryDetail"].waitForExistence(timeout: 8))
        XCTAssertEqual(app.staticTexts["detailTitle"].label, "Database item 0000")
        XCTAssertTrue(app.buttons["copyPrompt"].exists)
        XCTAssertFalse(app.buttons["copyPrompt"].isEnabled)
        XCTAssertTrue(app.buttons["usePrompt"].exists)
        XCTAssertTrue(app.buttons["sharePrompt"].exists)
        XCTAssertTrue(app.buttons["detailFavorite"].exists)
        XCTAssertFalse(app.progressIndicators.firstMatch.exists)
        capture("progressive-06-inline-error")
        try FileManager.default.removeItem(at: directory().appending(path: "fail-detail"))
        app.buttons["retryDetail"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["copyPrompt"].wait(for: \.isEnabled, toEqual: true, timeout: 8))
        XCTAssertEqual(app.staticTexts["detailTitle"].label, "Database item 0000")
        capture("progressive-07-recovered")
    }

    func testAccessibleExplorationKeepsPathsAndResultsReachable() throws {
        guard ProcessInfo.processInfo.environment["PROMPIX_EXPLORATION_ACCESSIBILITY"] == "1" else { throw XCTSkip("Explicit largest-text acceptance only") }
        XCTAssertEqual(UIApplication.shared.preferredContentSizeCategory, .accessibilityExtraExtraExtraLarge)
        launch(); firstDetail()
        let pane = app.scrollViews["detailReadingPane"]
        for _ in 0..<16 { if app.buttons["explore-model"].isHittable { break }; pane.swipeUp() }
        let model = app.buttons["explore-model"]
        XCTAssertTrue(model.isHittable); model.tap(); capture("polish-accessibility-01-paths")
        for _ in 0..<8 { if app.buttons["allExplorationResults"].isHittable { break }; pane.swipeDown() }
        XCTAssertTrue(app.buttons["allExplorationResults"].isHittable); app.buttons["allExplorationResults"].tap()
        let results = app.scrollViews["explorationResults"]
        XCTAssertTrue(results.waitForExistence(timeout: 5))
        XCTAssertTrue(results.buttons["prompt-database-fixture-4"].waitForExistence(timeout: 10))
        capture("polish-accessibility-02-results")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(model.waitForExistence(timeout: 5))
    }

    func testLiveCreatorAndContextualExploration() throws {
        guard ProcessInfo.processInfo.environment["PROMPIX_DATABASE_LIVE_UI"] == "1" else { throw XCTSkip("Explicit live acceptance only") }
        app.launchArguments = ["--feed-live-test", fixtureID, "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh-Hans"]
        app.launchPrompix()
        XCTAssertTrue(app.buttons["discoverySettings"].waitForExistence(timeout: 15))
        capture("polish-live-01-home")
        search("盐水礼服")
        let card = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-'")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 20)); card.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 20))
        let pane = app.scrollViews["detailReadingPane"]
        for _ in 0..<6 { if app.buttons["creatorByline"].isHittable { break }; pane.swipeUp() }
        XCTAssertTrue(app.buttons["creatorByline"].waitForExistence(timeout: 5)); app.buttons["creatorByline"].tap()
        let profile = app.scrollViews["creatorProfileScroll"]
        XCTAssertTrue(profile.waitForExistence(timeout: 5))
        XCTAssertTrue(profile.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-'")).firstMatch.waitForExistence(timeout: 20))
        capture("polish-live-02-creator")
        app.navigationBars.buttons.firstMatch.tap()
        for _ in 0..<18 { if app.buttons["explore-model"].isHittable { break }; pane.swipeUp() }
        XCTAssertTrue(app.buttons["explore-model"].waitForExistence(timeout: 5))
        capture("polish-live-03-continue-exploring")
        app.buttons["explore-model"].tap(); app.buttons["allExplorationResults"].tap()
        let results = app.scrollViews["explorationResults"]
        XCTAssertTrue(results.waitForExistence(timeout: 5))
        XCTAssertTrue(results.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-'")).firstMatch.waitForExistence(timeout: 20))
        capture("polish-live-04-model-results")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.buttons["explore-model"].isSelected)
        app.buttons["closePromptDetail"].tap()
        XCTAssertEqual(app.searchFields.firstMatch.value as? String, "盐水礼服")
    }

    func testLiveImageAndLongVideoDetailReuseSearchPreviews() throws {
        guard ProcessInfo.processInfo.environment["PROMPIX_DATABASE_LIVE_UI"] == "1" else { throw XCTSkip("Explicit live acceptance only") }
        app.launchArguments = ["--feed-live-test", fixtureID, "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh-Hans"]
        app.launchPrompix()
        XCTAssertTrue(app.buttons["discoverySettings"].waitForExistence(timeout: 15))
        for (query, id) in [("给想逃离", "tiny-island"), ("把品牌网站变成", "x-post-2109576638136795289")] {
            search(query)
            let card = app.buttons["prompt-\(id)"]
            XCTAssertTrue(card.waitForExistence(timeout: 20))
            let label = card.label, before = card.frame
            card.tap()
            XCTAssertTrue(app.staticTexts["detailTitle"].waitForExistence(timeout: 3))
            XCTAssertEqual(app.staticTexts["detailTitle"].label, label)
            XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 20))
            capture("progressive-live-\(id)")
            app.buttons["closePromptDetail"].tap()
            XCTAssertTrue(card.waitForExistence(timeout: 5))
            XCTAssertEqual(card.frame.minY, before.minY, accuracy: 5)
            card.tap()
            XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 3))
            XCTAssertFalse(app.otherElements["promptBodySkeleton"].exists)
            app.buttons["closePromptDetail"].tap()
        }
    }

    func testLiveDatabaseSearchDetailCopyAndOfflineFavorite() async throws {
        guard ProcessInfo.processInfo.environment["PROMPIX_DATABASE_LIVE_UI"] == "1" else { throw XCTSkip("Explicit live acceptance only") }
        func openLive(offline: Bool = false) {
            app.launchArguments = ["--feed-live-test", fixtureID, "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh-Hans"]
            if offline { app.launchArguments += ["--simulate-network-failure"] }
            app.launchPrompix()
            XCTAssertTrue(app.buttons["discoverySettings"].waitForExistence(timeout: 15))
        }
        openLive()
        let (feedData, feedResponse) = try await URLSession.shared.data(from: URL(string: "https://api.prompix.dev/v3/feed?sort=latest&locale=zh-Hans&limit=30")!)
        XCTAssertEqual((feedResponse as? HTTPURLResponse)?.statusCode, 200)
        let feedJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: feedData) as? [String: Any])
        let firstID = try XCTUnwrap((feedJSON["items"] as? [[String: Any]])?.first?["id"] as? String)
        XCTAssertTrue(app.buttons["prompt-" + firstID].waitForExistence(timeout: 20))
        capture("database-live-01-production-home")
        search("塔罗")
        let card = app.buttons["prompt-gentle-tarot"]
        XCTAssertTrue(card.waitForExistence(timeout: 20)); card.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 20))
        app.buttons["copyPrompt"].tap()
        XCTAssertEqual(app.buttons["copyPrompt"].label, "已复制")
        let (data, response) = try await URLSession.shared.data(from: URL(string: "https://api.prompix.dev/v3/contents/gentle-tarot?locale=zh-Hans")!)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let item = try XCTUnwrap(raw["item"] as? [String: Any])
        let translation = ((item["localization"] as? [String: Any])?["translations"] as? [String: Any])?["zh-Hans"] as? [String: Any]
        let copied = try XCTUnwrap(translation?["prompt"] as? String ?? item["prompt"] as? String)
        try Data(copied.utf8).write(to: directory().appending(path: "expected-copy.txt"))
        app.buttons["detailFavorite"].tap()
        let saved = try Data(contentsOf: directory().appending(path: "favorites.json"))
        capture("database-live-02-production-detail")
        app.terminate(); openLive(offline: true)
        app.selectPrompixTab("收藏")
        XCTAssertTrue(card.waitForExistence(timeout: 10)); card.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 10))
        app.buttons["copyPrompt"].tap()
        XCTAssertEqual(app.buttons["copyPrompt"].label, "已复制")
        XCTAssertEqual(try Data(contentsOf: directory().appending(path: "favorites.json")), saved)
        capture("database-live-03-offline-favorite")
    }

    func testTenThousandItemFeedOnlyFetchesVisiblePagesAndSearchesBeyondLoadedItems() async throws {
        launch()
        XCTAssertTrue(firstFixtureCard.waitForExistence(timeout: 15))
        try await Task.sleep(for: .seconds(1))
        let initial = try requests()
        let initialPages = initial.filter { $0["operation"] as? String == "page" }
        XCTAssertEqual(initialPages.count, 3)
        XCTAssertTrue(initialPages.allSatisfy { $0["query"] as? String == "__discovery__" })
        XCTAssertLessThanOrEqual(initialPages.count, 3,
                                 "Layout may cancel an offscreen request, but cannot repeatedly refetch")
        XCTAssertEqual(initialPages.compactMap { $0["cursor"] as? String }, ["", "30", "60"], "First layout gets one bounded candidate pool")
        XCTAssertFalse(initial.contains { $0["operation"] as? String == "detail" })
        capture("database-01-bounded-first-page")
        for _ in 0..<42 {
            app.swipeUp()
            if try requests().contains(where: { $0["operation"] as? String == "page" && $0["cursor"] as? String == "90" }) { break }
        }
        let pages = try requests().filter { $0["operation"] as? String == "page" }
        XCTAssertTrue(pages.contains { $0["cursor"] as? String == "90" }); XCTAssertLessThanOrEqual(pages.count, 6)
        capture("database-02-next-page")
        search("tail")
        XCTAssertTrue(app.buttons["prompt-database-fixture-9999"].waitForExistence(timeout: 10))
        app.buttons["prompt-database-fixture-9999"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 10))
        let details = try requests().filter { $0["operation"] as? String == "detail" }
        XCTAssertEqual(details.count, 1)
        XCTAssertEqual(details[0]["query"] as? String, "database-fixture-9999:zh-Hans")
        XCTAssertTrue(app.otherElements["relatedFeed"].waitForExistence(timeout: 10))
        capture("database-03-search-last-item-detail")
    }

    func testLiveLegacyCacheUpgradePreservesPersonalData() async throws {
        guard ProcessInfo.processInfo.environment["PROMPIX_DATABASE_LIVE_UI"] == "1" else { throw XCTSkip("Explicit live acceptance only") }
        func open(_ mode: String) {
            app.launchArguments = [mode, fixtureID, "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh-Hans"]
            app.launchPrompix()
            XCTAssertTrue(app.buttons["discoverySettings"].waitForExistence(timeout: 15))
        }
        open("--feed-legacy-test")
        let path = try directory()
        var catalog: [String: Any]?
        for _ in 0..<45 {
            if let data = try? Data(contentsOf: path.appending(path: "catalog.json")),
               let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               (value["version"] as? String)?.hasPrefix("edition-v2-") == true { catalog = value; break }
            try await Task.sleep(for: .seconds(1))
        }
        let old = try XCTUnwrap(catalog, "Legacy client must finish downloading the actual v2 edition")
        XCTAssertGreaterThan((old["prompts"] as? [Any])?.count ?? 0, 500)
        search("塔罗")
        let card = app.buttons["prompt-gentle-tarot"]
        XCTAssertTrue(card.waitForExistence(timeout: 10)); card.tap()
        XCTAssertTrue(app.buttons["detailFavorite"].waitForExistence(timeout: 10)); app.buttons["detailFavorite"].tap()
        app.buttons["editPromptAction"].tap()
        let editor = app.textViews["promptEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5)); editor.tap()
        editor.typeText("Legacy upgrade keeps this personal draft.")
        app.buttons["finishPromptEditing"].tap()
        let favorites = try Data(contentsOf: path.appending(path: "favorites.json"))
        let drafts = try Data(contentsOf: path.appending(path: "drafts.json"))
        let legacyCatalog = try Data(contentsOf: path.appending(path: "catalog.json"))
        capture("database-upgrade-01-legacy-v2")
        app.terminate(); open("--feed-live-test")
        app.selectPrompixTab("收藏")
        XCTAssertTrue(card.waitForExistence(timeout: 10)); card.tap()
        XCTAssertTrue(app.buttons["editPromptAction"].waitForExistence(timeout: 10)); app.buttons["editPromptAction"].tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertTrue((editor.value as? String ?? "").contains("Legacy upgrade keeps this personal draft."))
        XCTAssertEqual(try Data(contentsOf: path.appending(path: "favorites.json")), favorites)
        XCTAssertEqual(try Data(contentsOf: path.appending(path: "drafts.json")), drafts)
        XCTAssertEqual(try Data(contentsOf: path.appending(path: "catalog.json")), legacyCatalog, "Database refresh must not rewrite the old full-catalog fallback")
        capture("database-upgrade-02-feed-preserved-draft")
    }

    func testFavoriteDraftAndLanguageSurviveOfflineRestartWithoutFullCatalog() throws {
        launch()
        XCTAssertTrue(firstFixtureCard.waitForExistence(timeout: 15))
        let cachedFirstID = firstFixtureCard.identifier
        firstDetail()
        app.buttons["copyPrompt"].tap()
        XCTAssertEqual(app.buttons["copyPrompt"].label, "已复制")
        app.buttons["detailFavorite"].tap()
        app.buttons["editPromptAction"].tap()
        let editor = app.textViews["promptEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertEqual(editor.value as? String, "  Original fixture 0\nPreserve whitespace and [topic].\n")
        editor.tap(); editor.typeText("Personal draft survives offline.")
        app.buttons["finishPromptEditing"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        app.buttons["contentLanguage"].tap(); app.buttons["contentLanguage-ja"].tap()
        XCTAssertTrue(app.staticTexts["AI 译文"].waitForExistence(timeout: 10))
        let saved = try Data(contentsOf: directory().appending(path: "favorites.json"))
        let drafts = try Data(contentsOf: directory().appending(path: "drafts.json"))
        capture("database-04-language-and-personal-data")
        app.terminate(); launch(["--feed-fixture-offline"])
        XCTAssertTrue(app.buttons[cachedFirstID].waitForExistence(timeout: 10), "The same recommendation session must remain available from its offline cache")
        XCTAssertTrue(try requests().contains { $0["offline"] as? Bool == true })
        app.selectPrompixTab("收藏")
        let savedCard = app.buttons["prompt-database-fixture-0"]
        XCTAssertTrue(savedCard.waitForExistence(timeout: 5)); savedCard.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        app.buttons["editPromptAction"].tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertTrue((editor.value as? String ?? "").contains("Personal draft survives offline."))
        XCTAssertEqual(try Data(contentsOf: directory().appending(path: "favorites.json")), saved)
        XCTAssertEqual(try Data(contentsOf: directory().appending(path: "drafts.json")), drafts)
        capture("database-05-offline-draft")
    }

    func testCreatorDirectoryAndCollectionUseTheirOwnPaginatedQueries() throws {
        launch()
        let creators = app.buttons["allCreators"]
        XCTAssertTrue(creators.waitForExistence(timeout: 15)); creators.tap()
        XCTAssertTrue(app.buttons["creator-fixture-author-0"].waitForExistence(timeout: 10))
        for _ in 0..<14 {
            app.swipeUp()
            if try requests().contains(where: { $0["operation"] as? String == "creators" && $0["cursor"] as? String == "30" }) { break }
        }
        XCTAssertTrue(try requests().contains { $0["operation"] as? String == "creators" && $0["cursor"] as? String == "30" })
        capture("database-06-creator-next-page")
        app.navigationBars.buttons.firstMatch.tap()
        let topic = app.buttons["home-collection-portraits"]
        XCTAssertTrue(topic.waitForExistence(timeout: 5)); topic.tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-database-fixture-'" )).firstMatch.waitForExistence(timeout: 10))
        capture("database-07-collection")
    }

    func testSearchFailureRetriesAndOldQueryCannotReplaceCurrentResults() async throws {
        launch(); search("retry")
        let retry = app.buttons["retryFeed"]
        XCTAssertTrue(retry.waitForExistence(timeout: 10))
        let ready = NSPredicate(format: "enabled == true")
        let enabled = expectation(for: ready, evaluatedWith: retry)
        await fulfillment(of: [enabled], timeout: 6)
        retry.tap()
        XCTAssertTrue(app.buttons["prompt-database-fixture-0"].waitForExistence(timeout: 10))
        search("slow"); search("current")
        XCTAssertTrue(app.buttons["prompt-database-fixture-9999"].waitForExistence(timeout: 10))
        try await Task.sleep(for: .seconds(3))
        XCTAssertTrue(app.buttons["prompt-database-fixture-9999"].exists)
        XCTAssertFalse(app.buttons["prompt-database-fixture-0"].exists)
        capture("database-08-current-query-after-late-response")
    }
}
