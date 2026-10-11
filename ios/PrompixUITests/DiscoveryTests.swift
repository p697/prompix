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
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    func testAdaptiveBrowsingAndEditing() throws {
        defer { XCUIDevice.shared.orientation = .portrait }
        XCTAssertTrue(app.buttons["kind-text"].waitForExistence(timeout: 10))
        capture("20-adaptive-discovery")
        try app.performAccessibilityAudit(for: [.hitRegion, .sufficientElementDescription])
        app.buttons["kind-text"].tap()
        let card = app.buttons["prompt-gentle-tarot"]
        for _ in 0..<5 { if card.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(card.isHittable); card.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        capture("21-adaptive-detail")
        app.buttons["copyPrompt"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].label.contains("已复制"))
        app.buttons["编辑后使用"].tap()
        XCTAssertTrue(app.textViews["promptEditor"].waitForExistence(timeout: 5))
        capture("22-adaptive-editor")
        XCTAssertTrue(app.buttons["copyEditedPrompt"].isHittable)
        app.buttons["copyEditedPrompt"].tap()
        XCTAssertTrue(app.buttons["copyEditedPrompt"].label.contains("已复制"))
        app.buttons["完成"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.tabBars.buttons["专题"].tap()
        capture("23-adaptive-collections")
        app.buttons["collection-play"].tap()
        let collectionCard = app.buttons["prompt-gentle-tarot"]
        for _ in 0..<5 { if collectionCard.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(collectionCard.isHittable)
        capture("25-collection-detail")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCUIDevice.shared.orientation = .landscapeLeft
        let landscape = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in self.app.frame.width > self.app.frame.height }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [landscape], timeout: 5), .completed)
        capture("24-landscape-collections")
        XCUIDevice.shared.orientation = .portrait
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
        XCTAssertTrue(app.descendants(matching: .any)["playingVideo"].waitForExistence(timeout: 15))
        capture("07-video-playing")
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
    func testOriginalWebsitesAndCaptureTheirRealPreviews() {
        app.buttons["kind-web"].tap()
        capture("14-web-discovery")
        let examples = [
            ("quiet-portfolio", "Less, but"), ("indie-studio", "Ideas take"),
            ("sunday-recipes", "A slower"), ("travel-notes", "Go a little"),
            ("soft-focus", "Make room"), ("little-gallery", "Objects")
        ]
        for (id, headline) in examples {
            let card = app.buttons["prompt-\(id)"]
            for _ in 0..<6 { if card.isHittable { break }; app.swipeUp() }
            XCTAssertTrue(card.isHittable, id); card.tap()
            app.buttons["previewButton"].tap()
            let web = app.webViews.firstMatch
            XCTAssertTrue(web.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", headline)).firstMatch.waitForExistence(timeout: 10), id)
            let shot = XCTAttachment(screenshot: web.screenshot())
            shot.name = "web-\(id)"; shot.lifetime = .keepAlways; add(shot)
            if id == "soft-focus" {
                let start = web.buttons["开始专注"]
                if !start.isHittable { web.swipeUp() }
                start.tap()
                XCTAssertTrue(web.buttons["暂停"].waitForExistence(timeout: 3))
                web.buttons["暂停"].tap()
                XCTAssertTrue(web.buttons["继续"].waitForExistence(timeout: 3))
                web.buttons["重新开始"].tap()
                XCTAssertTrue(web.buttons["开始专注"].exists)
            }
            if id == "sunday-recipes" {
                let recipe = web.buttons["打开番茄鸡蛋吐司"]
                for _ in 0..<4 { if recipe.isHittable { break }; web.swipeUp() }
                recipe.tap()
                XCTAssertTrue(web.staticTexts["准备食材"].waitForExistence(timeout: 3))
                web.buttons["关闭食谱"].tap()
            }
            if id == "little-gallery" {
                let object = web.descendants(matching: .any).matching(identifier: "收藏一只不对称的花瓶").firstMatch
                for _ in 0..<4 { if object.isHittable { break }; web.swipeUp() }
                object.tap()
                XCTAssertTrue(web.descendants(matching: .any).matching(identifier: "取消收藏一只不对称的花瓶").firstMatch.waitForExistence(timeout: 3))
            }
            app.buttons["完成"].tap()
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
    }
    func testEditorialTextDiscoveryAndDetail() {
        app.buttons["kind-text"].tap()
        let card = app.buttons["prompt-daily-side-quest"]
        for _ in 0..<8 { if card.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(card.isHittable)
        capture("15-editorial-text-discovery")
        card.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        capture("16-editorial-text-detail")
        app.buttons["编辑后使用"].tap()
        XCTAssertTrue((app.textViews["promptEditor"].value as? String ?? "").contains("支线"))
        app.buttons["完成"].tap()
    }
    func testEnglishInterfacePreservesPromptContent() {
        app.terminate()
        app.launchArguments = ["--offline", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Discover"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.tabBars.buttons["Collections"].exists)
        XCTAssertTrue(app.tabBars.buttons["Saved"].exists)
        capture("17-english-discovery")
        app.buttons["kind-text"].tap()
        app.buttons["prompt-gentle-tarot"].tap()
        XCTAssertEqual(app.buttons["copyPrompt"].label, "Copy prompt")
        app.buttons["Make it yours"].tap()
        XCTAssertTrue(app.textViews["promptEditor"].waitForExistence(timeout: 5))
        capture("18-english-editor")
        app.buttons["Done"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["About and settings"].waitForExistence(timeout: 5))
        capture("19-english-settings")
    }
    func testLiveImageGallery() throws {
        app.terminate()
        app.launchArguments.removeAll { $0 == "--offline" }
        app.launch()
        XCTAssertTrue(app.staticTexts["DAILY FINDS"].waitForExistence(timeout: 35))
        app.buttons["searchButton"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 3))
        search.tap(); search.typeText("发明")
        let card = app.buttons.containing(NSPredicate(format: "identifier BEGINSWITH %@", "prompt-youmind-nano-")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 5)); card.tap()
        app.buttons["previewButton"].tap()
        XCTAssertTrue(app.navigationBars["1 / 4"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["previousImage"].isEnabled)
        for index in 1...4 {
            XCTAssertTrue(app.navigationBars["\(index) / 4"].waitForExistence(timeout: 5))
            XCTAssertTrue(app.descendants(matching: .any)["loadedImage"].waitForExistence(timeout: 20))
            capture("gallery-\(index)")
            if index < 4 { app.buttons["nextImage"].tap() }
        }
        XCTAssertFalse(app.buttons["nextImage"].isEnabled)
        app.buttons["previousImage"].tap()
        XCTAssertTrue(app.navigationBars["3 / 4"].waitForExistence(timeout: 5))
        app.buttons["完成"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].exists)
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
        XCTAssertTrue(app.descendants(matching: .any)["playingVideo"].waitForExistence(timeout: 35))
        XCTAssertFalse(app.buttons["retryVideo"].exists)
        capture("12-live-video-playing")
    }

}
