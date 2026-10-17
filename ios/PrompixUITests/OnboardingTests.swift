import XCTest

extension XCUIApplication {
    /// Existing journeys begin in discovery; onboarding has separate coverage.
    @MainActor func launchPrompix() {
        if !launchArguments.contains("-hasCompletedOnboarding") {
            launchArguments += ["-hasCompletedOnboarding", "YES"]
        }
        launch()
    }
}

@MainActor final class OnboardingTests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
        app.launchArguments = ["--offline", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh-Hans", "--reset-onboarding"]
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testWelcomeNavigationCompletionAndReplay() {
        app.launch()
        XCTAssertTrue(app.buttons["onboardingNext"].waitForExistence(timeout: 10))
        capture("cosmos-01-welcome")
        app.buttons["onboardingNext"].tap()
        XCTAssertTrue(app.staticTexts["onboarding-title-1"].waitForExistence(timeout: 3))
        capture("cosmos-02-collect")
        app.buttons["onboardingBack"].tap()
        XCTAssertTrue(app.staticTexts["onboarding-title-0"].exists)
        app.buttons["onboardingNext"].tap()
        app.buttons["onboardingNext"].tap()
        app.buttons["onboardingNext"].tap()
        XCTAssertTrue(app.buttons["interest-portrait"].waitForExistence(timeout: 3))
        for id in ["portrait", "illustration", "product"] { app.buttons["interest-\(id)"].tap() }
        XCTAssertTrue(app.buttons["onboardingComplete"].waitForExistence(timeout: 3))
        capture("cosmos-04-interests")
        app.buttons["onboardingComplete"].tap()
        XCTAssertTrue(app.buttons["onboardingComplete"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["discoverySettings"].waitForExistence(timeout: 5))
        capture("cosmos-04-discover")

        // Remove the first-run reset to verify this run's persisted completion.
        app.terminate()
        app.launchArguments.removeLast()
        app.launch()
        XCTAssertTrue(app.buttons["discoverySettings"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["onboardingNext"].exists)
        app.buttons["设置"].tap()
        app.buttons["replayOnboarding"].tap()
        XCTAssertTrue(app.buttons["onboardingNext"].waitForExistence(timeout: 3))
        app.buttons["onboardingSkip"].tap()
        XCTAssertTrue(app.buttons["onboardingSkip"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["replayOnboarding"].waitForExistence(timeout: 3))
    }

    func testSkipPreservesDiscoveryAccess() {
        app.launch()
        XCTAssertTrue(app.buttons["onboardingSkip"].waitForExistence(timeout: 10))
        app.buttons["onboardingSkip"].tap()
        XCTAssertTrue(app.buttons["onboardingSkip"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["discoverySettings"].waitForExistence(timeout: 5))
        app.buttons["kind-text"].tap()
        XCTAssertTrue(app.buttons["prompt-gentle-tarot"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["prompt-summer-citrus"].exists)
        capture("cosmos-05-text-channel")
    }

    func testOptionalTrialReturnsToWelcomeWithoutCompleting() {
        app.launch()
        XCTAssertTrue(app.buttons["onboardingNext"].waitForExistence(timeout: 10))
        app.buttons["onboardingNext"].tap()
        app.buttons["onboardingNext"].tap()
        let trial = app.buttons["onboardingTryPrompt"]
        XCTAssertTrue(trial.waitForExistence(timeout: 3))
        for _ in 0..<5 {
            if trial.isHittable { break }
            app.scrollViews["onboarding-page-2"].swipeUp()
        }
        XCTAssertTrue(trial.isHittable)
        XCTAssertFalse(app.staticTexts["onboardingTrialExcerpt"].label.isEmpty)
        capture("welcome-trial-preview")
        trial.tap()
        XCTAssertTrue(app.buttons["handoffOpen"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["finishPromptUse"].isHittable)
        capture("welcome-trial-tools")

        // Merely previewing a real prompt must neither launch a tool nor
        // complete onboarding. Closing returns to the same third page.
        app.buttons["finishPromptUse"].tap()
        XCTAssertTrue(app.buttons["onboardingNext"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["onboarding-title-2"].exists)
        XCTAssertTrue(app.buttons["handoffOpen"].waitForNonExistence(timeout: 3))
        capture("welcome-trial-return")

        app.terminate()
        app.launchArguments.removeAll { $0 == "--reset-onboarding" }
        app.launch()
        XCTAssertTrue(app.buttons["onboardingNext"].waitForExistence(timeout: 10), "Trying a prompt must not persist onboarding completion.")
        app.buttons["onboardingSkip"].tap()
        XCTAssertTrue(app.buttons["discoverySettings"].waitForExistence(timeout: 5))
    }

    func testTrialKeepsEditsWhenSwitchingOutgoingVersion() {
        app.launch()
        XCTAssertTrue(app.buttons["onboardingNext"].waitForExistence(timeout: 10))
        app.buttons["onboardingNext"].tap()
        app.buttons["onboardingNext"].tap()
        let trial = app.buttons["onboardingTryPrompt"]
        for _ in 0..<6 where !trial.isHittable { app.scrollViews["onboarding-page-2"].swipeUp() }
        trial.tap()
        XCTAssertTrue(app.buttons["handoffOpen"].waitForExistence(timeout: 5))

        func reveal(_ element: XCUIElement) {
            let scroll = app.scrollViews["handoffScroll"]
            for _ in 0..<8 {
                let bottom = app.buttons["handoffOpen"].frame.minY - 8
                if element.exists && element.isHittable && element.frame.maxY < bottom && element.frame.minY > 130 { return }
                if element.exists && element.frame.minY < 130 { scroll.swipeDown() }
                else { scroll.swipeUp() }
            }
            XCTAssertTrue(element.isHittable)
        }
        // Repeated runs may have an earlier test draft. Start from the reading version.
        let version = app.buttons["handoffVersion"]
        if version.exists { reveal(version); version.tap(); app.buttons["阅读版本"].tap() }
        let edit = app.buttons["editPreparedPrompt"]
        reveal(edit); edit.tap()
        let editor = app.textViews["promptEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        let original = editor.value as? String
        let marker = " Experience QA draft."
        editor.tap(); editor.typeText(marker)
        let changed = editor.value as? String
        XCTAssertTrue(changed?.contains(marker) == true)
        app.buttons["finishPromptEditing"].tap()
        XCTAssertTrue(version.waitForExistence(timeout: 5))
        reveal(version); version.tap(); app.buttons["阅读版本"].tap()
        capture("experience-reading-version")
        reveal(edit); edit.tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertEqual(editor.value as? String, original)
        app.buttons["finishPromptEditing"].tap()
        XCTAssertTrue(app.buttons["finishPromptUse"].waitForExistence(timeout: 5))
        app.buttons["finishPromptUse"].tap()
        XCTAssertTrue(trial.waitForExistence(timeout: 5)); trial.tap()
        XCTAssertTrue(app.buttons["handoffOpen"].waitForExistence(timeout: 5))
        reveal(edit); edit.tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertEqual(editor.value as? String, changed, "Choosing the reading version must not overwrite personal edits.")
        capture("experience-edits-preserved")
    }

    func testInterestControlsRemainReachableAtAccessibilitySize() {
        app.launch()
        for _ in 0..<3 { app.buttons["onboardingNext"].tap() }
        let scroll = app.scrollViews["onboarding-page-3"]
        let portrait = app.buttons["interest-portrait"]
        XCTAssertTrue(portrait.waitForExistence(timeout: 5))
        if portrait.isSelected { portrait.tap() }
        portrait.tap(); XCTAssertTrue(portrait.isSelected)
        capture("interests-accessibility-top")
        let comfort = app.switches["reduceSuggestiveRecommendations"]
        for _ in 0..<12 {
            if comfort.isHittable { break }
            scroll.swipeUp()
        }
        XCTAssertTrue(comfort.isHittable)
        XCTAssertTrue(app.buttons["onboardingComplete"].isHittable)
        capture("interests-accessibility-controls")
        app.buttons["onboardingComplete"].tap()
        XCTAssertTrue(app.buttons["discoverySettings"].waitForExistence(timeout: 10))
    }

    func testLocalizedWelcomeLayout() {
        for language in ["en", "de"] {
            app.launchArguments = ["--offline", "-AppleLanguages", "(\(language))", "-AppleLocale", language, "--reset-onboarding"]
            app.launch()
            XCTAssertTrue(app.buttons["onboardingNext"].waitForExistence(timeout: 10))
            for page in 0..<4 {
                let action = app.buttons[page == 3 ? "onboardingComplete" : "onboardingNext"]
                XCTAssertTrue(action.isHittable)
                XCTAssertTrue(app.buttons["onboardingSkip"].isHittable)
                let body = page == 3 ? app.buttons["interest-portrait"] : app.staticTexts["onboarding-body-\(page)"]
                for _ in 0..<5 {
                    if body.isHittable { break }
                    app.scrollViews["onboarding-page-\(page)"].swipeUp()
                }
                XCTAssertTrue(body.isHittable)
                capture("cosmos-\(language)-welcome-\(page)")
                action.tap()
            }
            XCTAssertTrue(app.buttons["onboardingComplete"].waitForNonExistence(timeout: 5))
            XCTAssertTrue(app.buttons["discoverySettings"].exists)
            app.terminate()
        }
    }
}
