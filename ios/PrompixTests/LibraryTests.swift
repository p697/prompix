import XCTest
import CryptoKit
import AVFoundation
import AVKit
@testable import Prompix

@MainActor final class LibraryTests: XCTestCase {
    private var directory: URL!
    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: directory) }

    func testSpecificCollectionsDoNotCollapseIntoEveryVisualPrompt() throws {
        let library = Library(directory: directory)
        let products = try XCTUnwrap(Collection.all.first { $0.id == "products" })
        XCTAssertTrue(products.items(in: library).contains { $0.id == "object-poster" })
        XCTAssertFalse(products.items(in: library).contains { $0.id == "tiny-island" })
        let websites = try XCTUnwrap(Collection.all.first { $0.id == "web" })
        XCTAssertEqual(websites.items(in: library).count, 6)
        XCTAssertTrue(websites.items(in: library).allSatisfy { $0.kind == .web })
        let play = try XCTUnwrap(Collection.all.first { $0.id == "play" })
        XCTAssertTrue(play.items(in: library).contains { $0.id == "gentle-tarot" })
        XCTAssertTrue(play.items(in: library).allSatisfy { $0.kind == .text })
        XCTAssertFalse(play.items(in: library).contains { $0.id == "simple-explanation" })
        XCTAssertFalse(play.items(in: library).contains { $0.id == "color-memory" })
        let covers = play.covers(from: Array(repeating: library.prompts, count: 30).flatMap { $0 })
        XCTAssertEqual(covers.count, 2)
        XCTAssertEqual(Set(covers.map(\.id)).count, 2)
        XCTAssertTrue(covers.allSatisfy { $0.kind != .text && !$0.isSkill })
        XCTAssertEqual(play.covers(from: play.items(in: library)).count, 1)
        XCTAssertEqual(play.covers(from: covers.flatMap { [$0, $0] }).map(\.id), covers.map(\.id))
        XCTAssertTrue(play.covers(from: []).isEmpty)
    }

    func testGalleryPreservesCoverOrderAndRejectsUntrustedMedia() throws {
        let cover = URL(string: "https://api.prompix.dev/media/cover.jpg")!
        let second = URL(string: "https://api.prompix.dev/media/second.jpg")!
        let media = Prompt.Media(image: nil, video: nil, demoURL: nil, imageURL: cover, imageURLs: [second, cover])
        XCTAssertEqual(media.galleryURLs, [cover, second])
        let library = Library(directory: directory)
        var raw = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(library.prompts[0])) as? [String: Any])
        raw["media"] = ["imageURLs": ["https://untrusted.example/image.jpg"]]
        let invalid = try JSONDecoder().decode(Prompt.self, from: JSONSerialization.data(withJSONObject: raw))
        XCTAssertThrowsError(try Catalog(schemaVersion: 1, version: "test", prompts: [invalid]).validated())
        raw["media"] = ["imageURLs": Array(repeating: cover.absoluteString, count: 9)]
        let tooMany = try JSONDecoder().decode(Prompt.self, from: JSONSerialization.data(withJSONObject: raw))
        XCTAssertThrowsError(try Catalog(schemaVersion: 1, version: "test", prompts: [tooMany]).validated())
    }

    func testFavoritesSurviveRelaunchAndStorePromptSnapshot() throws {
        let first = Library(directory: directory)
        let item = try XCTUnwrap(first.prompts.first)
        XCTAssertTrue(first.toggle(item))
        let reopened = Library(directory: directory)
        XCTAssertEqual(reopened.favorites.first, item)
        XCTAssertTrue(reopened.toggle(item))
        XCTAssertTrue(Library(directory: directory).favorites.isEmpty)
    }

    func testDraftSurvivesRelaunchAndCanRestoreOriginalWithoutChangingSource() throws {
        let first = Library(directory: directory)
        let item = try XCTUnwrap(first.prompts.first)
        let edited = "A personal draft with 中文 and emoji ✨\nSecond line."
        XCTAssertTrue(first.saveDraft(edited, for: item))
        let reopened = Library(directory: directory)
        XCTAssertEqual(reopened.draft(for: item), edited)
        XCTAssertEqual(reopened.prompts.first?.prompt, item.prompt)
        XCTAssertTrue(reopened.saveDraft(item.prompt, for: item))
        XCTAssertNil(Library(directory: directory).drafts[item.id])
    }

    func testFailedDraftWriteDoesNotReplaceLastSavedDraft() throws {
        let library = Library(directory: directory)
        let item = try XCTUnwrap(library.prompts.first)
        XCTAssertTrue(library.saveDraft("Keep this draft", for: item))
        let file = directory.appending(path: "drafts.json")
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: true)
        XCTAssertFalse(library.saveDraft("Cannot write this", for: item))
        XCTAssertEqual(library.draft(for: item), "Keep this draft")
        XCTAssertNotNil(library.error)
    }

    func testUnreadableDraftsAreNotOverwritten() throws {
        let library = Library(directory: directory)
        let item = try XCTUnwrap(library.prompts.first)
        let file = directory.appending(path: "drafts.json")
        let broken = Data("broken".utf8)
        try broken.write(to: file)
        let reopened = Library(directory: directory)
        XCTAssertFalse(reopened.saveDraft("New text", for: item))
        XCTAssertEqual(try Data(contentsOf: file), broken)
    }

    func testSavedThumbnailSurvivesCacheClearAndRelaunchThenIsRemovedWhenUnsaved() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ThumbnailProtocol.self]
        let url = URL(string: "https://api.prompix.dev/media/test.jpg")!
        let store = ImageStore(offlineDirectory: directory, session: URLSession(configuration: config))
        await store.keepOffline([url])
        XCTAssertTrue(store.offlineFailures.isEmpty)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 1)
        store.clear()
        let offline = URLSessionConfiguration.ephemeral
        offline.protocolClasses = [OfflineProtocol.self]
        let reopened = ImageStore(offlineDirectory: directory, session: URLSession(configuration: offline))
        let image = try await reopened.image(for: url)
        XCTAssertGreaterThan(image.size.width, 0)
        await reopened.keepOffline([])
        reopened.clear()
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
        do { _ = try await reopened.image(for: url); XCTFail("Unsaved thumbnail must no longer be retained") }
        catch { }
    }

    func testFullImageDoesNotReuseRetainedThumbnailOrDestroyItOnFailure() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ThumbnailProtocol.self]
        let url = URL(string: "https://api.prompix.dev/media/test-full.jpg")!
        let store = ImageStore(offlineDirectory: directory, session: URLSession(configuration: config))
        await store.keepOffline([url])
        let offline = URLSessionConfiguration.ephemeral
        offline.protocolClasses = [OfflineProtocol.self]
        let reopened = ImageStore(offlineDirectory: directory, session: URLSession(configuration: offline))
        _ = try await reopened.image(for: url)
        do { _ = try await reopened.image(for: url, fullResolution: true); XCTFail("Full-resolution requests must not silently return a retained thumbnail") }
        catch { }
        XCTAssertNotNil(reopened.offlineImage(for: url))
        let online = ImageStore(offlineDirectory: directory, session: URLSession(configuration: config))
        let full = try await online.image(for: url, fullResolution: true)
        XCTAssertGreaterThan(full.size.width, 0)
    }

    func testVideoFailureCanRecoverAndStopReleasesMedia() async throws {
        let playback = MoviePlayback()
        playback.start(url: nil)
        XCTAssertTrue(playback.failed)
        XCTAssertFalse(playback.loading)
        playback.start(url: directory.appending(path: "missing.mp4"))
        XCTAssertTrue(playback.failed, "Missing local media must fail without waiting for AVPlayer")
        let url = try XCTUnwrap(Bundle(for: LibraryTests.self).url(forResource: "playback-fixture", withExtension: "mp4"))
        playback.start(url: url)
        // Allow the real 25-second buffering deadline to settle on slower CI simulators.
        for _ in 0..<300 {
            if !playback.loading { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        let player = playback.player
        let diagnostic = "itemStatus=\(player?.currentItem?.status.rawValue ?? -1), " +
            "transportStatus=\(player?.timeControlStatus.rawValue ?? -1), " +
            "waiting=\(player?.reasonForWaitingToPlay?.rawValue ?? "none"), " +
            "itemError=\(String(describing: player?.currentItem?.error)), " +
            "playerError=\(String(describing: player?.error))"
        XCTAssertFalse(playback.failed, diagnostic)
        XCTAssertFalse(playback.loading, diagnostic)
        XCTAssertNotNil(player)
        playback.pause()
        XCTAssertEqual(playback.player?.rate, 0)
        playback.stop()
        XCTAssertNil(playback.player)
    }

    func testUnreadableVideoReachesRetryWithinBufferingDeadline() async throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appending(path: "invalid.mp4")
        try Data("This is not a video".utf8).write(to: url)
        let playback = MoviePlayback(bufferingTimeout: .milliseconds(200))
        playback.start(url: url)
        for _ in 0..<100 {
            if playback.failed { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertTrue(playback.failed, "Unreadable media must reach retry even when AVPlayer failure delivery is delayed")
        XCTAssertFalse(playback.loading)
        playback.stop()
        XCTAssertNil(playback.player)
    }

    func testNativePlayerPauseBeforeReadinessCancelsBufferingDeadline() async throws {
        let url = try XCTUnwrap(Bundle(for: LibraryTests.self).url(forResource: "playback-fixture", withExtension: "mp4"))
        let playback = MoviePlayback(bufferingTimeout: .milliseconds(200))
        defer { playback.stop() }
        playback.start(url: url)
        XCTAssertEqual(playback.player?.currentItem?.status, .unknown)
        // AVKit's native controls operate on AVPlayer, not MoviePlayback.pause().
        playback.player?.pause()
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertFalse(playback.loading)
        XCTAssertFalse(playback.failed)
        XCTAssertEqual(playback.player?.rate, 0)
    }

    func testRemoteVideoBufferingDeadlineAndSameURLRecovery() async throws {
        #if !targetEnvironment(simulator)
        throw XCTSkip("Network fixture acceptance is simulator-only.")
        #endif
        guard let address = ProcessInfo.processInfo.environment["PROMPIX_MEDIA_FIXTURE_URL"],
              let base = URL(string: address), base.scheme == "https" else {
            throw XCTSkip("Requires the isolated first-party HTTPS media fixture; never use a production server.")
        }
        func control(_ path: String) async throws {
            var request = URLRequest(url: base.appending(path: path))
            request.httpMethod = "POST"
            let (_, response) = try await URLSession.shared.data(for: request)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 204)
        }
        try await control("reset")
        let playback = MoviePlayback(bufferingTimeout: .seconds(8))
        defer { playback.stop() }
        let url = base.appending(path: "stall.mp4").appending(queryItems: [URLQueryItem(name: "run", value: UUID().uuidString)])
        playback.start(url: url)
        var observations: [String] = []
        for step in 0..<130 {
            let item = playback.player?.currentItem
            let transport = playback.player?.timeControlStatus
            observations.append("\(step): item=\(item?.status.rawValue ?? -1) transport=\(transport?.rawValue ?? -1) loading=\(playback.loading) failed=\(playback.failed) time=\(playback.player?.currentTime().seconds ?? -1)")
            if item?.status == .readyToPlay, transport == .waitingToPlayAtSpecifiedRate {
                XCTAssertTrue(playback.loading, "Item readiness must not hide a pending transport buffer.")
            }
            if playback.failed { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        let trace = XCTAttachment(string: observations.joined(separator: "\n"))
        trace.name = "real-avplayer-buffering-trace"; trace.lifetime = .keepAlways; add(trace)
        XCTAssertTrue(playback.failed, "A stalled remote player must offer retry within its deadline.")
        XCTAssertFalse(playback.loading)
        try await control("recover")
        playback.start(url: url)
        for _ in 0..<150 {
            if (playback.player?.currentTime().seconds ?? 0) > 0.5 { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertFalse(playback.failed)
        XCTAssertFalse(playback.loading)
        XCTAssertGreaterThan(playback.player?.currentTime().seconds ?? 0, 0.5, "Recovery requires advancing AVPlayer time, not a retained hasPlayed flag.")
        playback.pause()
        let paused = playback.player?.currentTime().seconds ?? 0
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(playback.player?.currentTime().seconds ?? 0, paused, accuracy: 0.05)
        playback.stop()
        XCTAssertNil(playback.player)
    }

    func testRemoteVideoInterruptionPauseAndSameURLRecovery() async throws {
        #if !targetEnvironment(simulator)
        throw XCTSkip("Network fixture acceptance is simulator-only.")
        #endif
        guard let address = ProcessInfo.processInfo.environment["PROMPIX_INTERRUPTED_MEDIA_FIXTURE_URL"],
              let base = URL(string: address), base.scheme == "https" else {
            throw XCTSkip("Requires the isolated first-party MP4 interruption fixture; never use a production server.")
        }
        func control(_ path: String) async throws {
            // Keep fixture control independent of AVFoundation's stalled media connections.
            let session = URLSession(configuration: .ephemeral)
            defer { session.invalidateAndCancel() }
            var request = URLRequest(url: base.appending(path: path))
            request.httpMethod = "POST"
            request.httpBody = Data()
            request.timeoutInterval = 10
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode
            let expected = Data((path == "reset" ? "stalling" : "ready").utf8)
            XCTAssertEqual(status, 200)
            XCTAssertEqual(data, expected)
            guard status == 200, data == expected else { throw URLError(.badServerResponse) }
        }
        let playback = MoviePlayback(bufferingTimeout: .seconds(8))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive })
        let previousWindow = scene.keyWindow
        let videoController = AVPlayerViewController()
        let videoWindow = UIWindow(windowScene: scene)
        videoWindow.rootViewController = videoController
        videoWindow.makeKeyAndVisible()
        var output: AVPlayerItemVideoOutput?
        var decodedTime: Double = -1
        var decodedFrames = 0
        func attachRenderer() throws {
            let item = try XCTUnwrap(playback.player?.currentItem)
            let next = AVPlayerItemVideoOutput(pixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
            next.suppressesPlayerRendering = false
            item.add(next)
            output = next; decodedTime = -1; decodedFrames = 0
            videoController.player = playback.player
        }
        func sampleFrame() {
            guard let output, let time = playback.player?.currentTime(), output.hasNewPixelBuffer(forItemTime: time) else { return }
            var displayed = CMTime.invalid
            guard output.copyPixelBuffer(forItemTime: time, itemTimeForDisplay: &displayed) != nil,
                  displayed.seconds.isFinite, displayed.seconds > decodedTime else { return }
            decodedTime = displayed.seconds; decodedFrames += 1
        }
        var observations: [String] = []
        func record(_ stage: String) {
            let player = playback.player
            observations.append("\(stage): item=\(player?.currentItem?.status.rawValue ?? -1) transport=\(player?.timeControlStatus.rawValue ?? -1) loading=\(playback.loading) failed=\(playback.failed) time=\(player?.currentTime().seconds ?? -1) frameTime=\(decodedTime) frames=\(decodedFrames) readyForDisplay=\(videoController.isReadyForDisplay) itemError=\(String(describing: player?.currentItem?.error))")
            observations.append("buffer: empty=\(player?.currentItem?.isPlaybackBufferEmpty ?? false) likelyToKeepUp=\(player?.currentItem?.isPlaybackLikelyToKeepUp ?? false) ranges=\(player?.currentItem?.loadedTimeRanges.map { $0.timeRangeValue.duration.seconds } ?? [])")
        }
        func waitUntil(_ stage: String, seconds: Int, _ condition: () -> Bool) async throws -> Bool {
            for step in 0..<(seconds * 10) {
                sampleFrame()
                if step % 10 == 0 { record(stage) }
                if condition() { record("\(stage)-observed"); return true }
                try await Task.sleep(for: .milliseconds(100))
            }
            record("\(stage)-deadline")
            return condition()
        }
        defer {
            let trace = XCTAttachment(string: observations.joined(separator: "\n"))
            trace.name = "real-avplayer-interruption-trace"; trace.lifetime = .keepAlways; add(trace)
            playback.stop()
            videoController.player = nil
            videoWindow.isHidden = true
            previousWindow?.makeKey()
        }
        try await control("reset")
        let url = base.appending(path: "stall.mp4").appending(queryItems: [URLQueryItem(name: "run", value: UUID().uuidString)])
        playback.start(url: url)
        try attachRenderer()
        let started = try await waitUntil("initial-playback", seconds: 15) {
            videoController.isReadyForDisplay && decodedFrames >= 2 && decodedTime > 0.5
        }
        XCTAssertTrue(started, "The fixture must play before interruption; a startup timeout is not this scenario.")
        guard started else { return }
        let interrupted = try await waitUntil("interruption", seconds: 30) {
            playback.loading && playback.player?.timeControlStatus == .waitingToPlayAtSpecifiedRate
        }
        XCTAssertTrue(interrupted)
        guard interrupted else { return }
        let stalledTime = playback.player?.currentTime().seconds ?? 0
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(playback.player?.currentTime().seconds ?? 0, stalledTime, accuracy: 0.15)

        // Native AVKit controls pause the player directly, including during a stall.
        playback.player?.pause()
        try await Task.sleep(for: .seconds(9))
        record("paused-past-buffering-deadline")
        XCTAssertFalse(playback.failed)
        XCTAssertFalse(playback.loading)
        XCTAssertEqual(playback.player?.currentTime().seconds ?? 0, stalledTime, accuracy: 0.15)
        let resumedAt = ContinuousClock.now
        playback.player?.play()
        let waitingAgain = try await waitUntil("resumed-waiting", seconds: 2) {
            playback.loading && playback.player?.timeControlStatus == .waitingToPlayAtSpecifiedRate
        }
        XCTAssertTrue(waitingAgain)
        let timedOut = try await waitUntil("resumed-stall", seconds: 12) { playback.failed }
        XCTAssertTrue(timedOut, "Resuming a stalled stream must rearm the buffering deadline.")
        let elapsed = resumedAt.duration(to: .now)
        observations.append("resumed-deadline-elapsed=\(elapsed)")
        XCTAssertGreaterThanOrEqual(elapsed, .seconds(7))
        XCTAssertLessThan(elapsed, .seconds(12))
        XCTAssertEqual(playback.player?.currentItem?.status, .readyToPlay)
        XCTAssertNil(playback.player?.currentItem?.error, "A transport error must not masquerade as the app's buffering deadline.")
        XCTAssertFalse(playback.loading)

        try await control("recover")
        playback.start(url: url)
        try attachRenderer()
        // The fast-start MP4 fixture withholds samples from twenty seconds onwards.
        let recoveryTarget = max(20.6, stalledTime + 0.5)
        let recovered = try await waitUntil("same-url-retry", seconds: 30) {
            videoController.isReadyForDisplay && decodedTime > recoveryTarget
        }
        XCTAssertTrue(recovered, "Retry must play beyond the withheld samples, not just replay the available opening.")
        XCTAssertFalse(playback.failed)
        XCTAssertFalse(playback.loading)
        playback.stop()
        XCTAssertNil(playback.player)
    }

    func testInvalidCatalogDoesNotDestroyOfflineFavorites() throws {
        let first = Library(directory: directory)
        let item = try XCTUnwrap(first.prompts.first)
        XCTAssertTrue(first.toggle(item))
        let invalid = directory.appending(path: "invalid.json")
        try Data("{}".utf8).write(to: invalid)
        let failed = Library(directory: directory, catalogURL: invalid)
        XCTAssertNotNil(failed.error)
        XCTAssertEqual(failed.favorites.first?.prompt, item.prompt)
    }

    func testBundledFallbackAndSearchIntersection() throws {
        let library = Library(directory: directory)
        XCTAssertEqual(library.version, "studio-005")
        XCTAssertEqual(library.prompts.count, 30)
        XCTAssertEqual(Set(library.prompts.map(\.kind)), Set([PromptKind.text, .image, .web]))
        for kind in [PromptKind.text, .image, .web] { XCTAssertGreaterThanOrEqual(library.prompts.filter { $0.kind == kind }.count, 6) }
        let query = PromptQuery(text: "塔罗", kind: .text)
        XCTAssertEqual(library.prompts.filter(query.matches).map(\.id), ["gentle-tarot"])
        XCTAssertTrue(library.prompts.filter(PromptQuery(text: "塔罗", kind: .web).matches).isEmpty)
        XCTAssertTrue(library.prompts.filter(PromptQuery(text: "  ").matches).count == library.prompts.count)
    }

    func testUnknownSchemaAndDuplicateIDsAreRejected() throws {
        let item = try XCTUnwrap(Library(directory: directory).prompts.first)
        XCTAssertThrowsError(try Catalog(schemaVersion: 2, version: "test", prompts: [item]).validated())
        XCTAssertThrowsError(try Catalog(schemaVersion: 1, version: "test", prompts: [item,item]).validated())
    }

    func testCorruptFavoritesAreNotSilentlyOverwrittenAtLaunch() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appending(path: "favorites.json")
        let bytes = Data("broken".utf8)
        try bytes.write(to: url)
        let library = Library(directory: directory)
        XCTAssertNotNil(library.error)
        XCTAssertEqual(try Data(contentsOf: url), bytes)
    }

    func testUnreadableFavoritesSurviveEditsUpdatesAndRecoveryAppliesRemovals() throws {
        let initial = Library(directory: directory)
        let removed = try XCTUnwrap(initial.prompts.first)
        let kept = try XCTUnwrap(initial.prompts.last)
        let file = directory.appending(path: "favorites.json")
        let broken = Data("unreadable favorites".utf8)
        try broken.write(to: file)
        let library = Library(directory: directory)
        XCTAssertFalse(library.toggle(kept))
        XCTAssertNil(library.savedImageURLs, "Unreadable favorites must not trigger thumbnail deletion")
        var catalog = Catalog(schemaVersion: 1, version: "recovery-test", prompts: initial.prompts.filter { $0.id != removed.id })
        catalog.removedIDs = [removed.id]
        let bytes = try JSONEncoder().encode(catalog)
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let manifest = CatalogManifest(schemaVersion: 1, version: catalog.version, sha256: digest, catalog: URL(string: "https://api.prompix.dev/releases/recovery-test/catalog.json")!)
        try library.install(bytes, manifest: manifest)
        XCTAssertEqual(try Data(contentsOf: file), broken)
        let reopened = Library(directory: directory)
        XCTAssertEqual(try Data(contentsOf: file), broken)
        XCTAssertFalse(reopened.favoritesReadable)
        reopened.reloadFavorites()
        XCTAssertFalse(reopened.favoritesReadable)
        try JSONEncoder().encode([removed, kept]).write(to: file, options: .atomic)
        reopened.reloadFavorites()
        XCTAssertTrue(reopened.favoritesReadable)
        XCTAssertEqual(reopened.favorites, [kept])
        XCTAssertEqual(try JSONDecoder().decode([Prompt].self, from: Data(contentsOf: file)), [kept])
    }

    func testCreativeTopicIncludesVisualPromptsWithoutGenericTagsAndRelatedUsesSpecificTags() throws {
        let library = Library(directory: directory)
        let original = try XCTUnwrap(library.prompts.first { $0.kind == .image })
        let image = Prompt(id: "edited-image", kind: .image, title: original.title, summary: original.summary,
            prompt: original.prompt, example: original.example, tags: ["微缩世界"], model: original.model,
            toolURL: original.toolURL, artwork: original.artwork, previewLabel: original.previewLabel,
            source: original.source, media: original.media)
        XCTAssertTrue(PromptQuery(topic: "创作灵感").matches(image))
        XCTAssertFalse(PromptQuery(kind: .text, topic: "创作灵感").matches(image))
        XCTAssertFalse(PromptQuery(topic: "日常有用").matches(image))
        let tarot = try XCTUnwrap(library.prompts.first { $0.id == "gentle-tarot" })
        let related = RelatedPrompts.select(for: tarot, from: library.prompts)
        XCTAssertEqual(related.count, 4)
        XCTAssertFalse(related.contains { $0.id == tarot.id })
        XCTAssertTrue(try XCTUnwrap(related.first).tags.contains("自我探索"))
        XCTAssertEqual(related, RelatedPrompts.select(for: tarot, from: library.prompts))
        XCTAssertTrue(RelatedPrompts.select(for: tarot, from: library.prompts, limit: 0).isEmpty)
    }

    func testPublicSupportRoutesRespectLanguageAndOnlyIncludeContentIdentity() throws {
        XCTAssertEqual(SupportLinks.url(.privacy, language: "en").absoluteString, "https://prompix.dev/privacy")
        XCTAssertEqual(SupportLinks.url(.support, language: "zh-Hans").absoluteString, "https://prompix.dev/zh/support")
        let report = SupportLinks.url(.report, contentID: "gentle-tarot", language: "en")
        XCTAssertEqual(report.absoluteString, "https://prompix.dev/report?id=gentle-tarot")
        XCTAssertNil(URLComponents(url: SupportLinks.url(.home, contentID: "ignored", language: "en"), resolvingAgainstBaseURL: false)?.query)
    }

    func testBundledMediaExist() throws {
        let library = Library(directory: directory)
        for item in library.prompts {
            XCTAssertNil(item.media?.video, "Procedural playback fixtures must not ship as prompt examples")
            if let image = item.media?.image { XCTAssertNotNil(UIImage(named: image), image) }
        }
        XCTAssertNotNil(Bundle(for: LibraryTests.self).url(forResource: "playback-fixture", withExtension: "mp4"))
        XCTAssertNil(Bundle.main.url(forResource: "playback-fixture", withExtension: "mp4"))
        XCTAssertTrue((Bundle.main.urls(forResourcesWithExtension: "mp4", subdirectory: nil) ?? []).isEmpty)
        for (id, filename) in WebsiteExamples.files {
            XCTAssertNotNil(Bundle.main.url(forResource: filename, withExtension: "html", subdirectory: "WebExamples"), filename)
            XCTAssertNotNil(UIImage(named: "web-\(id)"), id)
        }
    }
    func testCachedVideoEditionAndSavedSnapshotSurviveFallbackRetirement() throws {
        let library = Library(directory: directory)
        let original = try XCTUnwrap(library.prompts.first)
        let video = Prompt(id: "saved-video", kind: .video, title: "Video example", summary: original.summary,
            prompt: original.prompt, example: original.example, tags: original.tags, model: "Video model",
            toolURL: original.toolURL, artwork: "video-editorial", previewLabel: "Reviewed video",
            source: original.source, media: Prompt.Media(image: nil, video: nil, demoURL: nil,
                imageURL: URL(string: "https://api.prompix.dev/media/test-cover.jpg"),
                videoURL: URL(string: "https://api.prompix.dev/media/test-video.mp4")))
        let catalog = Catalog(schemaVersion: 1, version: "edition-cached-video", prompts: [video])
        let data = try JSONEncoder().encode(catalog)
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let manifest = CatalogManifest(schemaVersion: 1, version: catalog.version, sha256: digest,
            catalog: URL(string: "https://api.prompix.dev/releases/edition-cached-video/catalog.json")!)
        try library.install(data, manifest: manifest)
        XCTAssertTrue(library.toggle(video))
        XCTAssertTrue(library.saveDraft("Keep my video draft", for: video))
        let cached = Library(directory: directory)
        XCTAssertEqual(cached.version, catalog.version)
        XCTAssertEqual(cached.prompts, [video])
        XCTAssertEqual(cached.favorites, [video])
        XCTAssertEqual(cached.draft(for: video), "Keep my video draft")

        // A missing edition cache may restore the bundle, but must not delete saved snapshots.
        try FileManager.default.removeItem(at: directory.appending(path: "catalog.json"))
        let fallback = Library(directory: directory)
        XCTAssertEqual(fallback.version, "studio-005")
        XCTAssertFalse(fallback.prompts.contains { $0.kind == .video })
        XCTAssertEqual(fallback.favorites, [video])
        XCTAssertEqual(fallback.draft(for: video), "Keep my video draft")
    }
    func testRemoteEditionIsAtomicCachedAndRemovalsReachFavorites() throws {
        let library = Library(directory: directory)
        let bundledVersion = library.version
        let saved = try XCTUnwrap(library.prompts.first)
        library.toggle(saved)
        library.saveDraft("Remove this draft with its source", for: saved)
        let remaining = library.prompts.filter { $0.id != saved.id }
        var catalog = Catalog(schemaVersion: 1, version: "remote-test", prompts: remaining)
        catalog.removedIDs = [saved.id]
        catalog.publishedAt = "2026-10-11T09:52:20.729Z"
        let data = try JSONEncoder().encode(catalog)
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let manifest = CatalogManifest(schemaVersion: 1, version: "remote-test", sha256: digest, catalog: URL(string: "https://api.prompix.dev/releases/remote-test/catalog.json")!)
        XCTAssertThrowsError(try library.install(Data("broken".utf8), manifest: manifest))
        XCTAssertEqual(library.version, bundledVersion)
        XCTAssertTrue(library.isSaved(saved))
        try library.install(data, manifest: manifest)
        XCTAssertEqual(library.version, "remote-test")
        XCTAssertFalse(library.isSaved(saved))
        XCTAssertNotNil(library.updatedAt)
        let reopened = Library(directory: directory)
        XCTAssertEqual(reopened.version, "remote-test")
        XCTAssertEqual(reopened.prompts.count, remaining.count)
        XCTAssertFalse(reopened.isSaved(saved))
        XCTAssertNil(reopened.drafts[saved.id])
    }
    func testRemoteManifestCannotRedirectCatalogToUntrustedHost() throws {
        let manifest = CatalogManifest(schemaVersion: 1, version: "test", sha256: String(repeating: "a", count: 64), catalog: URL(string: "https://example.com/releases/test/catalog.json")!)
        XCTAssertThrowsError(try manifest.validated())
    }

    func testOfflineRefreshPreservesSavedDataAndForcedRetryInstallsNewEdition() async throws {
        try await assertRefreshPreservesSavedDataAndRecovers(failure: "offline")
    }

    func testTimedOutCatalogRefreshPreservesSavedDataAndForcedRetryInstallsNewEdition() async throws {
        try await assertRefreshPreservesSavedDataAndRecovers(failure: "timeout")
    }

    func testDamagedCatalogRefreshPreservesSavedDataAndForcedRetryInstallsNewEdition() async throws {
        try await assertRefreshPreservesSavedDataAndRecovers(failure: "damaged-catalog")
    }

    func testCreatorless68ItemCacheUpdatesTo345ItemsWithoutLosingPersonalData() async throws {
        let fixture = try JSONDecoder().decode(Catalog.self, from: CatalogRefreshProtocol.catalogData)
        let legacyItems = (0..<68).map { index in
            let source = fixture.prompts[0]
            return Prompt(id: "legacy-\(index)", kind: source.kind, title: source.title, summary: source.summary,
                          prompt: source.prompt, example: source.example, tags: source.tags, model: source.model,
                          toolURL: nil, artwork: source.artwork, previewLabel: source.previewLabel, source: source.source, media: nil)
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let legacy = Catalog(schemaVersion: 1, version: "legacy-68", prompts: legacyItems)
        try JSONEncoder().encode(legacy).write(to: directory.appending(path: "catalog.json"))
        let library = Library(directory: directory)
        XCTAssertEqual(library.prompts.count, 68)
        XCTAssertTrue(CreatorDirectory.entries(in: library.prompts).isEmpty)
        XCTAssertTrue(library.toggle(legacyItems[0]))
        XCTAssertTrue(library.saveDraft("Keep this personal draft", for: legacyItems[0]))
        let session = refreshSession(response: "expanded")
        defer { session.invalidateAndCancel() }

        await library.refresh(session: session)

        XCTAssertEqual(library.syncState, .current)
        XCTAssertEqual(library.prompts.count, 345)
        XCTAssertEqual(CreatorDirectory.entries(in: library.prompts).count, 1)
        XCTAssertEqual(CreatorDirectory.entries(in: library.prompts).first?.count, 345)
        XCTAssertEqual(library.favorites, [legacyItems[0]])
        XCTAssertEqual(library.draft(for: legacyItems[0]), "Keep this personal draft")
        XCTAssertEqual(Library(directory: directory).prompts.count, 345)
    }

    func testFailedAutomaticRefreshRetriesAfterThirtySecondsWithoutWaitingFifteenMinutes() async throws {
        var now = Date(timeIntervalSince1970: 1_000)
        let library = Library(directory: directory)
        let offline = refreshSession(response: "offline")
        let recovery = refreshSession(response: "success")
        defer { offline.invalidateAndCancel(); recovery.invalidateAndCancel() }
        await library.refresh(session: offline, now: now)
        XCTAssertEqual(library.syncState, .failed)
        now = now.addingTimeInterval(29)
        await library.refresh(session: recovery, now: now)
        XCTAssertEqual(library.syncState, .failed, "Repeated foreground events must not retry continuously")
        now = now.addingTimeInterval(1)
        await library.refresh(session: recovery, now: now)
        XCTAssertEqual(library.syncState, .current)
        XCTAssertEqual(library.version, "edition-after-refresh")
        now = now.addingTimeInterval(30)
        await library.refresh(session: offline, now: now)
        XCTAssertEqual(library.syncState, .current, "Successful automatic checks retain the 15-minute interval")
    }

    func testInterruptedCatalogDownloadExposesStateAndCanImmediatelyResume() async throws {
        let library = Library(directory: directory)
        let original = library.prompts
        let slow = refreshSession(response: "suspended-catalog")
        let recovery = refreshSession(response: "success")
        defer { slow.invalidateAndCancel(); recovery.invalidateAndCancel() }
        let refresh = Task { await library.refresh(session: slow) }
        for _ in 0..<100 {
            if case .downloading = library.syncState { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        guard case let .downloading(received, total) = library.syncState else {
            refresh.cancel(); await refresh.value
            return XCTFail("The old cache must be accompanied by an observable download state")
        }
        XCTAssertEqual(received, 0)
        XCTAssertNil(total, "The complete requested download size is known only after base verification")
        XCTAssertNil(library.syncState.fractionCompleted)
        XCTAssertTrue(library.isRefreshing)
        XCTAssertEqual(library.prompts, original)
        refresh.cancel()
        await refresh.value
        XCTAssertEqual(library.syncState, .idle)
        XCTAssertFalse(library.isRefreshing)
        XCTAssertNil(library.syncMessage)
        XCTAssertEqual(library.prompts, original)
        await library.refresh(session: recovery)
        XCTAssertEqual(library.syncState, .current)
        XCTAssertEqual(library.version, "edition-after-refresh")
    }

    func testChunkedCatalogTransportReportsBoundedProgressAndPreservesEveryByte() async throws {
        let session = transportSession(response: "chunks")
        defer { session.invalidateAndCancel() }
        let samples = DownloadProgressSamples()
        let expected = Data(repeating: 42, count: 262_144)
        let bytes = try await CatalogSync.fetch(CatalogSync.endpoint, maximum: expected.count, session: session) { samples.append($0) }
        XCTAssertEqual(bytes, expected)
        XCTAssertEqual(samples.values.first, CatalogDownloadProgress(receivedBytes: 0, totalBytes: expected.count))
        XCTAssertEqual(samples.values.last, CatalogDownloadProgress(receivedBytes: expected.count, totalBytes: expected.count))
        XCTAssertEqual(samples.values.map(\.receivedBytes), samples.values.map(\.receivedBytes).sorted())
        XCTAssertLessThan(samples.values.count, 20, "Progress must be coalesced instead of emitted for every byte")
    }

    func testCatalogTransportRejectsOversizeHeadersUnknownLengthsAndDishonestLengths() async throws {
        for mode in ["oversize-header", "unknown-length", "dishonest-length"] {
            let session = transportSession(response: mode)
            defer { session.invalidateAndCancel() }
            let samples = DownloadProgressSamples()
            do {
                _ = try await CatalogSync.fetch(CatalogSync.endpoint, maximum: 1_000, session: session) { samples.append($0) }
                XCTFail("The byte cap must reject \(mode)")
            } catch SyncError.tooLarge { }
            catch { XCTFail("Unexpected error for \(mode): \(error)") }
            XCTAssertTrue(samples.values.allSatisfy { $0.receivedBytes <= 1_000 })
        }
    }

    func testCompressedCatalogProgressDoesNotUseCompressedLengthForDecodedBytes() async throws {
        let session = transportSession(response: "compressed")
        defer { session.invalidateAndCancel() }
        let samples = DownloadProgressSamples()
        let bytes = try await CatalogSync.fetch(CatalogSync.endpoint, maximum: 2_048, session: session) { samples.append($0) }
        XCTAssertEqual(bytes.count, 2_048)
        XCTAssertEqual(samples.values.first, CatalogDownloadProgress(receivedBytes: 0, totalBytes: nil))
        XCTAssertTrue(samples.values.dropLast().allSatisfy { $0.totalBytes == nil })
        XCTAssertEqual(samples.values.last, CatalogDownloadProgress(receivedBytes: 2_048, totalBytes: 2_048))
    }

    func testCatalogTransportRejectsUntrustedResponseAndHTTPFailure() async throws {
        for mode in ["untrusted-response", "http-failure"] {
            let session = transportSession(response: mode)
            defer { session.invalidateAndCancel() }
            do {
                _ = try await CatalogSync.fetch(CatalogSync.endpoint, maximum: 1_000, session: session)
                XCTFail("The response must reject \(mode)")
            } catch SyncError.invalidResponse { }
            catch { XCTFail("Unexpected error for \(mode): \(error)") }
        }
    }

    private func assertRefreshPreservesSavedDataAndRecovers(failure: String) async throws {
        let library = Library(directory: directory)
        let favorite = try XCTUnwrap(library.prompts.first)
        let edited = try XCTUnwrap(library.prompts.last)
        let draft = "Keep my personal draft: 中文 ✨\nSecond line."
        var initial = Catalog(schemaVersion: 1, version: "edition-before-refresh", prompts: library.prompts)
        initial.publishedAt = "2026-10-10T10:00:00Z"
        let initialBytes = try JSONEncoder().encode(initial)
        let initialDigest = SHA256.hash(data: initialBytes).map { String(format: "%02x", $0) }.joined()
        try library.install(initialBytes, manifest: CatalogManifest(schemaVersion: 1, version: initial.version,
            sha256: initialDigest, catalog: URL(string: "https://api.prompix.dev/releases/\(initial.version)/catalog.json")!))
        XCTAssertTrue(library.toggle(favorite))
        XCTAssertTrue(library.saveDraft(draft, for: edited))
        let originalDate = library.updatedAt
        let files = ["catalog.json", "favorites.json", "drafts.json"]
        let originalFiles = try files.map { try Data(contentsOf: directory.appending(path: $0)) }

        let failingSession = refreshSession(response: failure)
        defer { failingSession.invalidateAndCancel() }
        await library.refresh(force: true, session: failingSession)

        XCTAssertFalse(library.isRefreshing)
        XCTAssertEqual(library.syncState, .failed)
        XCTAssertNotNil(library.syncMessage)
        XCTAssertNil(library.error)
        XCTAssertEqual(library.version, initial.version)
        XCTAssertEqual(library.prompts, initial.prompts)
        XCTAssertEqual(library.updatedAt, originalDate)
        XCTAssertEqual(library.favorites, [favorite])
        XCTAssertEqual(library.draft(for: edited), draft)
        XCTAssertEqual(try files.map { try Data(contentsOf: directory.appending(path: $0)) }, originalFiles)
        let afterFailure = Library(directory: directory)
        XCTAssertEqual(afterFailure.version, initial.version)
        XCTAssertEqual(afterFailure.prompts, initial.prompts)
        XCTAssertEqual(afterFailure.favorites, [favorite])
        XCTAssertEqual(afterFailure.draft(for: edited), draft)

        // Retry immediately to exercise the explicit action's bypass of the refresh throttle.
        let recoverySession = refreshSession(response: "success")
        defer { recoverySession.invalidateAndCancel() }
        await library.refresh(force: true, session: recoverySession)

        let expected = try JSONDecoder().decode(Catalog.self, from: CatalogRefreshProtocol.catalogData).validated()
        XCTAssertFalse(library.isRefreshing)
        XCTAssertEqual(library.syncState, .current)
        XCTAssertNil(library.syncMessage)
        XCTAssertNil(library.error)
        XCTAssertEqual(library.version, expected.version)
        XCTAssertEqual(library.prompts, expected.prompts)
        XCTAssertEqual(library.updatedAt, ISO8601DateFormatter().date(from: expected.publishedAt!))
        XCTAssertEqual(library.favorites, [favorite], "A new edition must preserve unrelated saved snapshots")
        XCTAssertEqual(library.draft(for: edited), draft)
        let storedCatalog = try JSONDecoder().decode(Catalog.self, from: Data(contentsOf: directory.appending(path: "catalog.json")))
        XCTAssertEqual(storedCatalog.prompts, expected.prompts)
        XCTAssertEqual(storedCatalog.version, expected.version)
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appending(path: LanguagePackCache.indexFileName).path))
        let reopened = Library(directory: directory)
        XCTAssertEqual(reopened.version, expected.version)
        XCTAssertEqual(reopened.prompts, expected.prompts)
        XCTAssertEqual(reopened.favorites, [favorite])
        XCTAssertEqual(reopened.draft(for: edited), draft)
    }

    private func refreshSession(response: String) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CatalogRefreshProtocol.self]
        // Per-session configuration keeps concurrent tests independent, without a shared handler.
        configuration.httpAdditionalHeaders = ["X-Prompix-Test-Response": response]
        return URLSession(configuration: configuration)
    }

    private func transportSession(response: String) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CatalogTransportProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Prompix-Test-Response": response]
        return URLSession(configuration: configuration)
    }
}

private final class CatalogRefreshProtocol: URLProtocol, @unchecked Sendable {
    static let catalogData = Data("""
        {"schemaVersion":1,"version":"edition-after-refresh","publishedAt":"2026-10-11T10:00:00Z","prompts":[
          {"id":"refresh-fixture","kind":"text","title":"Fresh inspiration","summary":"An original transport test fixture.",
           "prompt":"Describe a calm morning in two sentences.","example":"Sunlight crosses the room. The kettle begins to sing.",
           "tags":["Test"],"model":"Text model","artwork":"text","previewLabel":"Original example",
           "source":{"name":"Prompix tests","license":"Original test fixture","method":"original"},
           "creator":{"id":"test-creator","platform":"web","displayName":"Fixture Author","profileURL":"https://example.com/author"}}
        ]}
        """.utf8)
    static let expandedCatalogData: Data = {
        var catalog = try! JSONSerialization.jsonObject(with: catalogData) as! [String: Any]
        let prototype = (catalog["prompts"] as! [[String: Any]])[0]
        catalog["prompts"] = (0..<345).map { index in
            var item = prototype
            item["id"] = "expanded-\(index)"
            return item
        }
        return try! JSONSerialization.data(withJSONObject: catalog)
    }()

    static func baseData(expanded: Bool) -> Data {
        var catalog = try! JSONSerialization.jsonObject(with: expanded ? expandedCatalogData : catalogData) as! [String: Any]
        catalog["schemaVersion"] = 2
        catalog["prompts"] = (catalog["prompts"] as! [[String: Any]]).map { value in
            var item = value
            item["toolURL"] = NSNull(); item["media"] = NSNull()
            var source = item["source"] as! [String: Any]; source["url"] = NSNull(); item["source"] = source
            return item
        }
        return try! JSONSerialization.data(withJSONObject: catalog, options: [.sortedKeys])
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url, url.host == "api.prompix.dev" else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        let mode = request.value(forHTTPHeaderField: "X-Prompix-Test-Response")
        let catalog = Self.baseData(expanded: mode == "expanded")
        if mode == "offline" {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let bytes: Data
        if url.path == "/v2/latest.json" {
            let digest = SHA256.hash(data: catalog).map { String(format: "%02x", $0) }.joined()
            bytes = Data("""
                {"schemaVersion":2,"version":"edition-after-refresh","publishedAt":"2026-10-11T10:00:00Z", "count":\(mode == "expanded" ? 345 : 1),
                 "base":{"url":"https://api.prompix.dev/releases/edition-after-refresh/v2/base.json", "sha256":"\(digest)","byteCount":\(catalog.count),"count":\(mode == "expanded" ? 345 : 1)},"locales":{}}
                """.utf8)
        } else if url.path == "/releases/edition-after-refresh/v2/base.json" {
            if mode == "timeout" {
                // A deterministic transport error, not a measurement of the real 25-second deadline.
                client?.urlProtocol(self, didFailWithError: URLError(.timedOut))
                return
            }
            // Still valid JSON, but different bytes must fail the manifest's integrity check.
            bytes = mode == "damaged-catalog" ? catalog + Data("\n".utf8) : catalog
        } else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "application/json", "Content-Length": String(bytes.count)])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if mode == "suspended-catalog", url.path != "/v2/latest.json" { return }
        client?.urlProtocol(self, didLoad: bytes)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class DownloadProgressSamples: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [CatalogDownloadProgress] = []
    var values: [CatalogDownloadProgress] { lock.withLock { storage } }
    func append(_ value: CatalogDownloadProgress) { lock.withLock { storage.append(value) } }
}

private final class CatalogTransportProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let mode = request.value(forHTTPHeaderField: "X-Prompix-Test-Response")
        let url = mode == "untrusted-response" ? URL(string: "https://example.com/catalog.json")! : request.url!
        let length: String? = mode == "chunks" ? "262144" : mode == "oversize-header" ? "1001" : ["dishonest-length", "compressed"].contains(mode) ? "8" : nil
        var headers = length.map { ["Content-Length": $0] } ?? [:]
        if mode == "compressed" { headers["Content-Encoding"] = "gzip" }
        let response = HTTPURLResponse(url: url, statusCode: mode == "http-failure" ? 503 : 200, httpVersion: nil,
                                       headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let size = mode == "chunks" ? 262_144 : 2_048
        for _ in 0..<(size / 512) { client?.urlProtocol(self, didLoad: Data(repeating: 42, count: 512)) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class ThumbnailProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let bytes = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGNILAjAihiGlgQAP6xIQWSZPVUAAAAASUVORK5CYII=")!
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: bytes)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
private final class OfflineProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)) }
    override func stopLoading() {}
}
