import XCTest
@testable import Prompix

@MainActor final class FeedRepositoryTests: XCTestCase {
    private var directory: URL!
    override func setUp() async throws { directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString) }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: directory) }
    private func source() throws -> URL {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appending(path: "source.json")
        try JSONEncoder().encode(Catalog(schemaVersion: 1, version: "test-seed", prompts: [FeedFixture.prompt()])).write(to: url)
        return url
    }

    func testPagedRefreshDoesNotDeleteUnloadedFavoritesOrDrafts() async throws {
        let source = try source(), server = FeedRepositoryServer()
        let library = Library(directory: directory, catalogURL: source, feedService: server)
        let item = FeedFixture.prompt()
        XCTAssertTrue(library.toggle(item)); XCTAssertTrue(library.saveDraft("Personal draft", for: item))
        let saved = try Data(contentsOf: directory.appending(path: "favorites.json"))
        let drafts = try Data(contentsOf: directory.appending(path: "drafts.json"))
        await library.feed?.discovery.load(FeedQuery(locale: "original"))
        await library.refresh(force: true)
        XCTAssertTrue(library.feed?.discovery.items.isEmpty == true)
        XCTAssertEqual(library.favorites, [item]); XCTAssertEqual(library.draft(for: item), "Personal draft")
        XCTAssertEqual(try Data(contentsOf: directory.appending(path: "favorites.json")), saved)
        XCTAssertEqual(try Data(contentsOf: directory.appending(path: "drafts.json")), drafts)
        XCTAssertEqual(library.syncState, .current)
        let calls = await server.calls
        XCTAssertEqual(calls, ["page", "state", "removals-0"])
    }

    func testKnownRemovalCommitsCheckpointWithPersonalChangesAndCannotReturnFromLegacyCache() async throws {
        let source = try source(), server = FeedRepositoryServer(), item = FeedFixture.prompt()
        let library = Library(directory: directory, catalogURL: source, feedService: server)
        XCTAssertTrue(library.toggle(item)); XCTAssertTrue(library.saveDraft("Remove only on explicit tombstone", for: item))
        await server.setRemoval(true)
        await library.refresh(force: true)
        XCTAssertTrue(library.isRemoved(item)); XCTAssertTrue(library.favorites.isEmpty); XCTAssertTrue(library.prompts.isEmpty)
        XCTAssertNil(library.drafts[item.id]); XCTAssertFalse(library.toggle(item))
        let checkpoint = try JSONDecoder().decode(FeedCheckpoint.self, from: Data(contentsOf: directory.appending(path: FeedCheckpoint.fileName)))
        XCTAssertEqual(checkpoint.after, "1"); XCTAssertEqual(checkpoint.removedIDs, [item.id])
        let reopened = Library(directory: directory, catalogURL: source, feedService: server)
        XCTAssertTrue(reopened.isRemoved(item)); XCTAssertTrue(reopened.prompts.isEmpty)
    }

    func testFailedPersonalWriteRollsBackCheckpointAndRetriesSameRemoval() async throws {
        let source = try source(), server = FeedRepositoryServer(), item = FeedFixture.prompt()
        let initial = Library(directory: directory, catalogURL: source)
        XCTAssertTrue(initial.toggle(item)); XCTAssertTrue(initial.saveDraft("Retain on failed commit", for: item))
        let saved = try Data(contentsOf: directory.appending(path: "favorites.json"))
        let drafts = try Data(contentsOf: directory.appending(path: "drafts.json"))
        let failure = FeedWriteFailure()
        let library = Library(directory: directory, catalogURL: source, feedService: server, installFileWriter: { data, url in
            if failure.enabled && url.lastPathComponent == "favorites.json" { throw CocoaError(.fileWriteOutOfSpace) }
            try data.write(to: url, options: .atomic)
        })
        failure.enabled = true
        await server.setRemoval(true)
        await library.refresh(force: true)
        XCTAssertEqual(library.syncState, .failed)
        XCTAssertEqual(try Data(contentsOf: directory.appending(path: "favorites.json")), saved)
        XCTAssertEqual(try Data(contentsOf: directory.appending(path: "drafts.json")), drafts)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appending(path: FeedCheckpoint.fileName).path))
        XCTAssertTrue(library.isRemoved(item), "Known takedown blocks use even while durable commit is retrying")
        failure.enabled = false
        await library.refresh(force: true)
        XCTAssertEqual(library.syncState, .current); XCTAssertTrue(library.favorites.isEmpty)
        let calls = await server.calls
        XCTAssertEqual(calls.filter { $0 == "removals-0" }.count, 2)
    }

    func testDetailCacheIsRevisionBoundAndKnownRemovalOverridesOfflineCopy() async throws {
        let source = try source(), server = FeedRepositoryServer()
        let library = Library(directory: directory, catalogURL: source, feedService: server)
        let repository = try XCTUnwrap(library.feed)
        let item = try await repository.detail(for: FeedFixture.card(), locale: "original")
        XCTAssertEqual(item.prompt, FeedFixture.prompt().prompt)
        await server.setUnavailable(true)
        let cached = try await repository.detail(for: FeedFixture.card(), locale: "original")
        XCTAssertEqual(cached, item)
        do { _ = try await repository.loadDetail(id: item.id, revision: String(repeating: "b", count: 64), locale: "original"); XCTFail("Uncached revision") }
        catch { }
        await server.setUnavailable(false); await server.setRemoval(true)
        await library.refresh(force: true)
        XCTAssertNil(repository.cachedDetail(for: FeedFixture.card(), locale: "original"))
        do { _ = try await repository.detail(for: FeedFixture.card(), locale: "original"); XCTFail("Removed cached detail") }
        catch let error as FeedError { XCTAssertEqual(error, .removed) }
    }

    func testCorruptCheckpointPreventsLegacyCatalogRevivalAndPersonalOverwrite() throws {
        let source = try source(), initial = Library(directory: directory, catalogURL: source), item = FeedFixture.prompt()
        XCTAssertTrue(initial.toggle(item))
        let before = try Data(contentsOf: directory.appending(path: "favorites.json"))
        try Data("broken checkpoint".utf8).write(to: directory.appending(path: FeedCheckpoint.fileName))
        let reopened = Library(directory: directory, catalogURL: source, feedService: FeedRepositoryServer())
        XCTAssertNil(reopened.feed); XCTAssertTrue(reopened.prompts.isEmpty); XCTAssertFalse(reopened.toggle(item))
        XCTAssertEqual(try Data(contentsOf: directory.appending(path: "favorites.json")), before)
    }
}

@MainActor private final class FeedWriteFailure { var enabled = false }
private actor FeedRepositoryServer: FeedServing {
    private var removed = false
    private var unavailable = false
    private(set) var calls: [String] = []
    func setRemoval(_ value: Bool) { removed = value }
    func setUnavailable(_ value: Bool) { unavailable = value }
    func page(query: FeedQuery, cursor: String?, release: String?) async throws -> FeedPage {
        calls.append("page")
        return FeedPage(schemaVersion: 3, release: FeedFixture.release, items: [], nextCursor: nil)
    }
    func browse(locale: String) async throws -> FeedBrowse { throw FeedError.unavailable(5) }
    func state() async throws -> FeedState {
        calls.append("state")
        if unavailable { throw FeedError.unavailable(5) }
        return FeedState(schemaVersion: 3, release: FeedFixture.release, generation: "1", removalSequence: removed ? "1" : "0", count: removed ? 0 : 1, publishedAt: nil)
    }
    func removals(after: String) async throws -> FeedRemovals {
        calls.append("removals-" + after)
        if removed && after == "0" { return FeedRemovals(schemaVersion: 3, items: [.init(sequence: "1", id: "test-item")], nextAfter: "1", hasMore: false) }
        return FeedRemovals(schemaVersion: 3, items: [], nextAfter: after, hasMore: false)
    }
    func detail(id: String, revision: String?, locale: String) async throws -> FeedDetail {
        calls.append("detail")
        if unavailable { throw FeedError.unavailable(5) }
        if removed { throw FeedError.removed }
        return FeedDetail(schemaVersion: 3, revision: revision ?? FeedFixture.revision, item: FeedFixture.prompt(), availableLanguages: [])
    }
    func creators(q: String, cursor: String?, release: String?) async throws -> FeedCreatorsPage { throw FeedError.unavailable(5) }
}
