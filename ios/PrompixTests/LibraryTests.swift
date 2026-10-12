import XCTest
import CryptoKit
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
        XCTAssertEqual(covers.count, 3)
        XCTAssertEqual(Set(covers.map(\.id)).count, 3)
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
        XCTAssertFalse(playback.failed)
        XCTAssertFalse(playback.loading)
        XCTAssertNotNil(playback.player)
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
        XCTAssertNil(library.syncMessage)
        XCTAssertNil(library.error)
        XCTAssertEqual(library.version, expected.version)
        XCTAssertEqual(library.prompts, expected.prompts)
        XCTAssertEqual(library.updatedAt, ISO8601DateFormatter().date(from: expected.publishedAt!))
        XCTAssertEqual(library.favorites, [favorite], "A new edition must preserve unrelated saved snapshots")
        XCTAssertEqual(library.draft(for: edited), draft)
        XCTAssertEqual(try Data(contentsOf: directory.appending(path: "catalog.json")), CatalogRefreshProtocol.catalogData)
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
}

private final class CatalogRefreshProtocol: URLProtocol, @unchecked Sendable {
    static let catalogData = Data("""
        {"schemaVersion":1,"version":"edition-after-refresh","publishedAt":"2026-10-11T10:00:00Z","prompts":[
          {"id":"refresh-fixture","kind":"text","title":"Fresh inspiration","summary":"An original transport test fixture.",
           "prompt":"Describe a calm morning in two sentences.","example":"Sunlight crosses the room. The kettle begins to sing.",
           "tags":["Test"],"model":"Text model","artwork":"text","previewLabel":"Original example",
           "source":{"name":"Prompix tests","license":"Original test fixture","method":"original"}}
        ]}
        """.utf8)

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url, url.host == "api.prompix.dev" else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        let mode = request.value(forHTTPHeaderField: "X-Prompix-Test-Response")
        if mode == "offline" {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let bytes: Data
        if url.path == "/v1/latest.json" {
            let digest = SHA256.hash(data: Self.catalogData).map { String(format: "%02x", $0) }.joined()
            bytes = Data("""
                {"schemaVersion":1,"version":"edition-after-refresh","sha256":"\(digest)",
                 "catalog":"https://api.prompix.dev/releases/edition-after-refresh/catalog.json"}
                """.utf8)
        } else if url.path == "/releases/edition-after-refresh/catalog.json" {
            if mode == "timeout" {
                // A deterministic transport error, not a measurement of the real 25-second deadline.
                client?.urlProtocol(self, didFailWithError: URLError(.timedOut))
                return
            }
            // Still valid JSON, but different bytes must fail the manifest's integrity check.
            bytes = mode == "damaged-catalog" ? Self.catalogData + Data("\n".utf8) : Self.catalogData
        } else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "application/json", "Content-Length": String(bytes.count)])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: bytes)
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
