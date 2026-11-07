import XCTest

extension XCUIApplication {
    /// The bundled catalog, offline, in Simplified Chinese, with a data directory
    /// of its own so saved works, versions and decks never carry over between tests.
    @MainActor func usePrompixFixture(onboarded: Bool = true) {
        launchArguments = ["--offline", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN", "--ui-test-data", UUID().uuidString]
        if !onboarded { launchArguments.append("--reset-onboarding") }
    }
    /// Journeys begin in discovery; onboarding has its own test.
    @MainActor func launchPrompix() {
        if !launchArguments.contains("-hasCompletedOnboarding") {
            launchArguments += ["-hasCompletedOnboarding", "YES"]
        }
        launch()
    }
    /// Discovery's kind is a menu in the row above the feed; search keeps its own bar.
    @MainActor func chooseKind(_ id: String) {
        let choice = buttons[id]
        if choice.exists && choice.isHittable { choice.tap(); return }
        let menu = buttons["discoveryKind"]
        for _ in 0..<5 { if menu.exists && menu.isHittable { break }; swipeDown() }
        menu.tap()
        XCTAssertTrue(choice.waitForExistence(timeout: 3)); choice.tap()
    }
    @MainActor func isKind(_ id: String) -> Bool {
        if buttons[id].exists { return buttons[id].isSelected }
        let titles = ["kind-all": "全部", "kind-image": "图片", "kind-video": "视频", "kind-text": "文本"]
        return buttons["discoveryKind"].value as? String == titles[id]
    }
    @MainActor func selectPrompixTab(_ title: String) {
        // iPadOS exposes floating native tabs as ordinary buttons.
        func target() -> XCUIElement {
            let tab = tabBars.buttons[title]
            return tab.exists ? tab : buttons.matching(NSPredicate(format: "label == %@", title)).firstMatch
        }
        // Scrolling minimizes the tab bar to the current tab; tapping that tab brings the others back.
        if !target().waitForExistence(timeout: 1) {
            let current = tabBars.buttons.matching(NSPredicate(format: "selected == true")).firstMatch
            if current.exists { current.tap() }
        }
        let tab = target()
        XCTAssertTrue(tab.waitForExistence(timeout: 5))
        tab.tap()
    }
    @MainActor func goBackInPrompix() {
        // A reading presentation has an explicit close control; its toolbar's
        // first accessibility element can be Share, not the back chevron.
        if let close = buttons.matching(identifier: "closePromptDetail").allElementsBoundByIndex.first(where: { $0.isHittable }) { close.tap(); return }
        // A slow simulator can still be finishing the push that shows the back button.
        let back = navigationBars.buttons.firstMatch
        XCTAssertTrue(back.waitForExistence(timeout: 5)); back.tap()
    }
    /// Creators and uses sit after the twelfth work in the discover feed.
    @MainActor func revealDiscoveryRails() {
        let rail = buttons["allCreators"], scroll = scrollViews["discoveryScroll"]
        for _ in 0..<10 {
            if rail.exists && rail.isHittable { return }
            scroll.swipeUp(velocity: .slow)
        }
        XCTAssertTrue(rail.isHittable, "The creator rail must be reachable inside the feed")
    }
    @MainActor func openPrompixCollections() {
        selectPrompixTab("发现")
        if !isKind("kind-all") { chooseKind("kind-all") }
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
}

extension XCTestCase {
    func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}
