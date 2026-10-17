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

    func testScopedPreviewsStayBoundToQueryAndDisappearAfterRemoval() async throws {
        let server = FeedRepositoryServer()
        await server.setCards([FeedFixture.card()])
        let feed = FeedRepository(service: server, cache: FeedCache(directory: directory), checkpoint: FeedCheckpoint(), commitRemovals: { _ in })
        XCTAssertEqual(feed.previewCards(for: FeedQuery(locale: "original", model: "Test model"), including: [FeedFixture.card()]).map(\.id), ["test-item"], "A directory preview is usable even when the random home pool does not contain its creator")
        XCTAssertTrue(feed.previewCards(for: FeedQuery(locale: "original", kind: "image", model: "Test model"), including: [FeedFixture.card()]).isEmpty)
        XCTAssertEqual(feed.previewCards(for: FeedQuery(locale: "zh-Hans", model: "Test model"), including: [FeedFixture.card()]).map(\.id), ["test-item"])
        await feed.discovery.load(FeedQuery(locale: "original"))
        await feed.search.load(FeedQuery(locale: "original", q: "fixture"))
        XCTAssertEqual(feed.previewCards(for: FeedQuery(locale: "original", model: "Test model")).map(\.id), ["test-item"], "Repeated cards across surfaces must not duplicate")
        XCTAssertTrue(feed.previewCards(for: FeedQuery(locale: "original", kind: "image", model: "Test model")).isEmpty)
        XCTAssertTrue(feed.previewCards(for: FeedQuery(locale: "original", kind: "skill", model: "Test model")).isEmpty)
        XCTAssertTrue(feed.previewCards(for: FeedQuery(locale: "original", model: "Other model")).isEmpty)
        XCTAssertTrue(feed.previewCards(for: FeedQuery(locale: "original", model: "Test model", q: "different")).isEmpty)
        XCTAssertTrue(feed.previewCards(for: FeedQuery(locale: "original")).isEmpty)
        XCTAssertTrue(feed.previewCards(for: FeedQuery(locale: "original", creator: "other-creator")).isEmpty)
        await server.setRemoval(true); try await feed.refresh()
        XCTAssertTrue(feed.previewCards(for: FeedQuery(locale: "original", model: "Test model"), including: [FeedFixture.card()]).isEmpty)
    }

    func testExplorationUsesExactModelAndDoesNotInventAnUnmatchedTopic() throws {
        let item = FeedFixture.prompt(), paths = FeedExplorationPath.paths(for: item)
        XCTAssertEqual(paths.map(\.id), ["model"])
        XCTAssertEqual(paths.first?.query.model, item.model)
        XCTAssertNil(paths.first?.query.kind, "A model path can explore multiple modalities")
        XCTAssertEqual(try paths.first?.query.validated(), paths.first?.query)
    }

    func testForegroundRefreshUpdatesFirstPageAndLeavesUnchangedPublicationAlone() async throws {
        let source = try source(), server = FeedRepositoryServer()
        let library = Library(directory: directory, catalogURL: source, feedService: server)
        let feed = try XCTUnwrap(library.feed), now = Date()
        await library.refresh(now: now)
        await feed.discovery.load(FeedQuery(sort: "latest"))
        let nextRelease = "feed-" + String(repeating: "f", count: 64)
        await server.setRelease(nextRelease)
        await library.refresh(now: now.addingTimeInterval(301))
        XCTAssertEqual(feed.discovery.release, nextRelease)
        let refreshed = await server.latestCalls()
        XCTAssertEqual(refreshed, 2)
        await library.refresh(now: now.addingTimeInterval(602))
        let unchanged = await server.latestCalls()
        XCTAssertEqual(unchanged, 2)
    }

    func testForegroundKeepsPagedSnapshotUntilExplicitFirstPageRefresh() async throws {
        let source = try source(), server = FeedRepositoryServer()
        let library = Library(directory: directory, catalogURL: source, feedService: server)
        let feed = try XCTUnwrap(library.feed), now = Date(), query = FeedQuery(sort: "latest")
        await server.setPaging(true)
        await library.refresh(now: now)
        await feed.discovery.load(query)
        await feed.discovery.loadMore()
        XCTAssertTrue(feed.discovery.hasLoadedAdditionalPages)
        let nextRelease = "feed-" + String(repeating: "f", count: 64)
        await server.setRelease(nextRelease)
        await library.refresh(now: now.addingTimeInterval(301))
        XCTAssertEqual(feed.discovery.release, FeedFixture.release)
        XCTAssertEqual(feed.discovery.items.count, 2)
        await library.refresh(force: true)
        await feed.discovery.load(query, force: true)
        XCTAssertEqual(feed.discovery.release, nextRelease)
        XCTAssertEqual(feed.discovery.items.count, 1)
        XCTAssertFalse(feed.discovery.hasLoadedAdditionalPages)
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
    private var paging = false
    func setPaging(_ value: Bool) { paging = value }
    private var removed = false
    private var unavailable = false
    private(set) var calls: [String] = []
    private var activeRelease = FeedFixture.release
    private var cards: [FeedCard] = []
    func setCards(_ value: [FeedCard]) { cards = value }
    func setRelease(_ value: String) { activeRelease = value }
    func latestCalls() -> Int { calls.filter { $0 == "latest" }.count }
    func setRemoval(_ value: Bool) { removed = value }
    func setUnavailable(_ value: Bool) { unavailable = value }
    func page(query: FeedQuery, cursor: String?, release: String?) async throws -> FeedPage {
        calls.append(query.sort == "latest" ? "latest" : "page")
        return FeedPage(schemaVersion: 3, release: release ?? activeRelease,
                        items: paging ? [FeedFixture.card(id: cursor == nil ? "test-0" : "test-1")] : cards,
                        nextCursor: paging && cursor == nil ? "next" : nil)
    }
    func browse(locale: String) async throws -> FeedBrowse { throw FeedError.unavailable(5) }
    func state() async throws -> FeedState {
        calls.append("state")
        if unavailable { throw FeedError.unavailable(5) }
        return FeedState(schemaVersion: 3, release: activeRelease, generation: "1", removalSequence: removed ? "1" : "0", count: removed ? 0 : 1, publishedAt: nil)
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
