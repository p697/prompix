import XCTest
@testable import Prompix

@MainActor final class FeedStoreTests: XCTestCase {
    private var directory: URL!
    override func setUp() async throws { directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString) }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: directory) }

    func testPagingAppendsOnlyRequestedPagesAndStopsAtEnd() async throws {
        let server = FeedStoreServer(), store = FeedStore(service: server)
        await store.load(FeedQuery(locale: "original"))
        XCTAssertEqual(store.items.map(\.id), ["test-0", "test-1"])
        await store.loadMore()
        XCTAssertEqual(store.items.map(\.id), ["test-0", "test-1", "test-2", "test-3"])
        XCTAssertNil(store.nextCursor)
        await store.loadMore()
        let calls = await server.calls
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[1].release, FeedFixture.release)
        XCTAssertEqual(calls[1].cursor, "next")
    }

    func testFailedPullRefreshKeepsCardsAndRetriesFirstPageInsteadOfOldCursor() async throws {
        let server = FeedStoreServer(), store = FeedStore(service: server)
        let query = FeedQuery(locale: "original", sort: "latest")
        await store.load(query)
        let original = store.items.map(\.id)
        await server.setFailure(.unavailable(0))
        await store.load(query, force: true)
        XCTAssertEqual(store.items.map(\.id), original)
        XCTAssertEqual(store.nextCursor, "next")
        XCTAssertTrue(store.failedFirstPage)
        await server.setFailure(nil)
        await store.load(query, force: true)
        XCTAssertFalse(store.failedFirstPage)
        let calls = await server.calls
        XCTAssertEqual(calls.count, 3)
        XCTAssertTrue(calls.allSatisfy { $0.cursor == nil })
    }

    func testLatestCacheCannotReuseCuratedOrderOrCursor() async throws {
        let cache = FeedCache(directory: directory), server = FeedStoreServer()
        let curated = FeedQuery(locale: "original"), latest = FeedQuery(locale: "original", sort: "latest")
        try await cache.store(FeedPage(schemaVersion: 3, release: FeedFixture.release,
            items: [FeedFixture.card(id: "old-curated")], nextCursor: "old-cursor"), query: curated)
        await server.setFailure(.unavailable(0))
        let store = FeedStore(service: server, cache: cache)
        await store.load(latest)
        XCTAssertTrue(store.items.isEmpty)
        XCTAssertNil(store.nextCursor)
        await server.setFailure(nil)
        await store.load(latest, force: true)
        await server.setFailure(.unavailable(0))
        let reopened = FeedStore(service: server, cache: cache)
        await reopened.load(latest)
        XCTAssertEqual(reopened.items.map(\.id), ["test-0", "test-1"])
        XCTAssertNil(reopened.nextCursor)
    }

    func testLateSearchCannotOverwriteNewQueryEvenWhenTransportIgnoresCancellation() async throws {
        let server = FeedStoreServer(), store = FeedStore(service: server)
        await server.setDelay("old", seconds: 0.15)
        let older = Task { await store.load(FeedQuery(locale: "original", q: "old")) }
        try await Task.sleep(for: .milliseconds(20))
        await store.load(FeedQuery(locale: "original", q: "new"))
        await older.value
        XCTAssertEqual(store.query?.q, "new")
        XCTAssertEqual(store.items.first?.id, "new-0")
        XCTAssertFalse(store.isLoading)
    }

    func testFailedNextPageRetainsCardsAndCursorThenExplicitRetryContinues() async throws {
        let server = FeedStoreServer(), store = FeedStore(service: server)
        await store.load(FeedQuery(locale: "original"))
        await server.setFailure(.unavailable(5))
        let now = Date()
        await store.loadMore(now: now)
        XCTAssertEqual(store.items.count, 2); XCTAssertEqual(store.nextCursor, "next")
        XCTAssertEqual(store.failure as? FeedError, .unavailable(5))
        await server.setFailure(nil)
        await store.loadMore(now: now.addingTimeInterval(2))
        XCTAssertEqual(store.items.count, 2)
        await store.loadMore(now: now.addingTimeInterval(6))
        XCTAssertEqual(store.items.count, 4); XCTAssertNil(store.failure)
    }

    func testRateLimitSurvivesQueryChangesAndForcedRefresh() async throws {
        let server = FeedStoreServer(), store = FeedStore(service: server), now = Date()
        await server.setFailure(.rateLimited(60))
        await store.load(FeedQuery(q: "one"), now: now)
        await store.load(FeedQuery(q: "two"), force: true, now: now.addingTimeInterval(1))
        let calls = await server.calls
        XCTAssertEqual(calls.count, 1); XCTAssertEqual(store.query?.q, "two")
        XCTAssertEqual(store.failure as? FeedError, .rateLimited(60))
        await server.setFailure(nil)
        await store.load(FeedQuery(q: "two"), force: true, now: now.addingTimeInterval(61))
        XCTAssertEqual(store.items.first?.id, "two-0")
    }

    func testRepeatedCursorOrDuplicateItemCannotCreateEndlessFeed() async throws {
        for duplicate in [true, false] {
            let server = FeedStoreServer(), store = FeedStore(service: server)
            await store.load(FeedQuery(locale: "original"))
            await server.setNext(FeedPage(schemaVersion: 3, release: FeedFixture.release,
                items: [FeedFixture.card(id: duplicate ? "test-0" : "test-2")], nextCursor: duplicate ? nil : "next"))
            await store.loadMore()
            XCTAssertEqual(store.items.count, 2)
            XCTAssertEqual(store.failure as? FeedError, .invalidResponse)
        }
    }

    func testExpiredSnapshotKeepsVisibleCardsUntilRefreshLoadsFreshFirstPage() async throws {
        let server = FeedStoreServer(), store = FeedStore(service: server)
        await store.load(FeedQuery(locale: "original"))
        await server.setFailure(.snapshotExpired)
        await store.loadMore(); await store.loadMore()
        XCTAssertEqual(store.items.count, 2)
        let calls = await server.calls; XCTAssertEqual(calls.count, 2)
        await server.setFailure(nil)
        await store.load(FeedQuery(locale: "original"), force: true)
        XCTAssertNil(store.failure); XCTAssertEqual(store.items.count, 2)
    }

    func testOfflineCacheNeverUsesOldCursorAndIsIndependentOfPersonalFiles() async throws {
        let cache = FeedCache(directory: directory.appending(path: "browse")), server = FeedStoreServer()
        let query = FeedQuery(locale: "original")
        let first = FeedStore(service: server, cache: cache)
        await first.load(query)
        let personal = directory.appending(path: "favorites.json"), bytes = Data("personal snapshot".utf8)
        try bytes.write(to: personal)
        await server.setFailure(.unavailable(5))
        let reopened = FeedStore(service: server, cache: cache)
        await reopened.load(query)
        XCTAssertEqual(reopened.items.map(\.id), ["test-0", "test-1"])
        XCTAssertTrue(reopened.isCached); XCTAssertNil(reopened.nextCursor)
        await reopened.loadMore()
        let calls = await server.calls; XCTAssertEqual(calls.count, 2)
        try await cache.remove(ids: ["test-0"])
        let removed = try await cache.page(for: query)
        XCTAssertNil(removed)
        XCTAssertEqual(try Data(contentsOf: personal), bytes)
    }

    func testCacheEvictsOldPagesAndDetailsWithoutTouchingUnknownOrPersonalFiles() async throws {
        let cache = FeedCache(directory: directory, pageLimit: 2, detailLimit: 2)
        let page = FeedPage(schemaVersion: 3, release: FeedFixture.release, items: [FeedFixture.card()], nextCursor: nil)
        for q in ["one", "two", "three"] {
            try await cache.store(page, query: FeedQuery(locale: "original", q: q))
            try await Task.sleep(for: .milliseconds(5))
        }
        let first = try await cache.page(for: FeedQuery(locale: "original", q: "one"))
        let latest = try await cache.page(for: FeedQuery(locale: "original", q: "three"))
        XCTAssertNil(first); XCTAssertNotNil(latest)
        let personal = directory.appending(path: "favorites.json"), bytes = Data("retain".utf8)
        try bytes.write(to: personal)
        for value in ["a", "b", "c"] {
            let detail = FeedDetail(schemaVersion: 3, revision: String(repeating: value, count: 64), item: FeedFixture.prompt(), availableLanguages: [])
            try await cache.store(detail, locale: "original")
            try await Task.sleep(for: .milliseconds(5))
        }
        let old = try await cache.detail(id: "test-item", revision: FeedFixture.revision, locale: "original")
        XCTAssertNil(old)
        XCTAssertEqual(try Data(contentsOf: personal), bytes)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasPrefix("detail-") }.count, 2)
    }

    func testCorruptOrUnwritableBrowsingCacheCannotReplaceFreshNetworkData() async throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let blocked = directory.appending(path: "blocked")
        try Data("file, not a cache directory".utf8).write(to: blocked)
        let store = FeedStore(service: FeedStoreServer(), cache: FeedCache(directory: blocked))
        await store.load(FeedQuery(locale: "original"))
        XCTAssertEqual(store.items.count, 2); XCTAssertNil(store.failure)
        XCTAssertTrue(store.cacheWriteFailed)
    }
}

private actor FeedStoreServer: FeedServing {
    struct Call { let query: FeedQuery; let cursor: String?; let release: String? }
    private(set) var calls: [Call] = []
    private var delays: [String: TimeInterval] = [:]
    private var failure: FeedError?
    private var next: FeedPage?
    func setDelay(_ q: String, seconds: TimeInterval) { delays[q] = seconds }
    func setFailure(_ value: FeedError?) { failure = value }
    func setNext(_ value: FeedPage) { next = value }
    func page(query: FeedQuery, cursor: String?, release: String?) async throws -> FeedPage {
        calls.append(Call(query: query, cursor: cursor, release: release))
        if let delay = delays[query.q] {
            await withCheckedContinuation { continuation in DispatchQueue.global().asyncAfter(deadline: .now() + delay) { continuation.resume() } }
        }
        if let failure { throw failure }
        if cursor != nil, let next { return next }
        let start = cursor == nil ? 0 : 2, prefix = query.q.isEmpty ? "test" : query.q
        return FeedPage(schemaVersion: 3, release: FeedFixture.release,
                        items: (start..<(start + 2)).map { FeedFixture.card(id: "\(prefix)-\($0)") }, nextCursor: cursor == nil ? "next" : nil)
    }
    func detail(id: String, revision: String?, locale: String) async throws -> FeedDetail { throw FeedError.notFound }
    func creators(q: String, cursor: String?, release: String?) async throws -> FeedCreatorsPage { throw FeedError.unavailable(5) }
    func browse(locale: String) async throws -> FeedBrowse { throw FeedError.unavailable(5) }
    func state() async throws -> FeedState { throw FeedError.unavailable(5) }
    func removals(after: String) async throws -> FeedRemovals { throw FeedError.unavailable(5) }
}
