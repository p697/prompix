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
        let card = app.buttons["prompt-database-fixture-0"]
        XCTAssertTrue(card.waitForExistence(timeout: 15))
        if !card.isHittable { app.swipeUp() }
        card.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 10))
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
        XCTAssertTrue(app.buttons["prompt-gentle-tarot"].waitForExistence(timeout: 20))
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
        XCTAssertTrue(app.buttons["prompt-database-fixture-0"].waitForExistence(timeout: 15))
        try await Task.sleep(for: .seconds(1))
        let initial = try requests()
        XCTAssertEqual(initial.filter { $0["operation"] as? String == "page" }.count, 1, "Initial layout must not drain every page")
        XCTAssertFalse(initial.contains { $0["operation"] as? String == "detail" })
        capture("database-01-bounded-first-page")
        for _ in 0..<14 {
            app.swipeUp()
            if try requests().filter({ $0["operation"] as? String == "page" }).count > 1 { break }
        }
        let pages = try requests().filter { $0["operation"] as? String == "page" }
        XCTAssertGreaterThan(pages.count, 1); XCTAssertLessThan(pages.count, 5)
        capture("database-02-next-page")
        search("tail")
        XCTAssertTrue(app.buttons["prompt-database-fixture-9999"].waitForExistence(timeout: 10))
        app.buttons["prompt-database-fixture-9999"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 10))
        let details = try requests().filter { $0["operation"] as? String == "detail" }
        XCTAssertEqual(details.count, 1)
        XCTAssertEqual(details[0]["query"] as? String, "database-fixture-9999:zh-Hans")
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
        XCTAssertTrue(card.waitForExistence(timeout: 20))
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
        XCTAssertTrue(app.buttons["prompt-database-fixture-0"].waitForExistence(timeout: 10))
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
