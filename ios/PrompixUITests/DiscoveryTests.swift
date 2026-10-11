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
    // Select explicitly on a physical device with a Release configuration.
    // These are process launches, not a claim of empty OS caches or a reboot.
    func testRepeatedLaunchPerformance() {
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        measure(metrics: [XCTApplicationLaunchMetric(waitUntilResponsive: true)], options: options) {
            app.terminate()
            app.launch()
            XCTAssertTrue(app.buttons["kind-text"].waitForExistence(timeout: 10))
        }
    }

    func testScrollingResourcePerformance() {
        XCTAssertTrue(app.buttons["kind-text"].waitForExistence(timeout: 10))
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        measure(metrics: [XCTMemoryMetric(application: app), XCTCPUMetric(application: app)], options: options) {
            for _ in 0..<6 { app.swipeUp() }
            for _ in 0..<6 { app.swipeDown() }
        }
        XCTAssertTrue(app.buttons["kind-text"].exists)
        capture("air-scroll-after-measurement")
    }

    func testVoiceOverDiscoveryTraversal() throws {
        #if compiler(>=6.4)
        guard #available(iOS 27.0, *) else {
            throw XCTSkip("Actual VoiceOver traversal requires the iOS 27 XCUIVoiceOverService API.")
        }
        continueAfterFailure = true
        let voiceOver = XCUIDevice.shared.voiceOverService
        var speech: [String] = []
        defer {
            do { try voiceOver.disable() }
            catch { XCTFail("Could not disable VoiceOver after traversal: \(error)") }
            let transcript = XCTAttachment(string: speech.enumerated().map { "\($0.offset): \($0.element)" }.joined(separator: "\n"))
            transcript.name = "VoiceOver discovery spoken traversal"
            transcript.lifetime = .keepAlways
            add(transcript)
        }
        if voiceOver.isEnabled { try voiceOver.disable() }
        let card = app.buttons["prompt-gentle-tarot"]
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        XCTAssertTrue(card.isHittable)
        try waitForRenderingToSettle()

        func normalized(_ value: String) -> String {
            value.lowercased().filter { $0.isLetter || $0.isNumber }
        }
        let title = normalized("抽一张塔罗，给今天一点新视角")
        func isCard(_ value: String) -> Bool {
            let value = normalized(value)
            return value.contains(title) && !value.contains("收藏")
        }
        func isBookmark(_ value: String) -> Bool {
            let value = normalized(value)
            return value.contains(title) && value.contains("收藏")
        }
        func reachedNavigation() -> Bool {
            speech.contains { normalized($0).contains("prompix") }
                && speech.contains { $0.contains("搜索") }
                && speech.contains { $0.contains("设置") }
        }

        // This reads VoiceOver's actual output, not the broader XCTest element tree.
        try voiceOver.enable()
        XCTAssertTrue(voiceOver.isEnabled)
        speech.append(try voiceOver.currentSpeech().utterance)
        let forwardDeadline = Date().addingTimeInterval(45)
        for _ in 0..<36 {
            if speech.contains(where: isCard) && speech.contains(where: isBookmark) { break }
            if Date() >= forwardDeadline { break }
            speech.append(try voiceOver.moveForward().utterance)
        }
        let forwardSpeech = speech
        XCTAssertTrue(forwardSpeech.contains(where: isCard), "VoiceOver must reach the card title as its own navigation action.")
        XCTAssertTrue(forwardSpeech.contains(where: isBookmark), "VoiceOver must reach the card's separately labeled bookmark.")
        if let titleIndex = forwardSpeech.firstIndex(where: isCard), let bookmarkIndex = forwardSpeech.firstIndex(where: isBookmark) {
            XCTAssertLessThan(titleIndex, bookmarkIndex, "Read the card title before its bookmark action.")
        }

        // Enabling VoiceOver can restore a previous focus. Walk back from the card
        // to verify the native header and toolbar actions without assuming a start index.
        let backwardDeadline = Date().addingTimeInterval(45)
        for _ in 0..<36 {
            if reachedNavigation() { break }
            if Date() >= backwardDeadline { break }
            speech.append(try voiceOver.moveBackward().utterance)
        }
        XCTAssertTrue(reachedNavigation(), "VoiceOver must expose the Prompix heading, Search, and Settings actions.")
        XCTAssertFalse(speech.contains { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }, "Focused elements must produce meaningful speech.")
        for decoration in ["A LITTLE PERSPECTIVE", "今天，慢慢来。"] {
            XCTAssertFalse(speech.contains { normalized($0).contains(normalized(decoration)) }, "Decorative cover text must not become a separate VoiceOver stop: \(decoration)")
        }
        #else
        throw XCTSkip("Actual VoiceOver traversal requires Xcode 27 or later.")
        #endif
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

    func testAccessibilityAcrossMainScreens() throws {
        continueAfterFailure = true
        XCTAssertTrue(app.buttons["kind-text"].waitForExistence(timeout: 10))
        try auditScreen("discovery")
        // XCTest can expose automation-only descendants of hidden artwork.
        // Gate the native navigation label here; inspect reading order separately.
        XCTAssertEqual(app.buttons.matching(identifier: "prompt-gentle-tarot").count, 1)
        XCTAssertEqual(app.buttons["prompt-gentle-tarot"].label, "抽一张塔罗，给今天一点新视角")
        app.buttons["kind-text"].tap()
        app.buttons["prompt-gentle-tarot"].tap()
        try auditScreen("text-detail")
        let report = app.descendants(matching: .any).matching(identifier: "reportContent").firstMatch
        let contentBottom = app.buttons["copyPrompt"].frame.minY - 16
        func sourceIsVisible() -> Bool {
            report.exists && report.isHittable && report.frame.minY > 100 && report.frame.maxY < contentBottom
        }
        for _ in 0..<30 {
            if sourceIsVisible() { break }
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4)))
        }
        XCTAssertTrue(sourceIsVisible(), "Source actions must be visible above the fixed action bar before auditing")
        try auditScreen("text-detail-source")
        if app.buttons["detailFavorite"].label != "取消收藏" { app.buttons["detailFavorite"].tap() }
        app.buttons["编辑后使用"].tap()
        XCTAssertTrue(app.textViews["promptEditor"].waitForExistence(timeout: 5))
        try auditScreen("editor")
        app.buttons["完成"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.tabBars.buttons["专题"].tap()
        try auditScreen("collections")
        app.tabBars.buttons["收藏"].tap()
        try auditScreen("favorites")
        app.tabBars.buttons["发现"].tap()
        app.buttons["设置"].tap()
        try auditScreen("settings")
        app.swipeUp()
        try auditScreen("settings-support")
        app.buttons["完成"].tap()
        app.buttons["searchButton"].tap()
        try auditScreen("search")
    }

    private func auditScreen(_ name: String) throws {
        // Existence can become true before a native push/sheet animation ends.
        // Audit the rendered destination, not a moving overlap of two screens.
        try waitForRenderingToSettle()
        capture("accessibility-\(name)")
        // Full image-based audits also inspect text printed inside media and native
        // translucent bars; retain an opt-in diagnostic pass for manual review.
        // Stable hit targets and element descriptions are the regression gate.
        let types: XCUIAccessibilityAuditType = ProcessInfo.processInfo.environment["PROMPIX_FULL_ACCESSIBILITY_AUDIT"] == "1"
            ? .all : [.hitRegion, .sufficientElementDescription]
        try app.performAccessibilityAudit(for: types) { issue in
            print("AUDIT \(name) \(issue.auditType) label=\(issue.element?.label ?? "nil") identifier=\(issue.element?.identifier ?? "nil")")
            return false
        }
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
    func testOriginalImageExamplesWorkOffline() {
        app.buttons["kind-image"].tap()
        for id in ["paper-forms", "object-poster", "quiet-book", "color-memory"] {
            let card = app.buttons["prompt-\(id)"]
            for _ in 0..<6 { if card.isHittable { break }; app.swipeUp() }
            XCTAssertTrue(card.isHittable); card.tap()
            XCTAssertTrue(app.buttons["previewButton"].waitForExistence(timeout: 5))
            capture("original-\(id)-detail")
            app.buttons["previewButton"].tap()
            XCTAssertTrue(app.descendants(matching: .any)["loadedImage-0"].waitForExistence(timeout: 5))
            XCTAssertFalse(app.buttons["retryImage"].exists)
            capture("original-\(id)-image")
            app.buttons["完成"].tap()
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
    }

    func testImageWebAndCollections() {
        app.buttons["kind-image"].tap()
        app.buttons["prompt-summer-citrus"].tap()
        app.buttons["previewButton"].tap()
        XCTAssertTrue(app.buttons["完成"].waitForExistence(timeout: 5))
        capture("06-image-viewer")
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
    func testFirstVideoUpdateExplainsOfflineAvailabilityAndReturnsToIdeas() throws {
        app.buttons["kind-video"].tap()
        XCTAssertTrue(app.staticTexts["视频灵感，联网后见"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["loadVideoExamples"].isHittable)
        XCTAssertFalse(app.buttons["prompt-slow-road"].exists)
        try waitForRenderingToSettle()
        try app.performAccessibilityAudit(for: [.hitRegion, .sufficientElementDescription])
        capture("07-video-first-update")
        app.buttons["browseOtherIdeas"].tap()
        XCTAssertTrue(app.buttons["prompt-gentle-tarot"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["loadVideoExamples"].exists)
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
            XCTAssertTrue(app.descendants(matching: .any)["loadedImage-\(index - 1)"].waitForExistence(timeout: 20))
            capture("gallery-\(index)")
            if index < 4 { app.buttons["nextImage"].tap() }
        }
        XCTAssertFalse(app.buttons["nextImage"].isEnabled)
        app.buttons["previousImage"].tap()
        XCTAssertTrue(app.navigationBars["3 / 4"].waitForExistence(timeout: 5))
        app.descendants(matching: .any)["loadedImage-2"].swipeRight()
        XCTAssertTrue(app.navigationBars["2 / 4"].waitForExistence(timeout: 5))
        app.descendants(matching: .any)["loadedImage-1"].doubleTap()
        capture("gallery-zoom")
        app.descendants(matching: .any)["loadedImage-1"].doubleTap()
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
