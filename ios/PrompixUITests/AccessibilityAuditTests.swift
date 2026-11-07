import XCTest

/// Hit targets and element descriptions across the main screens, on the bundled catalog.
@MainActor final class AccessibilityAuditTests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = true
        app.usePrompixFixture()
        app.launchPrompix()
    }

    func testAccessibilityAcrossMainScreens() throws {
        XCTAssertTrue(app.buttons["discoveryKind"].waitForExistence(timeout: 10))
        try auditScreen("discovery")
        // XCTest can expose automation-only descendants of hidden artwork.
        // Gate the native navigation label here; inspect reading order separately.
        XCTAssertEqual(app.buttons.matching(identifier: "prompt-gentle-tarot").count, 1)
        XCTAssertEqual(app.buttons["prompt-gentle-tarot"].label, "抽一张塔罗，给今天一点新视角")
        app.chooseKind("kind-text")
        app.buttons["prompt-gentle-tarot"].tap()
        try auditScreen("text-detail")
        app.expandPromptInformation()
        let report = app.descendants(matching: .any).matching(identifier: "reportContent").firstMatch
        let readingPane = app.scrollViews["detailReadingPane"]
        func sourceIsVisible() -> Bool {
            guard report.exists, report.isHittable else { return false }
            let viewport = readingPane.exists ? readingPane.frame.intersection(app.frame) : app.frame
            guard !viewport.isNull, viewport.contains(report.frame) else { return false }
            let controls = ["copyPrompt", "editPromptAction", "detailFavorite", "sharePrompt"].map { app.buttons[$0] }
            // A native toolbar accessibility container can span the whole window.
            // Its button frames describe the actual obstructing controls.
            let bars = app.navigationBars.allElementsBoundByIndex + app.toolbars.buttons.allElementsBoundByIndex
            return !(controls + bars).contains { obstacle in
                obstacle.exists && !obstacle.frame.isEmpty && obstacle.frame.intersects(report.frame)
            }
        }
        for _ in 0..<30 {
            if sourceIsVisible() { break }
            let viewport: XCUIElement = readingPane.exists ? readingPane : app
            viewport.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
                .press(forDuration: 0.05, thenDragTo: viewport.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)))
        }
        XCTAssertTrue(sourceIsVisible(), "Source actions must be fully inside the reading pane and clear of native bars and actions before auditing")
        try auditScreen("text-detail-source")
        if app.buttons["detailFavorite"].label != "取消收藏" { app.buttons["detailFavorite"].tap() }
        app.buttons["editPromptAction"].tap()
        XCTAssertTrue(app.textViews["promptEditor"].waitForExistence(timeout: 5))
        // The focused editor's caret blinks, so the screen never holds still; let the sheet land instead.
        Thread.sleep(forTimeInterval: 1.5)
        try auditScreen("editor", settles: false)
        app.buttons["finishPromptEditing"].tap()
        app.goBackInPrompix()
        app.openPrompixCollections()
        try auditScreen("collections")
        app.goBackInPrompix()
        app.selectPrompixTab("收藏")
        try auditScreen("favorites")
        app.buttons["savedSettings"].tap()
        try auditScreen("settings")
        app.swipeUp()
        try auditScreen("settings-support")
        app.buttons["完成"].tap()
        app.selectPrompixTab("搜索")
        // Search focuses its field, so the caret blinks; let the keyboard land instead.
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1)
        try auditScreen("search", settles: false)
    }

    private func auditScreen(_ name: String, settles: Bool = true) throws {
        // Existence can become true before a native push/sheet animation ends.
        // Audit the rendered destination, not a moving overlap of two screens.
        if settles { try waitForRenderingToSettle() }
        capture("accessibility-\(name)")
        // Image-based audits also flag text printed inside media and native
        // translucent bars; stable hit targets and descriptions are the gate.
        try app.performAccessibilityAudit(for: [.hitRegion, .sufficientElementDescription]) { issue in
            print("AUDIT \(name) \(issue.auditType) label=\(issue.element?.label ?? "nil") identifier=\(issue.element?.identifier ?? "nil") frame=\(issue.element?.frame ?? .null)")
            return false
        }
    }

    private func waitForRenderingToSettle() throws {
        let deadline = Date().addingTimeInterval(6)
        var previous: Data?
        var unchangedSince = Date()
        while Date() < deadline {
            let pixels = app.screenshot().pngRepresentation
            if pixels != previous { previous = pixels; unchangedSince = Date() }
            if Date().timeIntervalSince(unchangedSince) >= 0.6 { return }
            Thread.sleep(forTimeInterval: 0.2)
        }
        throw NSError(domain: "PrompixRenderingTest", code: 1, userInfo: [NSLocalizedDescriptionKey: "Screen did not settle before inspection."])
    }
}
