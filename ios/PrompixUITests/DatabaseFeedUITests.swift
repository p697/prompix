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

    func testCreatorPreviewSurvivesFailureAndFilteringNeverShowsOldResults() throws {
        launch()
        let root = try directory()
        try Data().write(to: root.appending(path: "hold-creator"))
        let creator = app.buttons["creator-fixture-author-0"]
        XCTAssertTrue(creator.waitForExistence(timeout: 10)); creator.tap()
        let profile = app.scrollViews["creatorProfileScroll"]
        XCTAssertTrue(profile.waitForExistence(timeout: 5))
        XCTAssertTrue(app.links["creatorExternalProfile"].exists || app.buttons["creatorExternalProfile"].exists)
        XCTAssertTrue(profile.buttons["prompt-database-fixture-9975"].waitForExistence(timeout: 3), "Known work should be usable before the profile request completes")
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
        XCTAssertTrue(app.buttons["prompt-database-fixture-75"].waitForExistence(timeout: 10))
        for _ in 0..<3 { if app.buttons["creatorContentFilter"].isHittable { break }; app.swipeDown() }
        try Data().write(to: root.appending(path: "hold-creator"))
        app.buttons["creatorContentFilter"].tap(); app.buttons["图片"].tap()
        XCTAssertTrue(app.otherElements["feedLoading"].waitForExistence(timeout: 3))
        XCTAssertFalse(profile.buttons["prompt-database-fixture-0"].exists, "The previous text item cannot remain under the image filter")
        XCTAssertFalse(app.progressIndicators.firstMatch.exists)
        capture("polish-03-filter-local-placeholder")
        try FileManager.default.removeItem(at: root.appending(path: "hold-creator"))
        XCTAssertTrue(profile.buttons["prompt-database-fixture-225"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.otherElements["feedLoading"].exists)
        app.buttons["creatorContentFilter"].tap(); app.buttons["Skill"].tap()
        XCTAssertTrue(app.staticTexts["暂无匹配内容"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.otherElements["feedLoading"].exists, "A confirmed empty result must stop loading")
        capture("polish-04-confirmed-empty-filter")
        try Data().write(to: root.appending(path: "hold-creator"))
        app.buttons["creatorContentFilter"].tap(); app.buttons["全部"].tap()
        XCTAssertTrue(profile.buttons["prompt-database-fixture-75"].waitForExistence(timeout: 3), "The cached first page must appear while the next network request is held")
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

    func testHomeUsesLatestOrderWithoutLaunchBannerAndPullRefreshes() async throws {
        launch()
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
        XCTAssertTrue(pages.allSatisfy { $0["query"] as? String == "__latest__" && $0["cursor"] as? String == "" })
        XCTAssertFalse(app.otherElements["catalogUpdateStatus"].exists)
        XCTAssertTrue(added.exists)
        capture("refresh-03-new-first-item")
        app.buttons["kind-image"].tap()
        XCTAssertTrue(app.buttons["prompt-database-fixture-9997"].waitForExistence(timeout: 10))
        app.buttons["kind-all"].tap()
        XCTAssertTrue(added.waitForExistence(timeout: 10))
        app.terminate(); launch(["--feed-fixture-offline"])
        XCTAssertTrue(added.waitForExistence(timeout: 10))
        XCTAssertFalse(app.otherElements["catalogUpdateStatus"].exists)
        capture("refresh-04-offline-cache")
    }

    func testProgressiveImageDetailRetainsPreviewAndPositionThenReusesCompleteCache() throws {
        launch(["--feed-detail-preview-test"])
        search("preview")
        let card = app.buttons["prompt-database-fixture-1"]
        XCTAssertTrue(card.waitForExistence(timeout: 10)); card.tap()
        let title = app.staticTexts["detailTitle"]
        XCTAssertTrue(title.waitForExistence(timeout: 3))
        XCTAssertEqual(title.label, "Database item 0001")
        XCTAssertTrue(app.otherElements["promptBodySkeleton"].exists)
        XCTAssertFalse(app.progressIndicators.firstMatch.exists)
        XCTAssertFalse(app.buttons["copyPrompt"].exists)
        capture("progressive-01-image-before-response")
        let pane = app.scrollViews["detailReadingPane"]
        pane.swipeUp(velocity: .slow)
        let pendingY = title.frame.minY
        capture("progressive-02-scrolled-before-response")
        try Data().write(to: directory().appending(path: "release-detail"))
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.otherElements["promptBodySkeleton"].exists)
        XCTAssertEqual(title.frame.minY, pendingY, accuracy: 5, "Completing the body must preserve reading position")
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
            XCTAssertFalse(app.buttons["copyPrompt"].exists)
            capture("progressive-08-preview-type-\(index)")
            try Data().write(to: directory().appending(path: "release-detail"))
            XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 8))
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
        XCTAssertFalse(app.buttons["copyPrompt"].exists)
        XCTAssertFalse(app.progressIndicators.firstMatch.exists)
        capture("progressive-06-inline-error")
        try FileManager.default.removeItem(at: directory().appending(path: "fail-detail"))
        app.buttons["retryDetail"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 8))
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
        XCTAssertTrue(app.buttons["prompt-database-fixture-9999"].waitForExistence(timeout: 15))
        try await Task.sleep(for: .seconds(1))
        let initial = try requests()
        let initialPages = initial.filter { $0["operation"] as? String == "page" }
        XCTAssertGreaterThanOrEqual(initialPages.count, 1)
        XCTAssertTrue(initialPages.allSatisfy { $0["query"] as? String == "__latest__" })
        XCTAssertLessThanOrEqual(initialPages.count, 2,
                                 "Layout may cancel an offscreen request, but cannot repeatedly refetch")
        XCTAssertTrue(initialPages.allSatisfy { $0["cursor"] as? String == "" }, "Initial layout must not fetch subsequent pages")
        XCTAssertFalse(initial.contains { $0["operation"] as? String == "detail" })
        capture("database-01-bounded-first-page")
        for _ in 0..<14 {
            app.swipeUp()
            if try requests().contains(where: { $0["operation"] as? String == "page" && $0["cursor"] as? String == "30" }) { break }
        }
        let pages = try requests().filter { $0["operation"] as? String == "page" }
        XCTAssertTrue(pages.contains { $0["cursor"] as? String == "30" }); XCTAssertLessThan(pages.count, 6)
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
        launch(); firstDetail()
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
        XCTAssertTrue(app.buttons["prompt-database-fixture-9999"].waitForExistence(timeout: 10), "The newest feed must remain available from its offline cache")
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
        XCTAssertTrue(app.buttons["prompt-database-fixture-0"].waitForExistence(timeout: 10))
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
