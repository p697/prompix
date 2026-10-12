import XCTest

/// These opt-in journeys use a staged, validated catalog in the simulator's
/// Application Support directory. They never install or launch on a phone.
@MainActor final class GlobalDiscoveryUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        #if targetEnvironment(simulator)
        app = XCUIApplication()
        #else
        throw XCTSkip("Global discovery acceptance is simulator-only.")
        #endif
    }

    private func launch(_ language: String = "zh-Hans") {
        app.launchArguments = ["--cached-only", "-AppleLanguages", "(\(language))", "-AppleLocale", language]
        app.launch()
        XCTAssertTrue(app.buttons["searchButton"].waitForExistence(timeout: 10))
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func reveal(_ element: XCUIElement, attempts: Int = 8) {
        for _ in 0..<attempts {
            if element.exists && element.isHittable { return }
            if element.exists && element.frame.maxY < 110 { app.swipeDown() }
            else { app.swipeUp() }
        }
        XCTAssertTrue(element.isHittable)
    }

    private func selectSkill() {
        let skill = app.buttons["kind-skill"]
        let picker = app.scrollViews["kindPicker"]
        for _ in 0..<5 {
            let visible = skill.frame.intersection(picker.frame)
            // iOS 27 can throw instead of returning false when an offscreen
            // accessibility button has no activation point.
            if !visible.isNull && visible.width >= min(44, skill.frame.width) && skill.isHittable { break }
            picker.swipeLeft()
        }
        XCTAssertTrue(skill.isHittable)
        skill.tap()
        XCTAssertTrue(skill.isSelected)
    }

    func testCreatorAndSkillJourney() {
        launch()
        XCTAssertTrue(app.buttons["allCreators"].waitForExistence(timeout: 10), "Stage the creator/Skill candidate catalog before running this journey.")
        capture("01-home-creators-and-collections")
        let creator = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'creator-' ")).firstMatch
        XCTAssertTrue(creator.isHittable)
        creator.tap()
        XCTAssertTrue(app.buttons["saveCreator"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.links["creatorExternalProfile"].exists || app.buttons["creatorExternalProfile"].exists)
        capture("02-creator-profile")
        if app.buttons["saveCreator"].label == "取消收藏创作者" { app.buttons["saveCreator"].tap() }
        app.buttons["saveCreator"].tap()
        XCTAssertEqual(app.buttons["saveCreator"].label, "取消收藏创作者")
        let item = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-' ")).firstMatch
        reveal(item)
        item.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        reveal(app.buttons["creatorByline"])
        capture("03-work-with-creator-attribution")
        app.buttons["creatorByline"].tap()
        XCTAssertTrue(app.buttons["saveCreator"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["saveCreator"].label, "取消收藏创作者")

        app.terminate()
        launch()
        app.selectPrompixTab("收藏")
        app.segmentedControls["savedContentType"].buttons["创作者"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'saved-creator-' ")).firstMatch.waitForExistence(timeout: 5))
        capture("04-saved-creator-after-relaunch")
        app.selectPrompixTab("发现")
        selectSkill()
        XCTAssertFalse(app.buttons["allCreators"].exists, "Filtering should put results before discovery rails.")
        capture("05-skills-channel")
        let skill = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-skill-' ")).firstMatch
        reveal(skill)
        skill.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        let source = app.descendants(matching: .any).matching(identifier: "skillSource").firstMatch
        reveal(source)
        capture("06-skill-source-and-files")
        app.buttons["copyPrompt"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].label.contains("已复制"))
        app.buttons["detailFavorite"].tap()
    }

    func testNineInterfaceLanguages() {
        for language in ["en", "zh-Hans", "zh-Hant", "ja", "ko", "es", "pt-BR", "fr", "de"] {
            launch(language)
            XCTAssertTrue(app.buttons["allCreators"].waitForExistence(timeout: 5))
            capture("language-\(language)-home")
            app.buttons["allCreators"].tap()
            XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 5))
            capture("language-\(language)-creators")
            let creator = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'creator-' ")).firstMatch
            creator.tap()
            XCTAssertTrue(app.buttons["saveCreator"].waitForExistence(timeout: 5))
            let item = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-' ")).firstMatch
            reveal(item)
            item.tap()
            XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
            XCTAssertTrue(app.buttons["contentLanguage"].exists)
            capture("language-\(language)-detail")
            let beforeCopy = app.buttons["copyPrompt"].label
            app.buttons["copyPrompt"].tap()
            XCTAssertNotEqual(app.buttons["copyPrompt"].label, beforeCopy)
            app.terminate()
        }
    }

    func testTranslatedCatalogBrowsingPerformance() {
        launch("en")
        XCTAssertTrue(app.buttons["allCreators"].waitForExistence(timeout: 5))
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        measure(metrics: [XCTMemoryMetric(application: app), XCTCPUMetric(application: app), XCTClockMetric()], options: options) {
            for _ in 0..<5 { app.swipeUp() }
            for _ in 0..<5 { app.swipeDown() }
        }
        XCTAssertTrue(app.buttons["searchButton"].exists)
        capture("translated-catalog-after-repeated-scroll")
    }

    func testRepeatedCreatorAndTypeNavigation() {
        launch("en")
        for iteration in 0..<20 {
            let creator = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'creator-' ")).firstMatch
            reveal(creator)
            creator.tap()
            XCTAssertTrue(app.buttons["saveCreator"].waitForExistence(timeout: 5))
            app.navigationBars.buttons.element(boundBy: 0).tap()
            let kind = iteration.isMultiple(of: 2) ? "kind-text" : "kind-image"
            app.buttons[kind].tap()
            XCTAssertFalse(app.buttons["allCreators"].exists)
            XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-' ")).firstMatch.exists)
            app.buttons["kind-all"].tap()
            XCTAssertTrue(app.buttons["allCreators"].exists)
        }
        capture("after-twenty-creator-and-type-round-trips")
    }

    func testTranslatedPromptCopyAndDraftIsolation() {
        launch()
        app.buttons["kind-text"].tap()
        let prompt = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'prompt-' ")).firstMatch
        reveal(prompt)
        prompt.tap()
        let menu = app.buttons["contentLanguage"]
        reveal(menu)
        XCTAssertTrue(menu.exists, "This journey requires completed translations in the staged catalog.")
        menu.tap()
        app.buttons["English"].tap()
        capture("07-english-content-selection")
        app.buttons["copyPrompt"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].label.contains("已复制"))
        let edit = app.buttons["editPrompt"]
        reveal(edit)
        edit.tap()
        let editor = app.textViews["promptEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        let english = editor.value as? String ?? ""
        XCTAssertFalse(english.isEmpty)
        let marker = " PROMPIX-LANGUAGE-DRAFT-TEST "
        editor.tap()
        editor.typeText(marker)
        XCTAssertTrue((editor.value as? String ?? "").contains(marker))
        capture("08-language-specific-editor")
        app.navigationBars.buttons["完成"].tap()
        reveal(menu)
        menu.tap()
        app.buttons["原文"].tap()
        reveal(edit)
        edit.tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        let original = editor.value as? String ?? ""
        XCTAssertFalse(original.contains(marker), "Editing a translation must preserve the original draft.")
        XCTAssertNotEqual(original, english, "Use a Chinese source with a real English translation for this test.")
        capture("09-original-editor-preserved")
        app.navigationBars.buttons["完成"].tap()
        reveal(menu)
        menu.tap()
        app.buttons["English"].tap()
        reveal(edit)
        edit.tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertTrue((editor.value as? String ?? "").contains(marker), "The English draft must survive closing and reopening the editor.")
        app.buttons["编辑选项"].tap()
        app.buttons["恢复当前语言的内容"].tap()
        app.buttons["恢复译文"].tap()
        XCTAssertEqual(editor.value as? String, english)
        app.navigationBars.buttons["完成"].tap()
    }
}

extension XCUIApplication {
    @MainActor func selectPrompixTab(_ title: String) {
        // iPadOS exposes floating native tabs as ordinary buttons.
        let tab = tabBars.buttons[title]
        let target = tab.exists ? tab : buttons.matching(NSPredicate(format: "label == %@", title)).firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 5))
        target.tap()
    }
}
