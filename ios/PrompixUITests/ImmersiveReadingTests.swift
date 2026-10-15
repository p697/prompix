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
    func testSearchTabFocusesWithoutTappingField() {
        let field = app.searchFields["搜索 Prompt、Skills 或创作者"]
        for index in 0..<4 {
            app.selectPrompixTab("搜索")
            XCTAssertTrue(field.waitForExistence(timeout: 3))
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3), "Search activation \(index) must focus the field automatically")
            // Typing at the app level proves focus without tapping the field.
            app.typeText(index == 0 ? "island\n" : "s\n")
            XCTAssertEqual(field.value as? String, "island" + String(repeating: "s", count: index))
            app.selectPrompixTab(index.isMultiple(of: 2) ? "收藏" : "发现")
        }
        capture("search-autofocus-repeated")
    }

    func testSelectedSearchTabRefocusesAfterSubmission() {
        app.selectPrompixTab("搜索")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        app.typeText("island\n")
        let card = app.buttons["prompt-tiny-island"]
        XCTAssertTrue(card.waitForExistence(timeout: 3))
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
        card.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 3))
        app.buttons["closePromptDetail"].tap()
        XCTAssertTrue(card.waitForExistence(timeout: 3))
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3), "Returning from reading must not replay the previous tab activation")
        app.selectPrompixTab("搜索")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        app.typeText("s")
        XCTAssertEqual(app.searchFields.firstMatch.value as? String, "islands")
    }

    func testDiscoverChromeAndCollectionsNavigation() {
        XCTAssertTrue(app.buttons["discoverySettings"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.tabBars.buttons["专题"].exists)
        capture("immersive-01-home")
        drag(from: 0.78, to: 0.30)
        XCTAssertTrue(NSPredicate(format: "hittable == false").evaluate(with: app.buttons["discoverySettings"]))
        capture("immersive-02-header-hidden")
        drag(from: 0.42, to: 0.60)
        XCTAssertTrue(app.buttons["discoverySettings"].waitForExistence(timeout: 3))
        capture("immersive-03-header-return")
        app.swipeDown(); app.swipeDown()
        let all = app.buttons["allCollections"]
        XCTAssertTrue(all.waitForExistence(timeout: 3)); all.tap()
        XCTAssertTrue(app.buttons["collection-play"].waitForExistence(timeout: 3))
        capture("immersive-04-collections")
        XCTAssertTrue(app.navigationBars.buttons.firstMatch.isHittable)
    }
    func testSearchAndReadingActions() {
        app.selectPrompixTab("搜索")
        let field = app.searchFields["搜索 Prompt、Skills 或创作者"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        capture("immersive-05-search")
        field.tap(); field.typeText("小岛\n")
        let card = app.buttons["prompt-tiny-island"]
        XCTAssertTrue(card.waitForExistence(timeout: 5)); card.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["closePromptDetail"].isHittable)
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
    func testRefinedChromeAndInteractiveReturn() {
        XCTAssertTrue(app.buttons["discoverySettings"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["searchButton"].exists)
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "收藏：")).count, 0)
        capture("refinement-home")
        app.buttons["discoverySettings"].tap()
        XCTAssertTrue(app.buttons["replayOnboarding"].waitForExistence(timeout: 3))
        capture("refinement-settings")
        app.buttons["完成"].tap()
        app.selectPrompixTab("搜索")
        let field = app.searchFields["搜索 Prompt、Skills 或创作者"]
        XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap(); field.typeText("小岛\n")
        let card = app.buttons["prompt-tiny-island"]
        XCTAssertTrue(card.waitForExistence(timeout: 5)); card.tap()
        XCTAssertTrue(app.buttons["usePrompt"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.tabBars.buttons["收藏"].isHittable)
        capture("refinement-detail")
        // A short edge drag cancels the native interactive return.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.48))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.48)), withVelocity: .slow, thenHoldForDuration: 2)
        XCTAssertTrue(app.buttons["usePrompt"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.tabBars.buttons["收藏"].isHittable)
        capture("refinement-cancelled-return")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.48))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.48)), withVelocity: .slow, thenHoldForDuration: 2)
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        XCTAssertTrue(app.tabBars.buttons["收藏"].isHittable)
        capture("refinement-return")
        app.selectPrompixTab("收藏")
        XCTAssertTrue(app.buttons["savedSettings"].waitForExistence(timeout: 3))
        app.selectPrompixTab("发现")
        XCTAssertTrue(app.buttons["discoverySettings"].waitForExistence(timeout: 3))
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
