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
        app.launchArguments = ["--offline", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh-Hans", "--reset-onboarding", "--feed-legacy-test", UUID().uuidString]
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func selectThree() {
        let scroll = app.scrollViews["onboarding-page-3"]
        for id in ["portrait", "illustration", "product"] {
            let button = app.buttons["interest-\(id)"]
            for _ in 0..<16 {
                let top = scroll.frame.minY + 12
                let bottom = scroll.frame.maxY - 12
                if button.exists && button.isHittable && button.frame.minY >= top && button.frame.maxY <= bottom { break }
                let down = button.exists && button.frame.minY < top
                let start = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: down ? 0.35 : 0.65))
                let end = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: down ? 0.65 : 0.35))
                start.press(forDuration: 0.05, thenDragTo: end)
            }
            XCTAssertTrue(button.isHittable)
            if !button.isSelected { button.tap() }
        }
    }

    func testWelcomeNavigationCompletionAndReplay() {
        app.launch()
        XCTAssertTrue(app.buttons["onboardingNext"].waitForExistence(timeout: 10))
        capture("journey-01-welcome")
        app.buttons["onboardingNext"].tap()
        XCTAssertTrue(app.staticTexts["onboarding-title-1"].waitForExistence(timeout: 3))
        capture("journey-02-collect")
        app.buttons["onboardingBack"].tap()
        XCTAssertTrue(app.staticTexts["onboarding-title-0"].exists)
        app.buttons["onboardingNext"].tap()
        app.buttons["onboardingNext"].tap()
        app.buttons["onboardingNext"].tap()
        XCTAssertTrue(app.buttons["interest-portrait"].waitForExistence(timeout: 3))
        selectThree()
        XCTAssertTrue(app.buttons["onboardingComplete"].waitForExistence(timeout: 3))
        capture("journey-04-interests")
        app.buttons["onboardingComplete"].tap()
        XCTAssertTrue(app.buttons["onboardingComplete"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["discoverySettings"].waitForExistence(timeout: 5))
        capture("journey-04-discover")

        // Remove the first-run reset to verify this run's persisted completion.
        app.terminate()
        app.launchArguments.removeAll { $0 == "--reset-onboarding" }
        app.launch()
        XCTAssertTrue(app.buttons["discoverySettings"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["onboardingNext"].exists)
        app.buttons["设置"].tap()
        app.buttons["replayOnboarding"].tap()
        XCTAssertTrue(app.buttons["onboardingNext"].waitForExistence(timeout: 3))
        for _ in 0..<3 { app.buttons["onboardingNext"].tap() }
        XCTAssertTrue(app.buttons["onboardingComplete"].isEnabled, "Replay preserves the three saved interests.")
        app.buttons["onboardingComplete"].tap()
        XCTAssertTrue(app.buttons["replayOnboarding"].waitForExistence(timeout: 3))
    }

    func testThreeInterestsAreMandatoryAndCannotBeSkipped() {
        app.launch()
        XCTAssertTrue(app.buttons["onboardingNext"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["onboardingSkip"].exists)
        XCTAssertFalse(app.buttons["discoverySettings"].exists, "Discovery is not mounted underneath the first-run journey.")
        for _ in 0..<3 { app.buttons["onboardingNext"].tap() }
        let complete = app.buttons["onboardingComplete"]
        XCTAssertTrue(complete.waitForExistence(timeout: 3))
        XCTAssertFalse(complete.isEnabled)
        let scroll = app.scrollViews["onboarding-page-3"]
        scroll.swipeDown()
        XCTAssertTrue(complete.exists, "Swiping down cannot dismiss mandatory onboarding.")
        app.buttons["interest-portrait"].tap()
        app.buttons["interest-illustration"].tap()
        XCTAssertFalse(complete.isEnabled, "Two interests are not enough.")
        app.buttons["interest-product"].tap()
        XCTAssertTrue(complete.isEnabled)
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'interest-' AND selected == true")).count, 3)
        XCTAssertFalse(app.buttons["interest-fashion"].isEnabled, "A fourth choice requires deselecting one first.")
        app.buttons["interest-portrait"].tap()
        XCTAssertFalse(complete.isEnabled)
        app.buttons["interest-portrait"].tap()
        complete.tap()
        XCTAssertTrue(app.buttons["discoverySettings"].waitForExistence(timeout: 5))
    }

    func testDirectHandoffReturnsWithoutCompletingOnboarding() {
        app.launch()
        XCTAssertTrue(app.buttons["onboardingNext"].waitForExistence(timeout: 10))
        for _ in 0..<2 { app.buttons["onboardingNext"].tap() }
        let trial = app.buttons["onboardingTryPrompt"]
        XCTAssertTrue(trial.waitForExistence(timeout: 3))
        for _ in 0..<5 where !trial.isHittable { app.scrollViews["onboarding-page-2"].swipeUp() }
        capture("journey-03-direct-handoff")
        trial.tap()
        // The real official URL opens outside Prompix; no generated result is faked.
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10))
        app.activate()
        XCTAssertTrue(trial.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["onboarding-title-2"].exists)
        app.terminate()
        app.launchArguments.removeAll { $0 == "--reset-onboarding" }
        app.launch()
        XCTAssertTrue(app.buttons["onboardingNext"].waitForExistence(timeout: 10), "Opening ChatGPT must not complete onboarding.")
    }

    // This regression now starts in detail: the welcome journey no longer has an editing sheet.
    func testDetailTrialKeepsEditsWhenSwitchingOutgoingVersion() {
        app.launchArguments.removeAll { $0 == "--reset-onboarding" }
        app.launchPrompix()
        XCTAssertTrue(app.buttons["kind-text"].waitForExistence(timeout: 10))
        app.buttons["kind-text"].tap()
        app.buttons["prompt-gentle-tarot"].tap()
        let trial = app.buttons["usePrompt"]
        XCTAssertTrue(trial.waitForExistence(timeout: 5)); trial.tap()
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
        selectThree()
        XCTAssertTrue(portrait.isSelected)
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

    func testCorruptPreferencesCannotCompleteUntilExplicitRecovery() throws {
        #if targetEnvironment(simulator)
        app.launch()
        XCTAssertTrue(app.buttons["onboardingNext"].waitForExistence(timeout: 10))
        app.terminate()
        // Touch only this test's UUID fixture in the metadata-verified simulator app.
        let parent = URL(fileURLWithPath: NSHomeDirectory()).deletingLastPathComponent()
        let matches = try FileManager.default.contentsOfDirectory(at: parent, includingPropertiesForKeys: nil).filter { candidate in
            guard let data = try? Data(contentsOf: candidate.appendingPathComponent(".com.apple.mobile_container_manager.metadata.plist")),
                  let metadata = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else { return false }
            return metadata["MCMMetadataIdentifier"] as? String == "com.p697.prompix"
        }
        XCTAssertEqual(matches.count, 1)
        let id = try XCTUnwrap(app.launchArguments.last.flatMap(UUID.init(uuidString:)))
        let directory = try XCTUnwrap(matches.first).appendingPathComponent("Library/Caches/FeedAcceptance/\(id.uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("recommendation-preferences.json")
        let damaged = Data("invalid fixture".utf8)
        try damaged.write(to: file)
        app.launch()
        for _ in 0..<3 { app.buttons["onboardingNext"].tap() }
        let complete = app.buttons["onboardingComplete"]
        XCTAssertFalse(complete.isEnabled)
        let recovery = app.buttons["onboardingRecoverPreferences"]
        for _ in 0..<10 {
            if recovery.exists && recovery.isHittable && recovery.frame.maxY < complete.frame.minY - 50 { break }
            app.scrollViews["onboarding-page-3"].swipeUp()
        }
        XCTAssertTrue(recovery.isHittable)
        XCTAssertEqual(try Data(contentsOf: file), damaged, "Do not silently replace corrupt preferences.")
        capture("journey-recovery-before-confirm")
        recovery.tap()
        XCTAssertTrue(app.buttons["取消"].waitForExistence(timeout: 5))
        app.buttons["取消"].tap()
        XCTAssertEqual(try Data(contentsOf: file), damaged)
        recovery.tap()
        app.buttons["重置"].tap()
        XCTAssertTrue(recovery.waitForNonExistence(timeout: 5))
        for _ in 0..<8 where !app.buttons["interest-portrait"].isHittable { app.scrollViews["onboarding-page-3"].swipeDown() }
        selectThree()
        XCTAssertTrue(complete.isEnabled)
        complete.tap()
        XCTAssertTrue(app.buttons["discoverySettings"].waitForExistence(timeout: 5))
        #else
        throw XCTSkip("Corrupt-file fixture is limited to the simulator.")
        #endif
    }

    func testLocalizedWelcomeLayout() {
        for language in ["en", "de"] {
            app.launchArguments = ["--offline", "-AppleLanguages", "(\(language))", "-AppleLocale", language, "--reset-onboarding", "--feed-legacy-test", UUID().uuidString]
            app.launch()
            XCTAssertTrue(app.buttons["onboardingNext"].waitForExistence(timeout: 10))
            for page in 0..<4 {
                let action = app.buttons[page == 3 ? "onboardingComplete" : "onboardingNext"]
                XCTAssertTrue(action.isHittable)
                XCTAssertFalse(app.buttons["onboardingSkip"].exists)
                let body = page == 3 ? app.buttons["interest-portrait"] : app.staticTexts["onboarding-body-\(page)"]
                for _ in 0..<5 {
                    if body.isHittable { break }
                    app.scrollViews["onboarding-page-\(page)"].swipeUp()
                }
                XCTAssertTrue(body.isHittable)
                capture("journey-\(language)-welcome-\(page)")
                if page == 3 { selectThree() }
                action.tap()
            }
            XCTAssertTrue(app.buttons["onboardingComplete"].waitForNonExistence(timeout: 5))
            XCTAssertTrue(app.buttons["discoverySettings"].exists)
            app.terminate()
        }
    }
}
