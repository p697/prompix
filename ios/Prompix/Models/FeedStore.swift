import Foundation
import Observation

/// One instance per browsing surface: changing search cannot cancel discovery.
@MainActor @Observable final class PagedFeedStore<Source: FeedPageSource> {
    private(set) var items: [Source.Page.Item] = []
    private(set) var query: Source.Query?
    private(set) var release: String?
    private(set) var nextCursor: String?
    private(set) var hasLoadedAdditionalPages = false
    private(set) var failedFirstPage = false
    private(set) var isLoading = false
    private(set) var failure: (any Error)?
    private(set) var isCached = false
    private(set) var cacheWriteFailed = false
    private(set) var retryAt: Date?
    private var loadedAt: Date?
    private var requestID: UUID?
    private var pending: Task<Void, Never>?
    private let service: any FeedServing
    private let cache: FeedCache?
    init(service: any FeedServing, cache: FeedCache? = nil) { self.service = service; self.cache = cache }

    func load(_ value: Source.Query, force: Bool = false, now: Date = Date()) async {
        guard !Task.isCancelled else { return }
        let normalized: Source.Query
        do { normalized = try Source.validate(value) }
        catch {
            cancel(); items = []; query = value; release = nil; nextCursor = nil; failure = error
            return
        }
        let sameQuery = query == normalized
        if let retryAt, now < retryAt {
            if !sameQuery { cancel(); items = []; query = normalized; release = nil; nextCursor = nil; loadedAt = nil; isCached = false; hasLoadedAdditionalPages = false }
            return
        }
        if sameQuery, !force, failure == nil, !isCached, let loadedAt, now.timeIntervalSince(loadedAt) < 300 { return }
        cancel()
        if !sameQuery { items = []; release = nil; nextCursor = nil; loadedAt = nil; isCached = false; hasLoadedAdditionalPages = false }
        query = normalized; failedFirstPage = true; failure = nil; retryAt = nil; isLoading = true
        let owner = UUID(); requestID = owner
        let task = Task { [weak self] in
            guard let self else { return }
            if !sameQuery, let page = try? await Source.cached(in: cache, query: normalized), self.owns(owner) {
                self.items = page.items; self.release = page.release; self.isCached = true
                // Cached cursors may be expired; revalidate the first page before paging.
                self.nextCursor = nil
            }
            do {
                try Task.checkCancellation()
                let page = try await Source.fetch(from: service, query: normalized, cursor: nil, release: nil)
                try Task.checkCancellation()
                guard self.owns(owner) else { return }
                try Source.validate(page, query: normalized, release: nil)
                self.items = page.items; self.release = page.release; self.nextCursor = page.nextCursor
                self.isCached = false; self.loadedAt = now; self.failure = nil
                self.hasLoadedAdditionalPages = false; self.failedFirstPage = false
                if let cache {
                    do { try await Source.save(page, in: cache, query: normalized, now: now); if self.owns(owner) { self.cacheWriteFailed = false } }
                    catch { if self.owns(owner) { self.cacheWriteFailed = true } }
                }
            } catch { self.record(error, owner: owner, now: now) }
            self.finish(owner)
        }
        pending = task
        await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
    }

    func loadMore(now: Date = Date()) async {
        guard !Task.isCancelled, !isLoading, !isCached, let query, let cursor = nextCursor, let release,
              retryAt == nil || now >= retryAt!, !(failure as? FeedError == .snapshotExpired) else { return }
        let owner = UUID(); requestID = owner; isLoading = true; failure = nil; retryAt = nil; failedFirstPage = false
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                let page = try await Source.fetch(from: service, query: query, cursor: cursor, release: release)
                try Task.checkCancellation()
                guard self.owns(owner) else { return }
                try Source.validate(page, query: query, release: release)
                let existing = Set(self.items.map(\.id))
                guard page.nextCursor != cursor, !page.items.contains(where: { existing.contains($0.id) }) else { throw FeedError.invalidResponse }
                self.items.append(contentsOf: page.items); self.nextCursor = page.nextCursor
                self.hasLoadedAdditionalPages = true
            } catch { self.record(error, owner: owner, now: now) }
            self.finish(owner)
        }
        pending = task
        await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
    }
    func cancel() {
        pending?.cancel(); pending = nil; requestID = nil; isLoading = false
    }
    func discard(_ ids: Set<String>) { items.removeAll { ids.contains($0.id) } }
    private func owns(_ owner: UUID) -> Bool { requestID == owner }
    private func finish(_ owner: UUID) {
        guard owns(owner) else { return }
        isLoading = false; pending = nil; requestID = nil
    }
    private func record(_ error: any Error, owner: UUID, now: Date) {
        guard owns(owner), !(error is CancellationError), (error as? URLError)?.code != .cancelled else { return }
        failure = error
        if case let FeedError.rateLimited(seconds) = error { retryAt = now.addingTimeInterval(seconds) }
        if case let FeedError.unavailable(seconds) = error { retryAt = now.addingTimeInterval(seconds) }
    }
}


protocol FeedPageValue: Sendable {
    associatedtype Item: Identifiable & Sendable where Item.ID == String
    var items: [Item] { get }
    var release: String { get }
    var nextCursor: String? { get }
}
extension FeedPage: FeedPageValue {}
extension FeedCreatorsPage: FeedPageValue {}

protocol FeedPageSource {
    associatedtype Query: Hashable & Sendable
    associatedtype Page: FeedPageValue
    static func validate(_ query: Query) throws -> Query
    static func validate(_ page: Page, query: Query, release: String?) throws
    static func fetch(from service: any FeedServing, query: Query, cursor: String?, release: String?) async throws -> Page
    static func cached(in cache: FeedCache?, query: Query) async throws -> Page?
    static func save(_ page: Page, in cache: FeedCache, query: Query, now: Date) async throws
}
enum FeedCardsSource: FeedPageSource {
    static func validate(_ query: FeedQuery) throws -> FeedQuery { try query.validated() }
    static func validate(_ page: FeedPage, query: FeedQuery, release: String?) throws {
        _ = try page.validated(locale: query.locale, limit: FeedClient.pageSize, release: release)
    }
    static func fetch(from service: any FeedServing, query: FeedQuery, cursor: String?, release: String?) async throws -> FeedPage {
        try await service.page(query: query, cursor: cursor, release: release)
    }
    static func cached(in cache: FeedCache?, query: FeedQuery) async throws -> FeedPage? { try await cache?.page(for: query)?.page }
    static func save(_ page: FeedPage, in cache: FeedCache, query: FeedQuery, now: Date) async throws { try await cache.store(page, query: query, now: now) }
}
enum FeedCreatorsSource: FeedPageSource {
    static func validate(_ query: String) throws -> String { try FeedQuery(q: query).validated().q }
    static func validate(_ page: FeedCreatorsPage, query: String, release: String?) throws {
        _ = try page.validated(limit: FeedClient.pageSize, release: release)
    }
    static func fetch(from service: any FeedServing, query: String, cursor: String?, release: String?) async throws -> FeedCreatorsPage {
        try await service.creators(q: query, cursor: cursor, release: release)
    }
    static func cached(in cache: FeedCache?, query: String) async throws -> FeedCreatorsPage? { try await cache?.creators(q: query) }
    static func save(_ page: FeedCreatorsPage, in cache: FeedCache, query: String, now: Date) async throws { try await cache.store(page, q: query) }
}
typealias FeedStore = PagedFeedStore<FeedCardsSource>
typealias FeedCreatorStore = PagedFeedStore<FeedCreatorsSource>
