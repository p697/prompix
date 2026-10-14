import XCTest

/// A production-cache journey. The host owns the device pose and stages a
/// backed-up catalog. VoiceOver checks restore their original accessibility state.
@MainActor final class DuoDeliveryUITests: XCTestCase {
    private let app = XCUIApplication()

    func testDiscoveryVoiceOverAnnouncesHeadingActions() throws {
        #if compiler(>=6.4) && targetEnvironment(simulator)
        guard #available(iOS 27.0, *), ProcessInfo.processInfo.environment["PROMPIX_DUO_DELIVERY"] == "1" else {
            throw XCTSkip("Enable only for dedicated simulator VoiceOver acceptance.")
        }
        continueAfterFailure = true
        let directory = try acceptanceDirectory()
        let catalog = try JSONDecoder().decode(CatalogSnapshot.self,
            from: Data(contentsOf: directory.appendingPathComponent("catalog.json")))
        XCTAssertGreaterThan(catalog.prompts.count, 100)
        let personal = try ["drafts.json", "favorites.json", "creators.json"].map { name in
            PersonalSnapshot(name: name, data: try readPersonalFile(name, in: directory))
        }
        let voiceOver = XCUIDevice.shared.voiceOverService
        let wasVoiceOverEnabled = voiceOver.isEnabled
        var speech: [String] = []
        func record(_ value: String) { speech.append(value); print("VOICEOVER SHORTCUT: \(value)") }
        func require(_ condition: Bool, _ message: String) throws {
            guard condition else { throw NSError(domain: "VoiceOverShortcut", code: 1,
                userInfo: [NSLocalizedDescriptionKey: message]) }
        }
        defer {
            do {
                if wasVoiceOverEnabled { try voiceOver.enable() }
                else { try voiceOver.disable() }
            }
            catch { XCTFail("Could not restore VoiceOver: \(error)") }
            let transcript = XCTAttachment(string: speech.joined(separator: "\n"))
            transcript.name = "discovery-heading-actions-spoken-output"
            transcript.lifetime = .keepAlways
            add(transcript)
            app.terminate()
        }
        if voiceOver.isEnabled { try voiceOver.disable() }
        app.launchArguments = ["--cached-only", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh-Hans"]
        app.launchPrompix()
        let filter = app.buttons["kind-text"]
        XCTAssertTrue(filter.waitForExistence(timeout: 10))
        filter.tap()
        XCTAssertTrue(filter.isSelected)

        try voiceOver.enable()
        let heading = app.staticTexts["discoveryHeading"]
        try require(heading.exists && heading.isHittable, "The discovery heading must remain reachable.")
        var utterance = try voiceOver.currentSpeech().utterance
        record("initial: \(utterance)")
        for _ in 0..<30 {
            if utterance.contains("Prompix") && utterance.contains("标题") { break }
            utterance = try voiceOver.moveBackward().utterance
            record("toward heading: \(utterance)")
        }
        try require(utterance.contains("Prompix") && utterance.contains("标题"), utterance)
        // This checks actual speech and action selection only. Sheet activation
        // is verified separately through the simulator's exposed AX actions;
        // injected keyboard/touch activation has not passed on the Duo runtime.
        for action in ["搜索", "设置"] {
            for _ in 0..<4 {
                app.typeKey(.downArrow, modifierFlags: [.control, .option])
                utterance = try voiceOver.currentSpeech().utterance
                record("action: \(utterance)")
                if utterance.trimmingCharacters(in: .whitespacesAndNewlines) == action { break }
            }
            try require(utterance.trimmingCharacters(in: .whitespacesAndNewlines) == action,
                "Select the named action with VoiceOver: \(utterance)")
        }
        capture("heading-actions-announced")
        try voiceOver.disable()
        XCTAssertTrue(filter.isSelected, "Selecting an accessibility action must retain the discovery filter.")
        let current = try acceptanceDirectory()
        for snapshot in personal {
            XCTAssertTrue(try readPersonalFile(snapshot.name, in: current) == snapshot.data,
                "Navigation actions must preserve personal data: \(snapshot.name)")
        }
        #else
        throw XCTSkip("Requires the iOS 27 VoiceOver test service on a simulator.")
        #endif
    }

    func testLastHomeCreatorIsVisibleAndOpens() throws {
        continueAfterFailure = false
        guard ProcessInfo.processInfo.environment["PROMPIX_DUO_DELIVERY"] == "1" else {
            throw XCTSkip("Enable only for the staged Duo delivery acceptance.")
        }
        #if !targetEnvironment(simulator)
        throw XCTSkip("Duo delivery acceptance is simulator-only.")
        #endif

        let directory = try acceptanceDirectory()
        let catalog = try JSONDecoder().decode(CatalogSnapshot.self,
            from: Data(contentsOf: directory.appendingPathComponent("catalog.json")))
        XCTAssertGreaterThan(catalog.prompts.count, 100, "Use the downloaded production catalog, not bundled fixtures.")
        let personal = try ["drafts.json", "favorites.json", "creators.json"].map { name in
            PersonalSnapshot(name: name, data: try readPersonalFile(name, in: directory))
        }
        defer {
            app.terminate()
            do {
                // XCTest may replace the container on launch. Resolve it again
                // before restoring bytes, including originally absent files.
                let current = try acceptanceDirectory()
                for snapshot in personal {
                    let url = current.appendingPathComponent(snapshot.name)
                    if let data = snapshot.data {
                        try data.write(to: url, options: .atomic)
                    } else if FileManager.default.fileExists(atPath: url.path) {
                        try FileManager.default.removeItem(at: url)
                    }
                    XCTAssertTrue(try readPersonalFile(snapshot.name, in: current) == snapshot.data,
                        "Restore the original personal file: \(snapshot.name)")
                }
            } catch {
                XCTFail("Could not restore the staged simulator's personal files: \(error)")
            }
        }

        app.launchArguments = ["--cached-only", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh-Hans"]
        app.launchPrompix()
        XCTAssertTrue(app.buttons["discoverySettings"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["allCreators"].waitForExistence(timeout: 5))

        let creators = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'creator-'"))
            .allElementsBoundByIndex
        // CreatorRail's eager HStack exposes its complete ten-entry order. A
        // one-entry accessibility variant must not count as a horizontal pass.
        XCTAssertEqual(creators.count, 10, "Stage a full creator rail with ordinary text size and VoiceOver off.")
        let last = try XCTUnwrap(creators.last)
        let lastID = last.identifier
        let lastName = last.label
        let window = app.windows.containing(.button, identifier: "allCreators").firstMatch
        XCTAssertTrue(window.exists)
        // Both the outer feed and the inner rail contain this creator. Choose
        // the innermost viewport; app.frame can describe Duo's inactive display.
        let rail = try XCTUnwrap(app.scrollViews.containing(.button, identifier: lastID)
            .allElementsBoundByIndex.filter { $0.frame.height > 0 }
            .min { $0.frame.height < $1.frame.height })
        XCTAssertLessThan(rail.frame.height, window.frame.height / 2)
        capture("duo-creators-01-start")

        var swipeCount = 0
        repeat {
            rail.swipeLeft()
            swipeCount += 1
        } while !fullyVisible(last, in: rail, window: window) && swipeCount < 8
        // Settle at the actual trailing edge, rather than stopping when a small
        // part of the last button first becomes hittable.
        rail.swipeLeft()
        XCTAssertTrue(fullyVisible(last, in: rail, window: window),
            "The entire final creator target must fit in the current rail and app window.")
        XCTAssertTrue(last.isHittable)
        capture("duo-creators-02-last-visible")
        last.tap()

        XCTAssertTrue(app.buttons["saveCreator"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts[lastName].firstMatch.exists,
            "The profile must identify the creator selected at the end of the rail.")
        XCTAssertTrue(app.links["creatorExternalProfile"].exists || app.buttons["creatorExternalProfile"].exists)
        capture("duo-creators-03-profile")
        // Duo can move the system back button outside a navigation bar. Keep
        // the traditional native-bar fallback, excluding bookmark and share.
        let systemBack = app.buttons["BackButton"]
        let back = systemBack.exists && systemBack.isHittable ? systemBack
            : app.navigationBars.buttons.matching(NSPredicate(
                format: "identifier != %@ AND identifier != %@", "saveCreator", "shareCreator")).firstMatch
        guard back.exists && back.isHittable else {
            let hierarchy = XCTAttachment(string: app.debugDescription)
            hierarchy.name = "duo-creators-missing-native-back"
            hierarchy.lifetime = .keepAlways
            add(hierarchy)
            XCTFail("The creator profile must expose a hittable native back button.")
            return
        }
        back.tap()

        XCTAssertTrue(app.buttons["discoverySettings"].waitForExistence(timeout: 5))
        let returnedCreator = app.buttons[lastID]
        XCTAssertTrue(returnedCreator.waitForExistence(timeout: 5))
        XCTAssertTrue(fullyVisible(returnedCreator, in: rail, window: window),
            "Returning from a creator should retain the horizontal browsing position.")
        XCTAssertTrue(returnedCreator.isHittable)
        capture("duo-creators-04-returned")
        let current = try acceptanceDirectory()
        for snapshot in personal {
            XCTAssertTrue(try readPersonalFile(snapshot.name, in: current) == snapshot.data,
                "Browsing a creator must not alter personal state: \(snapshot.name)")
        }
    }

    private func fullyVisible(_ element: XCUIElement, in rail: XCUIElement, window: XCUIElement) -> Bool {
        guard element.exists else { return false }
        let frame = element.frame
        let viewport = rail.frame.intersection(window.frame)
        return frame.width > 0 && frame.height > 0 && !viewport.isNull
            && viewport.insetBy(dx: -1, dy: -1).contains(frame)
    }

    private func capture(_ name: String) {
        for (index, screen) in XCUIScreen.screens.enumerated() {
            let attachment = XCTAttachment(screenshot: screen.screenshot())
            attachment.name = "\(name)-display-\(index)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    private struct CatalogSnapshot: Decodable {
        let prompts: [Item]
        struct Item: Decodable { let id: String }
    }

    private struct PersonalSnapshot {
        let name: String
        let data: Data?
    }

    private func readPersonalFile(_ name: String, in directory: URL) throws -> Data? {
        let url = directory.appendingPathComponent(name)
        return FileManager.default.fileExists(atPath: url.path) ? try Data(contentsOf: url) : nil
    }

    private func acceptanceDirectory() throws -> URL {
        let environment = ProcessInfo.processInfo.environment
        let path = try XCTUnwrap(environment["PROMPIX_ACCEPTANCE_CONTAINER"],
            "Pass the explicitly staged simulator app-container path.")
        let simulatorID = try XCTUnwrap(environment["SIMULATOR_UDID"].flatMap { UUID(uuidString: $0) })
        let container = URL(fileURLWithPath: path).standardizedFileURL
        let parent = container.deletingLastPathComponent()
        let suffix = "/CoreSimulator/Devices/\(simulatorID.uuidString)/data/Containers/Data/Application"
        guard parent.path.hasSuffix(suffix), UUID(uuidString: container.lastPathComponent) != nil else {
            throw CocoaError(.fileReadNoPermission)
        }
        let matches = try FileManager.default.contentsOfDirectory(at: parent, includingPropertiesForKeys: nil).filter { candidate in
            guard UUID(uuidString: candidate.lastPathComponent) != nil,
                  let data = try? Data(contentsOf: candidate.appendingPathComponent(".com.apple.mobile_container_manager.metadata.plist")),
                  let fields = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else { return false }
            return fields["MCMMetadataIdentifier"] as? String == "com.p697.prompix"
        }
        XCTAssertEqual(matches.count, 1, "Resolve exactly one metadata-verified Prompix container in the selected simulator.")
        return try XCTUnwrap(matches.count == 1 ? matches.first : nil)
            .appendingPathComponent("Library/Application Support/Prompix", isDirectory: true)
    }
}
