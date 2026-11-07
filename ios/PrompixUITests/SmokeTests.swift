import XCTest

/// Core journeys on the bundled catalog, offline and deterministic. CI runs them
/// after every merge to main; see docs/decisions/2026-11-07-ui-smoke-only.md.
@MainActor final class SmokeTests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
        app.usePrompixFixture()
    }

    func testThreeInterestsAreMandatoryAndCannotBeSkipped() {
        app.usePrompixFixture(onboarded: false)
        app.launch()
        XCTAssertTrue(app.buttons["onboardingNext"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["onboardingSkip"].exists)
        XCTAssertFalse(app.buttons["discoveryFilters"].exists, "Discovery is not mounted underneath the first-run journey.")
        app.buttons["onboardingNext"].tap()
        let complete = app.buttons["onboardingComplete"]
        XCTAssertTrue(complete.waitForExistence(timeout: 3))
        XCTAssertFalse(complete.isEnabled)
        app.scrollViews["onboarding-page-1"].swipeDown()
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
        XCTAssertTrue(app.buttons["discoveryFilters"].waitForExistence(timeout: 5))
    }

    func testPeekShowsTheWorkWithItsActions() {
        app.launchPrompix()
        let card = app.scrollViews["discoveryScroll"].buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-'")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        card.press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["复制 Prompt"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["收藏 Prompt"].exists)
        capture("peek-01-preview")
        app.buttons["复制 Prompt"].tap()
        XCTAssertTrue(card.waitForExistence(timeout: 3))
    }

    func testCopySaveEditAndSearchSurviveRelaunch() {
        app.launchPrompix()
        XCTAssertTrue(app.buttons["discoveryKind"].waitForExistence(timeout: 10))
        app.chooseKind("kind-text")
        app.buttons["prompt-gentle-tarot"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        capture("01-text-detail")
        app.buttons["copyPrompt"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].label.contains("已复制"))
        let save = app.buttons["detailFavorite"]
        save.tap()
        XCTAssertEqual(save.label, "取消收藏")
        app.buttons["editPromptAction"].tap()
        XCTAssertTrue(app.textViews["promptEditor"].waitForExistence(timeout: 3))
        app.buttons["finishPromptEditing"].tap()
        app.goBackInPrompix()
        // Saved opens on its decks; every saved work is in the first one.
        app.selectPrompixTab("收藏")
        XCTAssertTrue(app.buttons["deck-all"].waitForExistence(timeout: 5)); app.buttons["deck-all"].tap()
        XCTAssertTrue(app.buttons["prompt-gentle-tarot"].waitForExistence(timeout: 5))
        capture("02-saved")
        app.terminate(); app.launchPrompix()
        app.selectPrompixTab("收藏")
        XCTAssertTrue(app.buttons["deck-all"].waitForExistence(timeout: 5)); app.buttons["deck-all"].tap()
        XCTAssertTrue(app.buttons["prompt-gentle-tarot"].waitForExistence(timeout: 5))
        app.selectPrompixTab("搜索")
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 3))
        search.tap(); search.typeText("塔罗")
        XCTAssertTrue(app.buttons["prompt-gentle-tarot"].waitForExistence(timeout: 5))
        capture("03-search")
    }

    func testSearchOpensDetailAndReturnsWithoutRefocusing() {
        app.launchPrompix()
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

    func testEditedVersionSurvivesRelaunch() {
        app.launchPrompix()
        app.chooseKind("kind-text")
        app.buttons["prompt-gentle-tarot"].tap()
        app.buttons["editPromptAction"].tap()
        let editor = app.textViews["promptEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap()
        editor.typeText(" My personal intention.")
        // The first change saves a version and retitles the editor, which redraws its toolbar.
        let finish = app.buttons["finishPromptEditing"]
        XCTAssertTrue(finish.waitForExistence(timeout: 5)); finish.tap()
        app.terminate(); app.launchPrompix()
        app.chooseKind("kind-text")
        app.buttons["prompt-gentle-tarot"].tap()
        // The detail opens on the original; the saved version is a chip beside it.
        let versions = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'version-' AND identifier != 'version-original'"))
        let version = versions.firstMatch
        XCTAssertTrue(version.waitForExistence(timeout: 5)); version.tap()
        XCTAssertTrue(version.isSelected)
        XCTAssertEqual(versions.count, 1)
        app.buttons["editPromptAction"].tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertTrue((editor.value as? String ?? "").contains("My personal intention."))
        capture("04-version-after-relaunch")
    }
}
