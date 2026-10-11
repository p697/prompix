import XCTest

@MainActor final class DiscoveryTests: XCTestCase {
    private var app: XCUIApplication!
    override func setUp() async throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["--offline", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
    }
    func capture(_ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    func testFourKindsCopyEditSaveAndSearch() {
        XCTAssertTrue(app.buttons["kind-text"].waitForExistence(timeout: 10))
        capture("01-discover")
        app.buttons["kind-text"].tap()
        app.buttons["prompt-gentle-tarot"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        capture("02-text-detail")
        app.buttons["copyPrompt"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].label.contains("已复制"))
        let save = app.buttons["detailFavorite"]
        if save.label == "取消收藏" { save.tap() }
        save.tap()
        XCTAssertEqual(save.label, "取消收藏")
        app.buttons["编辑后使用"].tap()
        XCTAssertTrue(app.textViews["promptEditor"].waitForExistence(timeout: 3))
        capture("03-editor")
        app.buttons["完成"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.tabBars.buttons["收藏"].tap()
        XCTAssertTrue(app.buttons["prompt-gentle-tarot"].waitForExistence(timeout: 5))
        capture("04-favorites")
        app.terminate(); app.launch()
        app.tabBars.buttons["收藏"].tap()
        XCTAssertTrue(app.buttons["prompt-gentle-tarot"].waitForExistence(timeout: 5))
        app.tabBars.buttons["发现"].tap()
        app.buttons["searchButton"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 3))
        search.tap(); search.typeText("塔罗")
        XCTAssertTrue(app.buttons["prompt-gentle-tarot"].exists)
        capture("05-search")
    }
    func testImageVideoWebAndCollections() {
        app.buttons["kind-image"].tap()
        app.buttons["prompt-summer-citrus"].tap()
        app.buttons["previewButton"].tap()
        XCTAssertTrue(app.buttons["完成"].waitForExistence(timeout: 5))
        capture("06-image-viewer")
        app.buttons["完成"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["kind-video"].tap()
        app.buttons["prompt-slow-road"].tap()
        app.buttons["previewButton"].tap()
        XCTAssertTrue(app.navigationBars["动态灵感"].waitForExistence(timeout: 5))
        capture("07-video")
        app.buttons["完成"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["kind-web"].tap()
        app.buttons["prompt-quiet-portfolio"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        capture("08-web-detail")
        app.swipeUp()
        app.swipeUp()
        let webExample = app.buttons["webExample"]
        if !webExample.isHittable { app.swipeUp() }
        webExample.tap()
        XCTAssertTrue(app.webViews.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Less, but")).firstMatch.waitForExistence(timeout: 10))
        capture("08b-web-example")
        app.buttons["完成"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.tabBars.buttons["专题"].tap()
        capture("09-collections")
    }
    func testEditedDraftPersistsAcrossRelaunch() {
        app.buttons["kind-text"].tap()
        app.buttons["prompt-gentle-tarot"].tap()
        app.buttons["编辑后使用"].tap()
        let editor = app.textViews["promptEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap()
        editor.typeText(" My personal intention.")
        app.buttons["完成"].tap()
        app.terminate(); app.launch()
        app.buttons["kind-text"].tap()
        app.buttons["prompt-gentle-tarot"].tap()
        app.buttons["编辑后使用"].tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertTrue((editor.value as? String ?? "").contains("My personal intention."))
        capture("13-persistent-draft")
    }
    func testLiveCommunityEditionAndRemotePreviews() throws {
        app.terminate()
        app.launchArguments.removeAll { $0 == "--offline" }
        app.launch()
        XCTAssertTrue(app.staticTexts["DAILY FINDS"].waitForExistence(timeout: 35))
        let imageCard = app.buttons.containing(NSPredicate(format: "identifier BEGINSWITH %@", "prompt-youmind-nano-")).firstMatch
        XCTAssertTrue(imageCard.waitForExistence(timeout: 10))
        capture("10-live-discovery")
        imageCard.tap()
        app.buttons["previewButton"].tap()
        XCTAssertTrue(app.scrollViews.matching(NSPredicate(format: "label CONTAINS %@", "图片预览")).firstMatch.waitForExistence(timeout: 20))
        capture("11-live-image")
        app.buttons["完成"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["kind-video"].tap()
        let videoCard = app.buttons.containing(NSPredicate(format: "identifier BEGINSWITH %@", "prompt-youmind-seedance-")).firstMatch
        XCTAssertTrue(videoCard.waitForExistence(timeout: 10)); videoCard.tap()
        app.buttons["previewButton"].tap()
        XCTAssertTrue(app.navigationBars["动态灵感"].waitForExistence(timeout: 10))
        capture("12-live-video")
    }

}
