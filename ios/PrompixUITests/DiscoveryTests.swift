import XCTest
import UIKit

@MainActor final class DiscoveryTests: XCTestCase {
    private var app: XCUIApplication!
    override func setUp() async throws {
        continueAfterFailure = false
        #if compiler(>=6.4)
        if #available(iOS 27.0, *), XCUIDevice.shared.voiceOverService.isEnabled {
            try XCUIDevice.shared.voiceOverService.disable()
        }
        #endif
        app = XCUIApplication()
        app.launchArguments += ["--offline", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
    }
    private func dismissUnsavedDraftPopover() throws {
        let window = app.windows.containing(.button, identifier: "copyDraftAndLeave").firstMatch
        let popover = app.popovers.containing(.button, identifier: "copyDraftAndLeave").firstMatch
        XCTAssertTrue(window.exists && popover.exists)
        guard window.exists && popover.exists else { throw NSError(domain: "Acceptance", code: 1) }
        let point = CGPoint(x: (popover.frame.maxX + window.frame.maxX) / 2, y: window.frame.midY)
        XCTAssertTrue(window.frame.contains(point) && !popover.frame.contains(point))
        // Anchor input to the actual dialog display, not the application's outer display.
        window.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: point.x - window.frame.minX, dy: point.y - window.frame.minY)).tap()
    }

    func capture(_ name: String) {
        for (index, screen) in XCUIScreen.screens.enumerated() {
            let shot = XCTAttachment(screenshot: screen.screenshot())
            shot.name = "\(name)-display-\(index)"; shot.lifetime = .keepAlways; add(shot)
        }
    }
    private func selectTab(_ title: String) {
        app.selectPrompixTab(title)
    }
    private func visibleFrame(of element: XCUIElement) -> CGRect {
        let window = app.windows.containing(.any, identifier: element.identifier).firstMatch
        let bounds = window.exists ? window.frame : app.frame
        // The application frame may still describe Duo's inactive outer display.
        return element.frame.intersection(bounds)
    }
    // Run with a Release configuration; record simulator and device results separately.
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
        func isHeading(_ value: String) -> Bool {
            normalized(value).contains("prompix") && value.contains("标题")
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

        // Verify the heading through sequential navigation. Native side toolbars
        // can follow the content, so their actions are explored separately below.
        let backwardDeadline = Date().addingTimeInterval(45)
        for _ in 0..<36 {
            if let current = speech.last, isHeading(current) { break }
            if Date() >= backwardDeadline { break }
            speech.append(try voiceOver.moveBackward().utterance)
        }
        XCTAssertTrue(speech.contains(where: isHeading), "VoiceOver must expose Prompix as a heading.")
        // With the default flat VoiceOver navigation, native side-toolbar
        // actions can follow the feed. Traverse that real order rather than
        // assuming a top bar or requiring the optional Groups navigation style.
        func reachedActions() -> Bool {
            ["搜索", "设置"].allSatisfy { name in
                speech.contains { $0.contains(name) && $0.contains("按钮") }
            }
        }
        let toolbarDeadline = Date().addingTimeInterval(100)
        var repeated = 0
        for _ in 0..<180 {
            if reachedActions() || Date() >= toolbarDeadline || repeated >= 3 { break }
            let value = try voiceOver.moveForward().utterance
            repeated = speech.last == value ? repeated + 1 : 0
            speech.append(value)
        }
        XCTAssertTrue(reachedActions(), "Native VoiceOver navigation must reach Search and Settings as buttons.")
        XCTAssertFalse(speech.contains { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }, "Focused elements must produce meaningful speech.")
        for decoration in ["A LITTLE PERSPECTIVE", "今天，慢慢来。"] {
            XCTAssertFalse(speech.contains { normalized($0).contains(normalized(decoration)) }, "Decorative cover text must not become a separate VoiceOver stop: \(decoration)")
        }
        #else
        throw XCTSkip("Actual VoiceOver traversal requires Xcode 27 or later.")
        #endif
    }

    func testVoiceOverDetailEditorAndSavedRoundTrip() throws {
        #if compiler(>=6.4)
        guard #available(iOS 27.0, *) else { throw XCTSkip("Actual spoken traversal requires iOS 27.") }
        continueAfterFailure = true
        let voiceOver = XCUIDevice.shared.voiceOverService
        var speech: [String] = []
        defer {
            do { try voiceOver.disable() } catch { XCTFail("Could not restore VoiceOver: \(error)") }
            let transcript = XCTAttachment(string: speech.joined(separator: "\n"))
            transcript.name = "VoiceOver detail editor saved round trip"
            transcript.lifetime = .keepAlways
            add(transcript)
        }
        if voiceOver.isEnabled { try voiceOver.disable() }
        try voiceOver.enable()

        func require(_ condition: Bool, _ message: String) throws {
            guard condition else {
                XCTFail(message)
                throw NSError(domain: "PrompixVoiceOverTest", code: 2, userInfo: [NSLocalizedDescriptionKey: message])
            }
        }
        func focus(_ description: String, backwards: Bool = false, matching predicate: (String) -> Bool) throws {
            let deadline = Date().addingTimeInterval(45)
            var utterance = try voiceOver.currentSpeech().utterance
            for _ in 0..<70 {
                speech.append("\(description): \(utterance)")
                if predicate(utterance) { return }
                if Date() >= deadline { break }
                utterance = try (backwards ? voiceOver.moveBackward() : voiceOver.moveForward()).utterance
            }
            XCTFail("VoiceOver did not reach \(description)")
            throw NSError(domain: "PrompixVoiceOverTest", code: 1)
        }
        func activate(_ element: XCUIElement) {
            // Spoken focus is verified above. XCTest's synthesized pointer
            // events target the element; they are not physical VO gestures.
            XCTAssertTrue(element.exists)
            element.doubleTap()
        }
        // The bundled creatorless catalog exercises the same persistent entry
        // as an older downloaded catalog. Verify actual speech and navigation,
        // without claiming coverage of downloaded creator names or profiles.
        // VoiceOver can restore an earlier card focus when enabled. Anchor at
        // the toolbar before moving forward to the creator section.
        app.buttons["searchButton"].tap()
        let initialSpeech = try voiceOver.currentSpeech().utterance
        speech.append("initial toolbar focus (targeted exploration): \(initialSpeech)")
        try require(initialSpeech.contains("搜索") && initialSpeech.contains("按钮"), "Initial spoken focus must be the Search toolbar action")
        try focus("creator section") { $0.contains("创作者") && $0.contains("标题") }
        try focus("creator directory entry") { $0.contains("查看全部") && $0.contains("按钮") }
        activate(app.buttons["allCreators"])
        try require(app.buttons["loadCreatorsDirectory"].waitForExistence(timeout: 5), "The spoken creator entry must open its directory")
        try focus("creator empty state") { $0.contains("暂无创作者") }
        try focus("creator update action") { $0.contains("检查内容更新") && $0.contains("按钮") }
        try focus("creator directory back", backwards: true) { $0.contains("返回") && $0.contains("按钮") }
        activate(app.navigationBars.buttons.element(boundBy: 0))
        try require(app.buttons["kind-text"].waitForExistence(timeout: 5), "Creator-directory Back must restore discovery")
        app.buttons["kind-text"].tap()
        let textFilterSpeech = try voiceOver.currentSpeech().utterance
        speech.append("text filter (targeted exploration): \(textFilterSpeech)")
        try require(textFilterSpeech.contains("文本") && textFilterSpeech.contains("按钮"), "The explored filter must announce Text")
        activate(app.buttons["kind-text"])
        try require(app.buttons["kind-text"].isSelected, "The spoken Text filter must activate")
        try focus("card") { $0.contains("抽一张塔罗") && !$0.contains("收藏") }
        activate(app.buttons["prompt-gentle-tarot"])
        try require(app.buttons["copyPrompt"].waitForExistence(timeout: 5), "Spoken card must open detail")
        try focus("detail content license") { $0.contains("内容许可") && $0.contains("Creative Commons Zero") }
        try focus("detail copy") { $0.contains("复制 Prompt") }
        activate(app.buttons["copyPrompt"])
        try require(app.buttons["copyPrompt"].label.contains("已复制"), "Copy must confirm its action")
        try focus("detail edit", backwards: true) { $0.contains("编辑后使用") }
        activate(app.buttons["编辑后使用"])
        let editor = app.textViews["promptEditor"]
        try require(editor.waitForExistence(timeout: 5), "Spoken edit action must open the editor")
        let spokenPrefix = String((editor.value as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(20))
        try require(!spokenPrefix.isEmpty, "Editor must have meaningful current content")
        try focus("editor text") { $0.contains(spokenPrefix) }
        activate(editor)
        try require(app.keyboards.firstMatch.waitForExistence(timeout: 5), "Show the simulator software keyboard for the spoken editor journey")
        let marker = " VoiceOver-\(UUID().uuidString.prefix(8)) "
        editor.typeText(marker)
        try require((editor.value as? String ?? "").contains(marker), "Editor must accept this run's unique note")
        try focus("editor copy") { $0.contains("复制修改后的 Prompt") }
        var copyFrame = app.buttons["copyEditedPrompt"].frame
        var unchangedSince = Date()
        let stableCopy = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let frame = self.app.buttons["copyEditedPrompt"].frame
            if frame != copyFrame { copyFrame = frame; unchangedSince = Date() }
            return Date().timeIntervalSince(unchangedSince) >= 0.6
        }, object: nil)
        try require(XCTWaiter.wait(for: [stableCopy], timeout: 5) == .completed, "Copy action must settle above the visible keyboard")
        // The keyboard's delayed announcement can replace currentSpeech after
        // Copy was reached. Continuing forward then traverses every keyboard
        // key and ends at Dictation. Explore the settled control directly, as
        // with the saved tab below, and require real spoken focus before acting.
        let settledCopy = app.buttons["copyEditedPrompt"]
        try require(settledCopy.isHittable, "The settled copy action must be reachable above the keyboard")
        settledCopy.tap()
        let settledCopySpeech = try voiceOver.currentSpeech().utterance
        speech.append("settled editor copy (targeted exploration): \(settledCopySpeech)")
        try require(settledCopySpeech.contains("复制修改后的 Prompt") && settledCopySpeech.contains("按钮"),
                    "The explored settled control must announce Copy Edited Prompt")
        let beforeCopy = editor.value as? String
        activate(settledCopy)
        let confirmation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "已复制"), object: app.buttons["copyEditedPrompt"])
        try require(XCTWaiter.wait(for: [confirmation], timeout: 3) == .completed, "Edited copy must confirm its action")
        try require(editor.value as? String == beforeCopy, "Copy activation must not type into the editor")
        try focus("editor done", backwards: true) { $0.contains("完成") && $0.contains("按钮") }
        activate(app.buttons["完成"])
        try require(app.buttons["detailFavorite"].waitForExistence(timeout: 5), "Done must leave the editor")
        try focus("bookmark") { $0.contains("收藏") && $0.contains("按钮") }
        let wasSaved = app.buttons["detailFavorite"].label == "取消收藏"
        activate(app.buttons["detailFavorite"])
        try require(app.buttons["detailFavorite"].label == (wasSaved ? "收藏 Prompt" : "取消收藏"), "Bookmark state must change")
        if wasSaved {
            try focus("save again") { $0.contains("收藏") && $0.contains("按钮") }
            activate(app.buttons["detailFavorite"])
        }
        try focus("detail back", backwards: true) { $0.contains("返回") && $0.contains("按钮") }
        activate(app.navigationBars.buttons.element(boundBy: 0))
        try require(app.buttons["kind-text"].waitForExistence(timeout: 5), "Back must reach discovery")
        // Explore the native tab directly rather than rereading the entire feed.
        app.tabBars.buttons["收藏"].tap()
        let savedTabSpeech = try voiceOver.currentSpeech().utterance
        speech.append("saved tab (targeted exploration): \(savedTabSpeech)")
        try require(savedTabSpeech.contains("收藏"), "The explored tab must announce Saved")
        activate(app.tabBars.buttons["收藏"])
        try require(app.navigationBars["收藏"].waitForExistence(timeout: 5), "Saved tab must open the saved list")
        try require(app.buttons["prompt-gentle-tarot"].waitForExistence(timeout: 5), "Saved must contain the item")
        app.buttons["prompt-gentle-tarot"].tap()
        let savedCardSpeech = try voiceOver.currentSpeech().utterance
        speech.append("saved card (targeted exploration): \(savedCardSpeech)")
        try require(savedCardSpeech.contains("抽一张塔罗") && !savedCardSpeech.contains("取消收藏"), "Saved card must speak its title as the navigation action")
        capture("acceptance-voiceover-saved")
        #else
        throw XCTSkip("Actual spoken traversal requires Xcode 27.")
        #endif
    }

    func testLongDraftEditingAndInteractiveDismissal() throws {
        try exerciseLongDraft(requireVisibleKeyboard: false)
    }

    func testVisibleSoftwareKeyboardLongDraftLayout() throws {
        guard ProcessInfo.processInfo.environment["PROMPIX_VISIBLE_SOFTWARE_KEYBOARD"] == "1" else {
            throw XCTSkip("Opt in on a simulator with its software keyboard visibly enabled.")
        }
        try exerciseLongDraft(requireVisibleKeyboard: true)
    }

    private func exerciseLongDraft(requireVisibleKeyboard: Bool) throws {
        app.buttons["kind-text"].tap()
        app.buttons["prompt-gentle-tarot"].tap()
        app.buttons["编辑后使用"].tap()
        let editor = app.textViews["promptEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap()
        let keyboard = app.keyboards.firstMatch
        if requireVisibleKeyboard {
            guard keyboard.waitForExistence(timeout: 5), keyboard.isHittable, keyboard.frame.height > 200 else {
                throw XCTSkip("Software keyboard is not visibly available; editing persistence does not establish keyboard-obstruction coverage.")
            }
        }
        let paragraph = "Consider one small creative choice today. Describe the scene, the feeling, and one practical next step. Keep the original idea intact.\n\n"
        let inserted = "\n" + String(repeating: paragraph, count: 12) + "PROMPIX-END-X"
        editor.typeText(inserted)
        editor.typeText(XCUIKeyboardKey.delete.rawValue + "Y")
        let expected = try XCTUnwrap(editor.value as? String)
        XCTAssertTrue(expected.contains("PROMPIX-END-Y"))
        XCTAssertGreaterThan(expected.count, 1600)
        if requireVisibleKeyboard {
            // Refocus after bulk text injection before checking the on-screen
            // keyboard; XCTest may use hardware input for the long insertion.
            editor.tap()
            let visibleKeyboard = app.keyboards.firstMatch
            capture("long-editor-keyboard-check")
            XCTAssertTrue(visibleKeyboard.waitForExistence(timeout: 5) && visibleKeyboard.isHittable)
            XCTAssertGreaterThan(visibleKeyboard.frame.height, 200, "Software keyboard must occupy visible layout space")
        }
        let layout = XCTAttachment(string: "Keyboard frame: \(keyboard.frame); editor frame: \(editor.frame); copy frame: \(app.buttons["copyEditedPrompt"].frame)")
        layout.name = "Long editor keyboard layout"; layout.lifetime = .keepAlways; add(layout)
        XCTAssertTrue(app.buttons["copyEditedPrompt"].isHittable)
        XCTAssertTrue(app.buttons["完成"].isHittable)
        capture(requireVisibleKeyboard ? "acceptance-long-editor-visible-keyboard" : "acceptance-long-editor-editing")
        app.buttons["copyEditedPrompt"].tap()
        XCTAssertTrue(app.buttons["copyEditedPrompt"].label.contains("已复制"))
        // Drag the sheet header, rather than scrolling the TextEditor content.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08))
            .press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)))
        XCTAssertTrue(editor.waitForNonExistence(timeout: 5))
        app.buttons["编辑后使用"].tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        XCTAssertEqual(editor.value as? String, expected, "Swipe dismissal must preserve the complete draft")
        capture("acceptance-long-editor-restored")
        app.buttons["完成"].tap()
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)))
        XCTAssertTrue(app.buttons["kind-text"].waitForExistence(timeout: 5), "Native edge return must reach discovery")
        // Restore this simulator-only draft so later VoiceOver traversal remains concise.
        app.buttons["prompt-gentle-tarot"].tap()
        app.buttons["编辑后使用"].tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        app.buttons["编辑选项"].tap()
        let original = app.buttons["恢复原始 Prompt"]
        if original.exists {
            original.tap()
            app.buttons["恢复原文"].tap()
        } else {
            app.buttons["恢复当前语言的内容"].tap()
            app.buttons["恢复译文"].tap()
        }
        XCTAssertFalse((editor.value as? String ?? "").contains("PROMPIX-END-Y"))
        app.buttons["完成"].tap()
    }

    func testReducedMotionImageZoomAndReturn() throws {
        guard UIAccessibility.isReduceMotionEnabled else { throw XCTSkip("Run explicitly with the simulator Reduce Motion setting enabled.") }
        let state = XCTAttachment(string: "UIAccessibility.isReduceMotionEnabled = true")
        state.name = "Reduced Motion runtime state"; state.lifetime = .keepAlways; add(state)
        app.buttons["kind-image"].tap()
        app.buttons["prompt-paper-forms"].tap()
        app.buttons["previewButton"].tap()
        let image = app.descendants(matching: .any)["loadedImage-0"]
        XCTAssertTrue(image.waitForExistence(timeout: 5))
        image.doubleTap()
        capture("acceptance-reduced-motion-zoom")
        image.doubleTap()
        app.buttons["完成"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
    }

    func testDraftWriteFailureKeepsBufferUntilExplicitExit() throws {
        #if targetEnvironment(simulator)
        guard let containerPath = ProcessInfo.processInfo.environment["PROMPIX_DRAFT_FIXTURE_CONTAINER"] else {
            throw XCTSkip("Requires an explicit simulator Prompix app-container path for the reversible write-collision fixture.")
        }
        guard let simulatorID = ProcessInfo.processInfo.environment["SIMULATOR_UDID"], UUID(uuidString: simulatorID) != nil else {
            throw XCTSkip("Requires a valid running simulator UUID.")
        }
        let explicitContainer = URL(fileURLWithPath: containerPath).standardizedFileURL
        guard explicitContainer.path.contains("/CoreSimulator/Devices/\(simulatorID)/data/Containers/Data/Application/"),
              UUID(uuidString: explicitContainer.lastPathComponent) != nil else {
            throw XCTSkip("Refusing a path outside the current simulator's app containers.")
        }
        // XCTest may reinstall the app between the host's opt-in and this test.
        // Resolve that new UUID only inside the same simulator's explicit parent.
        let candidates = try FileManager.default.contentsOfDirectory(at: explicitContainer.deletingLastPathComponent(), includingPropertiesForKeys: nil)
        let matches = candidates.filter { candidate in
            guard UUID(uuidString: candidate.lastPathComponent) != nil,
                  let data = try? Data(contentsOf: candidate.appendingPathComponent(".com.apple.mobile_container_manager.metadata.plist")),
                  let fields = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else { return false }
            return fields["MCMMetadataIdentifier"] as? String == "com.p697.prompix"
        }
        guard matches.count == 1, let container = matches.first else {
            throw XCTSkip("Requires exactly one metadata-verified Prompix container in the current simulator.")
        }
        continueAfterFailure = true
        let fileManager = FileManager.default
        let draftFile = container.appendingPathComponent("Library/Application Support/Prompix/drafts.json")
        let originalData = fileManager.fileExists(atPath: draftFile.path) ? try Data(contentsOf: draftFile) : nil
        func restore(_ bytes: Data?) throws {
            if fileManager.fileExists(atPath: draftFile.path) { try fileManager.removeItem(at: draftFile) }
            if let bytes { try bytes.write(to: draftFile, options: .atomic) }
        }
        addTeardownBlock { @MainActor in
            self.app.terminate()
            do {
                try restore(originalData)
                if let originalData { XCTAssertEqual(try Data(contentsOf: draftFile), originalData) }
                else { XCTAssertFalse(fileManager.fileExists(atPath: draftFile.path)) }
            } catch { XCTFail("Could not restore simulator draft fixture: \(error)") }
        }
        func require(_ condition: Bool, _ message: String) throws {
            guard condition else {
                XCTFail(message)
                throw NSError(domain: "PrompixDraftFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
            }
        }
        func collide() throws {
            try fileManager.removeItem(at: draftFile)
            try fileManager.createDirectory(at: draftFile, withIntermediateDirectories: false)
        }
        func durableDraft() throws -> String? {
            let values = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: draftFile))
            return values["gentle-tarot::zh-Hans"]
        }
        let useMode = ProcessInfo.processInfo.environment["PROMPIX_PREPARED_DRAFT_ACCEPTANCE"]
        let fromUse = useMode != nil
        func openEditor(fromDetail: Bool) throws {
            if fromUse {
                if useMode == "nested" && !fromDetail {
                    app.buttons["编辑后使用"].tap()
                    return
                }
                if fromDetail {
                    if useMode == "nested" {
                        app.buttons["编辑后使用"].tap()
                        try require(app.buttons["useEditedPrompt"].waitForExistence(timeout: 5), "Outer editor must expose use")
                        app.buttons["useEditedPrompt"].tap()
                    } else { app.buttons["usePrompt"].tap() }
                }
                try require(app.buttons["editPreparedPrompt"].waitForExistence(timeout: 5), "Use panel must offer editing")
                app.buttons["editPreparedPrompt"].tap()
            } else { app.buttons["编辑后使用"].tap() }
        }
        app.buttons["kind-text"].tap()
        app.buttons["prompt-gentle-tarot"].tap()
        try openEditor(fromDetail: true)
        let editor = app.textViews["promptEditor"]
        try require(editor.waitForExistence(timeout: 5), "Editor must open")
        editor.tap()
        editor.typeText(" Durable fixture baseline.")
        app.buttons["copyEditedPrompt"].tap()
        let baseline = try XCTUnwrap(editor.value as? String)
        try require(try durableDraft() == baseline, "Baseline must be saved before introducing a write collision")
        let baselineBytes = try Data(contentsOf: draftFile)
        try collide()
        editor.tap()
        editor.typeText(" Recovered write-failure note.")
        try require(app.buttons["retryDraftSave"].waitForExistence(timeout: 5), "Inline failure must preserve the editor")
        try require(editor.exists, "Storage failure must not dismiss the editor")
        let recovered = try XCTUnwrap(editor.value as? String)
        if !recovered.contains("Recovered write-failure note.") {
            let evidence = XCTAttachment(string: "Baseline: \(baseline)\nRecovered: \(recovered)")
            evidence.name = "Write-failure actual editor buffer"; evidence.lifetime = .keepAlways; add(evidence)
            capture("write-failure-buffer-mismatch")
        }
        try require(recovered.contains("Recovered write-failure note."), "The typed failure note must stay intact")
        try require(app.buttons["retryDraftSave"].waitForExistence(timeout: 5), "Write failure must expose Retry")
        try require(app.staticTexts["draftStatus"].label.contains("尚未保存"), "Failure status must remain visible")
        if ProcessInfo.processInfo.environment["PROMPIX_DRAFT_LAYOUT_ONLY"] == "1" {
            capture("acceptance-write-failure-largest-text")
            let copyFrame = app.buttons["copyEditedPrompt"].frame
            let editorFrame = visibleFrame(of: editor)
            let keyboard = app.keyboards.firstMatch
            let keyboardFrame = keyboard.exists ? keyboard.frame.intersection(app.frame) : CGRect.null
            let keyboardOverlap = editorFrame.intersection(keyboardFrame)
            // Measure a contiguous, full-width text area. A native Copy action
            // can be in a side toolbar and does not define the editor's bottom.
            let visibleEditorHeight = editorFrame.isNull || editorFrame.isEmpty ? 0 :
                keyboardOverlap.isNull || keyboardOverlap.isEmpty ? editorFrame.height :
                max(keyboardOverlap.minY - editorFrame.minY, editorFrame.maxY - keyboardOverlap.maxY)
            let lineHeight = UIFont.preferredFont(forTextStyle: .body).lineHeight
            let layout = XCTAttachment(string: "Preferred body font: \(UIFont.preferredFont(forTextStyle: .body).pointSize); editor frame: \(editor.frame); window-clipped editor frame: \(editorFrame); keyboard frame: \(keyboardFrame); copy frame: \(copyFrame); unobscured editor height: \(visibleEditorHeight); required line height: \(lineHeight); retry frame: \(app.buttons["retryDraftSave"].frame); leave frame: \(app.buttons["leaveUnsavedDraft"].frame)")
            layout.name = "Largest-text recovery layout"; layout.lifetime = .keepAlways; add(layout)
            try require(editor.isHittable && !editorFrame.isNull && editorFrame.width >= lineHeight && visibleEditorHeight >= lineHeight,
                        "Failure state must retain at least one full editor line inside its window and clear of the visible keyboard")
            let header = app.scrollViews["draftStatusScroll"]
            try require(header.waitForExistence(timeout: 5), "Recovery header must scroll independently")
            func reveal(_ button: XCUIElement) throws {
                for _ in 0..<5 {
                    if button.isHittable && header.frame.contains(CGPoint(x: button.frame.midX, y: button.frame.midY)) { return }
                    header.swipeUp()
                }
                try require(button.isHittable && header.frame.contains(CGPoint(x: button.frame.midX, y: button.frame.midY)), "Recovery action must be reachable by scrolling its header")
            }
            let retry = app.buttons["retryDraftSave"]
            try reveal(retry)
            retry.tap()
            try require(editor.exists && editor.value as? String == recovered, "Retry under continued storage failure must keep the buffer")
            let leave = app.buttons["leaveUnsavedDraft"]
            try reveal(leave)
            capture("acceptance-write-failure-largest-text-actions")
            leave.tap()
            try require(app.buttons["copyDraftAndLeave"].firstMatch.waitForExistence(timeout: 5), "Leave action must open its native confirmation")
            try require(app.keyboards.firstMatch.waitForNonExistence(timeout: 5), "Explicitly leaving must dismiss the keyboard so the confirmation has its full height")
            capture("acceptance-write-failure-largest-text-dialog")
            for identifier in ["copyDraftAndLeave", "discardDraftAndLeave"] {
                let action = app.buttons[identifier].firstMatch
                try require(action.isHittable && visibleFrame(of: action).contains(action.frame),
                            "Both recovery choices must be visible inside the confirmation window")
            }
            let continueEditing = app.alerts["本次修改尚未保存"].buttons["继续编辑"]
            try require(continueEditing.isHittable, "The safe Continue Editing choice must remain directly reachable")
            if app.alerts["本次修改尚未保存"].exists {
                app.alerts["本次修改尚未保存"].buttons["继续编辑"].tap()
            } else {
                try dismissUnsavedDraftPopover()
            }
            try require(app.buttons["copyDraftAndLeave"].firstMatch.waitForNonExistence(timeout: 5), "Cancelling must dismiss the native leave dialog")
            try require(editor.exists && editor.value as? String == recovered, "Cancelling leave must keep the large-text buffer")
            for button in [app.buttons["copyEditedPrompt"], app.buttons["finishPromptEditing"]] {
                try require(button.isHittable, "Fixed completion actions must remain reachable")
            }
            return
        }
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08))
            .press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)))
        try require(editor.exists, "Failed draft must resist interactive dismissal")
        try require(editor.value as? String == recovered, "Swipe must keep the entire buffer")
        app.buttons["finishPromptEditing"].tap()
        try require(editor.exists && editor.value as? String == recovered, "Done must keep the failed-save buffer")
        capture("acceptance-write-failure-buffer-protected")
        app.buttons["leaveUnsavedDraft"].tap()
        capture("acceptance-write-failure-leave-dialog")
        if app.alerts["本次修改尚未保存"].exists {
            app.alerts["本次修改尚未保存"].buttons["继续编辑"].tap()
        } else {
            // Native popover presentations omit the cancel row; tapping outside cancels.
            try dismissUnsavedDraftPopover()
        }
        try require(editor.exists && editor.value as? String == recovered, "Cancelling leave must preserve the buffer")
        try restore(baselineBytes)
        app.buttons["retryDraftSave"].tap()
        try require(app.buttons["retryDraftSave"].waitForNonExistence(timeout: 5), "Retry must recover after storage is restored")
        try require(try durableDraft() == recovered, "Retry must save the exact current buffer")
        app.buttons["finishPromptEditing"].tap()
        try openEditor(fromDetail: false)
        try require(editor.waitForExistence(timeout: 5) && editor.value as? String == recovered, "Recovered draft must reopen intact")
        capture("acceptance-write-failure-recovered")

        let recoveredBytes = try Data(contentsOf: draftFile)
        try collide()
        editor.tap()
        editor.typeText(" Copy-only unsaved ending.")
        try require(app.buttons["leaveUnsavedDraft"].waitForExistence(timeout: 5) && editor.exists, "Second failure must preserve the editor")
        let copyOnly = try XCTUnwrap(editor.value as? String)
        try require(copyOnly.contains("Copy-only unsaved ending."), "The copy-only note must stay intact")
        try require(app.buttons["leaveUnsavedDraft"].waitForExistence(timeout: 5), "Second failure must expose explicit exit")
        app.buttons["leaveUnsavedDraft"].tap()
        let copyAndLeave = app.buttons["copyDraftAndLeave"].firstMatch
        try require(copyAndLeave.waitForExistence(timeout: 5), "Leave dialog must expose Copy and Leave")
        copyAndLeave.tap()
        try require(editor.waitForNonExistence(timeout: 5), "Copy and Leave must close the editor")
        // The UI runner cannot read another app's pasteboard on this runtime.
        // Compare this exact buffer with public simctl pbpaste in the host fixture.
        let clipboardExpectation = XCTAttachment(string: copyOnly)
        clipboardExpectation.name = "Copy-and-leave expected buffer"
        clipboardExpectation.lifetime = .keepAlways
        add(clipboardExpectation)
        try restore(recoveredBytes)
        app.terminate()
        app.launch()
        app.buttons["kind-text"].tap()
        app.buttons["prompt-gentle-tarot"].tap()
        try openEditor(fromDetail: true)
        try require(editor.waitForExistence(timeout: 5) && editor.value as? String == recovered, "Relaunch must preserve the prior durable draft after explicit copy-only exit")
        try require(try durableDraft() == recovered, "Copy-only exit must not overwrite the prior durable draft")
        capture("acceptance-copy-only-exit-durable-draft")
        #else
        throw XCTSkip("Write-collision fixtures are simulator-only.")
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
        let readingPane = app.scrollViews["detailReadingPane"]
        func sourceIsVisible() -> Bool {
            guard report.exists, report.isHittable else { return false }
            let viewport = readingPane.exists ? visibleFrame(of: readingPane) : app.frame
            guard !viewport.isNull, viewport.contains(report.frame) else { return false }
            let controls = ["copyPrompt", "usePrompt", "editPromptAction", "detailFavorite", "sharePrompt"].map { app.buttons[$0] }
            let bars = app.navigationBars.allElementsBoundByIndex + app.toolbars.allElementsBoundByIndex
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
        app.buttons["编辑后使用"].tap()
        XCTAssertTrue(app.textViews["promptEditor"].waitForExistence(timeout: 5))
        try auditScreen("editor")
        app.buttons["完成"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        selectTab("专题")
        try auditScreen("collections")
        selectTab("收藏")
        try auditScreen("favorites")
        selectTab("发现")
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
        selectTab("专题")
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
        selectTab("收藏")
        XCTAssertTrue(app.buttons["prompt-gentle-tarot"].waitForExistence(timeout: 5))
        capture("04-favorites")
        app.terminate(); app.launch()
        selectTab("收藏")
        XCTAssertTrue(app.buttons["prompt-gentle-tarot"].waitForExistence(timeout: 5))
        selectTab("发现")
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

    func testImageWebAndCollections() throws {
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
        try waitForRenderingToSettle()
        capture("08b-web-example")
        app.buttons["完成"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        selectTab("专题")
        capture("09-collections")
    }
    func testFirstVideoUpdateExplainsOfflineAvailabilityAndReturnsToIdeas() throws {
        app.buttons["kind-video"].tap()
        XCTAssertTrue(app.staticTexts["视频内容需要联网更新"].waitForExistence(timeout: 5))
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
        app.buttons["Edit prompt"].tap()
        XCTAssertTrue(app.navigationBars["Edit prompt"].waitForExistence(timeout: 5))
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
        app.buttons["searchButton"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 3))
        search.tap(); search.typeText("发明")
        let card = app.buttons.containing(NSPredicate(format: "identifier BEGINSWITH %@", "prompt-youmind-nano-")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 35), "The requested community gallery must be loaded"); card.tap()
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
        let imageCard = app.buttons.containing(NSPredicate(format: "identifier BEGINSWITH %@", "prompt-youmind-nano-")).firstMatch
        XCTAssertTrue(imageCard.waitForExistence(timeout: 35), "A published community image must be loaded")
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
        XCTAssertTrue(app.navigationBars["视频预览"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["playingVideo"].waitForExistence(timeout: 35))
        XCTAssertFalse(app.buttons["retryVideo"].exists)
        capture("12-live-video-playing")
    }

    func testShareCancellationKeepsDetailUsable() throws {
        app.buttons["kind-text"].tap()
        app.buttons["prompt-gentle-tarot"].tap()
        app.buttons["sharePrompt"].tap()
        XCTAssertTrue(app.otherElements["ActivityListView"].waitForExistence(timeout: 5))
        capture("release-system-share")
        let dismissRegion = app.otherElements["PopoverDismissRegion"]
        if dismissRegion.exists { dismissRegion.tap() }
        else {
            let close = app.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", "Close", "关闭")).firstMatch
            XCTAssertTrue(close.waitForExistence(timeout: 5), app.debugDescription)
            close.tap()
        }
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        app.buttons["copyPrompt"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].label.contains("已复制"))
        app.buttons["编辑后使用"].tap()
        XCTAssertTrue(app.textViews["promptEditor"].waitForExistence(timeout: 5))
        capture("release-after-share-cancel")
    }

    func testCopiedPromptCanOpenExternalToolAndReturn() throws {
        app.buttons["kind-text"].tap()
        app.buttons["prompt-gentle-tarot"].tap()
        app.buttons["copyPrompt"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].label.contains("已复制"))
        let tool = app.links.containing(NSPredicate(format: "label BEGINSWITH %@", "使用方法")).firstMatch
        for _ in 0..<6 {
            if tool.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(tool.isHittable)
        tool.tap()
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 10))
        let browser = XCTAttachment(screenshot: safari.screenshot())
        browser.name = "release-external-tool-browser"
        browser.lifetime = .keepAlways
        add(browser)
        // Opening the tool does not send the prompt or claim automatic prefilling.
        app.activate()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        app.buttons["编辑后使用"].tap()
        XCTAssertTrue(app.textViews["promptEditor"].waitForExistence(timeout: 5))
        capture("release-after-tool-return")
    }

    func testLiveFiveScreenBrowsingPreservesReturnPosition() throws {
        app.terminate()
        app.launchArguments.removeAll { $0 == "--offline" }
        app.launch()
        let communityCard = app.buttons.containing(NSPredicate(format: "identifier BEGINSWITH %@", "prompt-youmind-nano-")).firstMatch
        XCTAssertTrue(communityCard.waitForExistence(timeout: 35), "The published community catalog must be loaded before browsing")
        for page in 1...5 {
            try waitForRenderingToSettle()
            capture("release-discovery-page-\(page)")
            let visible = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "prompt-"))
                .allElementsBoundByIndex.filter {
                    $0.isHittable && $0.frame.minY > 160 && $0.frame.maxY < app.frame.maxY - 100
                }
            let card = try XCTUnwrap(visible.first, "A complete card must be available on screen \(page)")
            let identifier = card.identifier
            let originalY = card.frame.minY
            card.tap()
            XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
            app.navigationBars.buttons.element(boundBy: 0).tap()
            try waitForRenderingToSettle()
            XCTAssertEqual(app.buttons[identifier].frame.minY, originalY, accuracy: 3, "Returning must preserve the browsing position")
            if page < 5 { app.swipeUp() }
        }
    }

    func testExpandedLibraryBrowsingAndSearch() throws {
        app.terminate()
        app.launchArguments.removeAll { $0 == "--offline" }
        app.launch()
        let community = app.buttons.containing(NSPredicate(format: "identifier BEGINSWITH %@", "prompt-youmind-")).firstMatch
        XCTAssertTrue(community.waitForExistence(timeout: 35))
        XCTAssertFalse(app.staticTexts["DAILY FINDS"].exists)
        XCTAssertFalse(app.staticTexts["灵感，随手可得。"].exists)
        capture("expanded-discovery-top")
        var seen = Set<String>()
        for page in 0..<75 {
            let cards = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "prompt-"))
                .allElementsBoundByIndex.filter { $0.isHittable && $0.frame.minY > 100 && $0.frame.maxY < app.frame.maxY - 90 }
            for card in cards { seen.insert(card.identifier) }
            if page % 12 == 0, let card = cards.first {
                let id = card.identifier
                let y = card.frame.minY
                capture("expanded-browse-\(page)")
                card.tap()
                XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
                app.navigationBars.buttons.element(boundBy: 0).tap()
                XCTAssertEqual(app.buttons[id].frame.minY, y, accuracy: 4)
            }
            if seen.count >= 100 { break }
            app.swipeUp()
        }
        let evidence = XCTAttachment(string: seen.sorted().joined(separator: "\n"))
        evidence.name = "Distinct cards actually visible while browsing"
        evidence.lifetime = .keepAlways
        add(evidence)
        XCTAssertGreaterThanOrEqual(seen.count, 100, "The library must support browsing beyond the old 68-item edition")
        app.buttons["searchButton"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap(); search.typeText("十五个问题")
        let matching = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "prompt-pc-"))
        let visibleResult = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in matching.allElementsBoundByIndex.contains { $0.isHittable } }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [visibleResult], timeout: 5), .completed)
        let game = try XCTUnwrap(matching.allElementsBoundByIndex.first { $0.isHittable }, "A newly added text prompt must be searchable")
        game.tap()
        XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["THE IDEA"].exists)
        XCTAssertFalse(app.staticTexts["THE PROMPT"].exists)
        capture("expanded-new-text-detail")
        app.buttons["copyPrompt"].tap()
        XCTAssertTrue(app.buttons["copyPrompt"].label.contains("已复制"))
    }

    func testEveryPublishedVideoPlaysAndBackgroundPauses() async throws {
        struct Manifest: Decodable { let catalog: URL }
        struct Edition: Decodable {
            struct Item: Decodable { let id: String; let title: String; let kind: String }
            let version: String
            let prompts: [Item]
        }
        let (manifestData, _) = try await URLSession.shared.data(from: URL(string: "https://api.prompix.dev/v1/latest.json")!)
        let manifest = try JSONDecoder().decode(Manifest.self, from: manifestData)
        XCTAssertEqual(manifest.catalog.host, "api.prompix.dev")
        let (catalogData, _) = try await URLSession.shared.data(from: manifest.catalog)
        let edition = try JSONDecoder().decode(Edition.self, from: catalogData)
        let videos = edition.prompts.filter { $0.kind == "video" }
        XCTAssertFalse(videos.isEmpty)
        var played: [String] = []
        defer {
            let evidence = XCTAttachment(string: "Edition: \(edition.version)\nPlayed:\n" + played.joined(separator: "\n"))
            evidence.name = "Published video playback inventory"
            evidence.lifetime = .keepAlways
            add(evidence)
        }
        app.terminate()
        app.launchArguments.removeAll { $0 == "--offline" }
        app.launch()
        app.buttons["searchButton"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        for (index, video) in videos.enumerated() {
            search.tap()
            if index > 0 { search.buttons["清除文本"].tap() }
            search.typeText(video.title)
            let matchingCards = app.buttons.matching(identifier: "prompt-\(video.id)")
            XCTAssertTrue(matchingCards.firstMatch.waitForExistence(timeout: 35), "The published video must be loaded: \(video.id)")
            // The presenting feed remains in XCTest's tree beneath the search sheet.
            let card = try XCTUnwrap(matchingCards.allElementsBoundByIndex.first { $0.isHittable }, video.id)
            card.tap()
            app.buttons["previewButton"].tap()
            let player = app.descendants(matching: .any)["playingVideo"]
            XCTAssertTrue(player.waitForExistence(timeout: 35), video.id)
            XCTAssertFalse(app.buttons["retryVideo"].exists, video.id)
            capture("release-video-\(index + 1)")
            played.append(video.id)
            if index == 0 {
                XCUIDevice.shared.press(.home)
                app.activate()
                let playPause = app.buttons["Play/Pause"]
                // A center tap can activate AVKit's large Play button. Reveal
                // controls away from it without accidentally resuming playback.
                if !playPause.exists { player.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.1)).tap() }
                XCTAssertTrue(playPause.waitForExistence(timeout: 5))
                XCTAssertEqual(playPause.label, "播放", "Returning from the background must leave playback paused")
                playPause.tap()
                XCTAssertEqual(playPause.label, "暂停")
                let elapsed = app.staticTexts["Elapsed Time"]
                let initial = elapsed.label
                let advances = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in elapsed.exists && elapsed.label != initial }, object: nil)
                XCTAssertEqual(XCTWaiter.wait(for: [advances], timeout: 4), .completed, "Resume must advance the native playback clock")
                capture("release-video-background-resumed")
            }
            app.buttons["完成"].tap()
            XCTAssertTrue(app.buttons["copyPrompt"].waitForExistence(timeout: 5))
            app.navigationBars.buttons.element(boundBy: 0).tap()
            XCTAssertTrue(search.waitForExistence(timeout: 5), "Closing a preview must preserve its search context")
            XCTAssertEqual(search.value as? String, video.title, "Returning must preserve the search text")
        }
        XCTAssertEqual(Set(played), Set(videos.map(\.id)))
    }

}
