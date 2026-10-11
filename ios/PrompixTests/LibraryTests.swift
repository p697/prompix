import XCTest
import CryptoKit
@testable import Prompix

@MainActor final class LibraryTests: XCTestCase {
    private var directory: URL!
    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: directory) }

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
        let url = try XCTUnwrap(Bundle.main.url(forResource: "slow-road", withExtension: "mp4"))
        playback.start(url: url)
        for _ in 0..<100 {
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

    func testFourKindsAndSearchIntersection() throws {
        let library = Library(directory: directory)
        XCTAssertEqual(Set(library.prompts.map(\.kind)), Set(PromptKind.allCases))
        for kind in PromptKind.allCases { XCTAssertGreaterThanOrEqual(library.prompts.filter { $0.kind == kind }.count, 6) }
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

    func testBundledMediaExist() throws {
        let library = Library(directory: directory)
        for item in library.prompts {
            if let movie = item.media?.video { XCTAssertNotNil(Bundle.main.url(forResource: movie, withExtension: "mp4"), movie) }
            if let image = item.media?.image { XCTAssertNotNil(UIImage(named: image), image) }
        }
        for (id, filename) in WebsiteExamples.files {
            XCTAssertNotNil(Bundle.main.url(forResource: filename, withExtension: "html", subdirectory: "WebExamples"), filename)
            XCTAssertNotNil(UIImage(named: "web-\(id)"), id)
        }
    }
    func testRemoteEditionIsAtomicCachedAndRemovalsReachFavorites() throws {
        let library = Library(directory: directory)
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
        XCTAssertEqual(library.version, "studio-002")
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
