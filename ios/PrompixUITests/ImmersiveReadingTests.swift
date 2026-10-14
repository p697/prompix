import XCTest
import UIKit

@MainActor final class ImmersiveReadingTests: XCTestCase {
    private let app = XCUIApplication()
    override func setUp() {
        continueAfterFailure = false
        app.launchArguments = ["--offline", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launchPrompix()
    }
    private func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    private func drag(from: CGFloat, to: CGFloat) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: from))
            .press(forDuration: 0.01, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: to)))
    }
    func testDiscoverChromeAndCollectionsNavigation() {
        XCTAssertTrue(app.buttons["searchButton"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.tabBars.buttons["专题"].exists)
        capture("immersive-01-home")
        drag(from: 0.78, to: 0.30)
        XCTAssertTrue(NSPredicate(format: "hittable == false").evaluate(with: app.buttons["searchButton"]))
        capture("immersive-02-header-hidden")
        drag(from: 0.42, to: 0.60)
        XCTAssertTrue(app.buttons["searchButton"].waitForExistence(timeout: 3))
        capture("immersive-03-header-return")
        app.swipeDown(); app.swipeDown()
        let all = app.buttons["allCollections"]
        XCTAssertTrue(all.waitForExistence(timeout: 3)); all.tap()
        XCTAssertTrue(app.buttons["collection-play"].waitForExistence(timeout: 3))
        capture("immersive-04-collections")
        XCTAssertTrue(app.navigationBars.buttons.firstMatch.isHittable)
    }
    func testSearchAndReadingActions() {
        app.buttons["searchButton"].tap()
        let field = app.searchFields["搜索 Prompt、Skills 或创作者"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        capture("immersive-05-search")
        field.tap(); field.typeText("小岛\n")
        let card = app.buttons["prompt-tiny-island"]
        XCTAssertTrue(card.waitForExistence(timeout: 5)); card.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.navigationBars.buttons.firstMatch.isHittable)
        capture("immersive-06-image-detail")
        let expandedWidth = app.buttons["usePrompt"].frame.width
        drag(from: 0.75, to: 0.28)
        XCTAssertTrue(app.otherElements["readingActionsCompact"].waitForExistence(timeout: 3))
        XCTAssertLessThan(app.buttons["usePrompt"].frame.width, expandedWidth - 30)
        capture("immersive-07-reading-compact")
        app.buttons["copyPrompt"].tap()
        XCTAssertEqual(app.buttons["copyPrompt"].label, "已复制")
        drag(from: 0.40, to: 0.62)
        XCTAssertTrue(app.otherElements["readingActionsExpanded"].waitForExistence(timeout: 3))
        capture("immersive-08-reading-return")
        app.buttons["editPromptAction"].tap()
        XCTAssertTrue(app.textViews["promptEditor"].waitForExistence(timeout: 3))
        XCTAssertFalse((app.textViews["promptEditor"].value as? String ?? "").isEmpty)
        capture("immersive-09-editor")
    }
    func testSearchStateAndRecents() {
        app.selectPrompixTab("搜索")
        let field = app.searchFields["搜索 Prompt、Skills 或创作者"]
        XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap(); field.typeText("塔罗\n")
        XCTAssertTrue(app.buttons["prompt-gentle-tarot"].waitForExistence(timeout: 3))
        app.selectPrompixTab("收藏")
        XCTAssertTrue(app.buttons["savedSettings"].waitForExistence(timeout: 3))
        app.selectPrompixTab("搜索")
        capture("immersive-14-search-return")
        field.tap()
        XCTAssertEqual(field.value as? String, "塔罗")
        field.tap(); field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 2))
        XCTAssertTrue(app.buttons["searchSuggestion-塔罗"].waitForExistence(timeout: 3))
        capture("immersive-12-recent-search")
        app.buttons["searchSuggestion-塔罗"].tap()
        app.buttons["prompt-gentle-tarot"].tap()
        app.expandPromptInformation()
        let report = app.descendants(matching: .any)["reportContent"]
        for _ in 0..<5 { if report.isHittable { break }; drag(from: 0.72, to: 0.38) }
        XCTAssertTrue(report.isHittable)
        capture("immersive-13-source-disclosure")
    }
    func testTextBodyIsPrimaryAndUsePanel() {
        app.selectPrompixTab("搜索")
        let field = app.searchFields["搜索 Prompt、Skills 或创作者"]
        XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap(); field.typeText("塔罗\n")
        app.buttons["prompt-gentle-tarot"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["expandPrompt"].exists)
        capture("immersive-10-text-detail")
        app.buttons["usePrompt"].tap()
        XCTAssertTrue(app.buttons["handoffOpen"].waitForExistence(timeout: 3))
        capture("immersive-11-use-sheet")
    }
    func testAccessibleReadingActions() throws {
        guard ProcessInfo.processInfo.environment["PROMPIX_READING_ACCESSIBILITY"] == "1" else {
            throw XCTSkip("Enable largest Dynamic Type, dark appearance and Reduce Motion on the dedicated simulator.")
        }
        XCTAssertTrue(UIAccessibility.isReduceMotionEnabled)
        XCTAssertEqual(UITraitCollection.current.preferredContentSizeCategory, .accessibilityExtraExtraExtraLarge)
        app.selectPrompixTab("搜索")
        let field = app.searchFields["搜索 Prompt、Skills 或创作者"]
        XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap(); field.typeText("塔罗\n")
        app.buttons["prompt-gentle-tarot"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 3))
        for id in ["copyPrompt", "editPromptAction", "usePrompt"] {
            let action = app.buttons[id]
            XCTAssertTrue(action.isHittable)
            XCTAssertGreaterThanOrEqual(action.frame.width, 44)
            XCTAssertGreaterThanOrEqual(action.frame.height, 44)
            XCTAssertTrue(app.frame.contains(action.frame))
        }
        capture("immersive-accessibility-detail")
        try app.performAccessibilityAudit(for: [.hitRegion, .sufficientElementDescription])
        drag(from: 0.75, to: 0.30)
        XCTAssertTrue(app.otherElements["readingActionsCompact"].waitForExistence(timeout: 3))
        capture("immersive-accessibility-reading")
        app.buttons["copyPrompt"].tap()
        XCTAssertEqual(app.buttons["copyPrompt"].label, "已复制")
        app.buttons["editPromptAction"].tap()
        XCTAssertTrue(app.textViews["promptEditor"].waitForExistence(timeout: 3))
    }

}
