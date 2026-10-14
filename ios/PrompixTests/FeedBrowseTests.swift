import XCTest
@testable import Prompix

@MainActor final class FeedBrowseTests: XCTestCase {
    func testBundledCollectionsMatchSharedContractAndQueryRejectsUnknownIDs() throws {
        XCTAssertEqual(Set(FeedCollections.definitions.keys), Set(Collection.all.map(\.id)))
        XCTAssertEqual(FeedCollections.definitions.count, 10)
        for collection in Collection.all {
            XCTAssertEqual(try FeedQuery(collection: collection.id).validated().collection, collection.id)
        }
        XCTAssertThrowsError(try FeedQuery(collection: "invalid").validated())
    }
    func testCreatorPagingUsesGlobalCountsAndOnlyLoadsRequestedPages() async throws {
        let server = BrowseTestService(), store = FeedCreatorStore(service: server)
        await store.load("")
        XCTAssertEqual(store.items.count, 2); XCTAssertEqual(store.items.first?.count, 100)
        var calls = await server.creatorCalls; XCTAssertEqual(calls.count, 1)
        await store.loadMore()
        XCTAssertEqual(store.items.map(\.id), ["creator-0", "creator-1", "creator-2", "creator-3"])
        XCTAssertNil(store.nextCursor)
        calls = await server.creatorCalls; XCTAssertEqual(calls.count, 2)
        await store.load("  ＡＵＴＨＯＲ  ")
        XCTAssertEqual(store.query, "author")
        calls = await server.creatorCalls; XCTAssertEqual(calls.last?.0, "author")
    }
    func testBrowseAndCreatorsStayAvailableOfflineAndRespectRetryDelay() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = FeedCache(directory: directory), service = BrowseTestService()
        let online = FeedBrowseStore(service: service, cache: cache)
        await online.load(locale: "original")
        XCTAssertEqual(online.value?.collections.first?.count, 10000)
        let creators = FeedCreatorStore(service: service, cache: cache)
        await creators.load("")
        await service.fail()
        let offline = FeedBrowseStore(service: service, cache: cache)
        let now = Date()
        await offline.load(locale: "original", now: now)
        XCTAssertTrue(offline.isCached); XCTAssertNotNil(offline.failure)
        XCTAssertEqual(offline.value?.modelCount, 70)
        await offline.load(locale: "original", force: true, now: now.addingTimeInterval(1))
        let calls = await service.browseCalls; XCTAssertEqual(calls, 2)
        let directoryStore = FeedCreatorStore(service: service, cache: cache)
        await directoryStore.load("")
        XCTAssertEqual(directoryStore.items.count, 2); XCTAssertTrue(directoryStore.isCached)
        XCTAssertNil(directoryStore.nextCursor, "An old cached cursor must never page into another snapshot")
        try await cache.remove(ids: ["test-item"])
        let removedBrowse = try await cache.browse(locale: "original")
        let removedCreators = try await cache.creators(q: "")
        XCTAssertNil(removedBrowse); XCTAssertNil(removedCreators)
    }
    func testCacheCannotReadOrPruneThroughDirectorySymlink() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let actual = root.appending(path: "actual"), link = root.appending(path: "link")
        let cache = FeedCache(directory: actual)
        let page = FeedPage(schemaVersion: 3, release: FeedFixture.release, items: [FeedFixture.card()], nextCursor: nil)
        try await cache.store(page, query: FeedQuery(locale: "original"))
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: actual)
        let unsafe = FeedCache(directory: link)
        do { _ = try await unsafe.page(for: FeedQuery(locale: "original")); XCTFail("Must not follow directory link") } catch { }
        do { try await unsafe.remove(ids: ["test-item"]); XCTFail("Must not prune through directory link") } catch { }
        let retained = try await cache.page(for: FeedQuery(locale: "original"))
        XCTAssertEqual(retained?.page.items.count, 1)
    }
}

private actor BrowseTestService: FeedServing {
    private var unavailable = false
    private(set) var creatorCalls: [(String, String?)] = []
    private(set) var browseCalls = 0
    func fail() { unavailable = true }
    func browse(locale: String) async throws -> FeedBrowse {
        browseCalls += 1
        if unavailable { throw FeedError.rateLimited(60) }
        return FeedBrowse(schemaVersion: 3, release: FeedFixture.release,
            collections: [.init(id: "play", count: 10000, covers: [FeedFixture.card()])],
            models: [.init(name: "Popular model", count: 9000)], modelCount: 70)
    }
    func creators(q: String, cursor: String?, release: String?) async throws -> FeedCreatorsPage {
        creatorCalls.append((q, cursor))
        if unavailable { throw URLError(.notConnectedToInternet) }
        let indices = cursor == nil ? 0..<2 : 2..<4
        let items = indices.map { index in FeedCreatorsPage.Entry(creator:
            Prompt.Creator(id: "creator-\(index)", platform: "web", displayName: "Author \(index)", profileURL: URL(string: "https://example.com/author")!), count: 100 - index) }
        return FeedCreatorsPage(schemaVersion: 3, release: FeedFixture.release, items: items, nextCursor: cursor == nil ? "next" : nil)
    }
    func page(query: FeedQuery, cursor: String?, release: String?) async throws -> FeedPage { throw FeedError.unavailable(5) }
    func detail(id: String, revision: String?, locale: String) async throws -> FeedDetail { throw FeedError.unavailable(5) }
    func state() async throws -> FeedState { throw FeedError.unavailable(5) }
    func removals(after: String) async throws -> FeedRemovals { throw FeedError.unavailable(5) }
}
