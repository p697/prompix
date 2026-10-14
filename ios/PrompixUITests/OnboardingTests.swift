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
        XCTAssertTrue(app.buttons["onboardingComplete"].waitForExistence(timeout: 3))
        capture("cosmos-03-use")
        app.buttons["onboardingComplete"].tap()
        XCTAssertTrue(app.buttons["onboardingComplete"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["searchButton"].waitForExistence(timeout: 5))
        capture("cosmos-04-discover")

        // Remove the first-run reset to verify this run's persisted completion.
        app.terminate()
        app.launchArguments.removeLast()
        app.launch()
        XCTAssertTrue(app.buttons["searchButton"].waitForExistence(timeout: 5))
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
        XCTAssertTrue(app.buttons["searchButton"].waitForExistence(timeout: 5))
        app.buttons["kind-text"].tap()
        XCTAssertTrue(app.buttons["prompt-gentle-tarot"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["prompt-summer-citrus"].exists)
        capture("cosmos-05-text-channel")
    }

    func testLocalizedWelcomeLayout() {
        for language in ["en", "de"] {
            app.launchArguments = ["--offline", "-AppleLanguages", "(\(language))", "-AppleLocale", language, "--reset-onboarding"]
            app.launch()
            XCTAssertTrue(app.buttons["onboardingNext"].waitForExistence(timeout: 10))
            for page in 0..<3 {
                let action = app.buttons[page == 2 ? "onboardingComplete" : "onboardingNext"]
                XCTAssertTrue(action.isHittable)
                XCTAssertTrue(app.buttons["onboardingSkip"].isHittable)
                capture("cosmos-\(language)-welcome-\(page)")
                action.tap()
            }
            XCTAssertTrue(app.buttons["onboardingComplete"].waitForNonExistence(timeout: 5))
            XCTAssertTrue(app.buttons["searchButton"].exists)
            app.terminate()
        }
    }
}
