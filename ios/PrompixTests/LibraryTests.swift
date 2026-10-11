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

    func testBundledMediaExist() throws {
        let library = Library(directory: directory)
        for item in library.prompts {
            if let movie = item.media?.video { XCTAssertNotNil(Bundle.main.url(forResource: movie, withExtension: "mp4"), movie) }
            if let image = item.media?.image { XCTAssertNotNil(UIImage(named: image), image) }
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
        XCTAssertEqual(library.version, "studio-001")
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
