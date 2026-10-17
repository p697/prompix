import Foundation
import Observation

/// One instance per browsing surface: changing search cannot cancel discovery.
@MainActor @Observable final class PagedFeedStore<Source: FeedPageSource> {
    private(set) var items: [Source.Page.Item] = []
    private(set) var query: Source.Query?
    private(set) var release: String?
    private(set) var nextCursor: String?
    private(set) var hasLoadedAdditionalPages = false
    private(set) var firstPageGeneration = 0
    private(set) var failedFirstPage = false
    private(set) var isLoading = false
    private(set) var failure: (any Error)?
    private(set) var isCached = false
    private(set) var cacheWriteFailed = false
    private(set) var retryAt: Date?
    private var transportQuery: Source.Query?
    private let recommendations: LocalRecommendations?
    private var loadedAt: Date?
    private var requestID: UUID?
    private var pending: Task<Void, Never>?
    private let service: any FeedServing
    private let cache: FeedCache?
    private let memoryPageLimit: Int
    private struct Snapshot {
        var items: [Source.Page.Item]
        let release: String
        let transportQuery: Source.Query
        let nextCursor: String?
        var loadedAt: Date
    }
    private var snapshots: [Source.Query: Snapshot] = [:]
    private var snapshotOrder: [Source.Query] = []
    init(service: any FeedServing, cache: FeedCache? = nil, memoryPageLimit: Int = 0, recommendations: LocalRecommendations? = nil) {
        self.recommendations = recommendations
        self.service = service; self.cache = cache; self.memoryPageLimit = max(0, memoryPageLimit)
    }

    /// Explicit preference edits invalidate warm ranks without clearing the
    /// visible feed. The next requested session will apply the new preferences.
    func invalidateCachedPages() {
        snapshots.removeAll(); snapshotOrder.removeAll(); loadedAt = nil
    }

    /// Select synchronously with the category control, before SwiftUI renders.
    /// Only exact, bounded first-page snapshots can skip a loading placeholder.
    func select(_ value: Source.Query, now: Date = Date()) {
        guard let normalized = try? Source.validate(value), normalized != query else { return }
        cancel()
        query = normalized; failedFirstPage = false; cacheWriteFailed = false
        hasLoadedAdditionalPages = false
        if retryAt == nil || now >= retryAt! { failure = nil; retryAt = nil }
        if let page = snapshots[normalized] {
            items = page.items; release = page.release; loadedAt = page.loadedAt; transportQuery = page.transportQuery
            isCached = now.timeIntervalSince(page.loadedAt) >= 300
            nextCursor = isCached ? nil : page.nextCursor
            snapshotOrder.removeAll { $0 == normalized }; snapshotOrder.append(normalized)
        } else {
            items = []; release = nil; nextCursor = nil; loadedAt = nil; isCached = false; transportQuery = nil
        }
        firstPageGeneration &+= 1
    }
    private func remember(_ page: Source.Page, query: Source.Query, now: Date) {
        guard memoryPageLimit > 0 else { return }
        snapshots[query] = Snapshot(items: page.items, release: page.release, transportQuery: transportQuery ?? query, nextCursor: page.nextCursor, loadedAt: now)
        snapshotOrder.removeAll { $0 == query }; snapshotOrder.append(query)
        while snapshotOrder.count > memoryPageLimit { snapshots.removeValue(forKey: snapshotOrder.removeFirst()) }
    }

    func load(_ value: Source.Query, force: Bool = false, now: Date = Date()) async {
        guard !Task.isCancelled else { return }
        let normalized: Source.Query
        do { normalized = try Source.validate(value) }
        catch {
            cancel(); items = []; query = value; release = nil; nextCursor = nil; failure = error
            return
        }
        select(normalized, now: now)
        let needsDiskCache = release == nil
        if let retryAt, now < retryAt {
            return
        }
        if !force, failure == nil, !isCached, let loadedAt, now.timeIntervalSince(loadedAt) < 300 { return }
        cancel()
        firstPageGeneration &+= 1
        query = normalized; failedFirstPage = true; failure = nil; retryAt = nil; isLoading = true
        let requestQuery = Source.sessionQuery(normalized)
        let owner = UUID(); requestID = owner
        let task = Task { [weak self] in
            guard let self else { return }
            if needsDiskCache, let page = try? await Source.cached(in: cache, query: normalized), self.owns(owner) {
                self.items = page.items; self.release = page.release; self.isCached = true
                // Cached cursors may be expired; revalidate the first page before paging.
                self.nextCursor = nil
            }
            do {
                try Task.checkCancellation()
                var page = try await Source.fetch(from: service, query: requestQuery, cursor: nil, release: nil)
                try Task.checkCancellation()
                guard self.owns(owner) else { return }
                try Source.validate(page, query: normalized, release: nil)
                page = Source.ranked(page, query: normalized, recommendations: recommendations, now: now)
                self.transportQuery = requestQuery
                self.items = page.items; self.release = page.release; self.nextCursor = page.nextCursor
                self.isCached = false; self.loadedAt = now; self.failure = nil
                self.hasLoadedAdditionalPages = false; self.failedFirstPage = false
                self.remember(page, query: normalized, now: now)
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
                var page = try await Source.fetch(from: service, query: self.transportQuery ?? query, cursor: cursor, release: release)
                try Task.checkCancellation()
                guard self.owns(owner) else { return }
                try Source.validate(page, query: query, release: release)
                let existing = Set(self.items.map(\.id))
                guard page.nextCursor != cursor, !page.items.contains(where: { existing.contains($0.id) }) else { throw FeedError.invalidResponse }
                page = Source.ranked(page, query: query, recommendations: recommendations, now: now)
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
    func discard(_ ids: Set<String>) {
        items.removeAll { ids.contains($0.id) }
        for key in Array(snapshots.keys) { snapshots[key]?.items.removeAll { ids.contains($0.id) } }
    }
    private func owns(_ owner: UUID) -> Bool { requestID == owner }
    private func finish(_ owner: UUID) {
        guard owns(owner) else { return }
        isLoading = false; pending = nil; requestID = nil
    }
    private func record(_ error: any Error, owner: UUID, now: Date) {
        guard owns(owner), !(error is CancellationError), (error as? URLError)?.code != .cancelled else { return }
        failure = error
        if error as? FeedError == .snapshotExpired, let query {
            snapshots[query]?.loadedAt = .distantPast
        }
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

protocol FeedPageSource: Sendable {
    associatedtype Query: Hashable & Sendable
    associatedtype Page: FeedPageValue
    static func sessionQuery(_ query: Query) -> Query
    @MainActor static func ranked(_ page: Page, query: Query, recommendations: LocalRecommendations?, now: Date) -> Page
    static func validate(_ query: Query) throws -> Query
    static func validate(_ page: Page, query: Query, release: String?) throws
    static func fetch(from service: any FeedServing, query: Query, cursor: String?, release: String?) async throws -> Page
    static func cached(in cache: FeedCache?, query: Query) async throws -> Page?
    static func save(_ page: Page, in cache: FeedCache, query: Query, now: Date) async throws
}
extension FeedPageSource {
    static func sessionQuery(_ query: Query) -> Query { query }
    @MainActor static func ranked(_ page: Page, query: Query, recommendations: LocalRecommendations?, now: Date) -> Page { page }
}
enum FeedCardsSource: FeedPageSource {
    static func sessionQuery(_ query: FeedQuery) -> FeedQuery {
        guard query.sort == "recommended" else { return query }
        var value = query; value.seed = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased(); return value
    }
    @MainActor static func ranked(_ page: FeedPage, query: FeedQuery, recommendations: LocalRecommendations?, now: Date) -> FeedPage {
        guard query.sort == "recommended", let recommendations else { return page }
        return FeedPage(schemaVersion: page.schemaVersion, release: page.release, items: recommendations.rank(page.items, now: now), nextCursor: page.nextCursor)
    }
    static func validate(_ query: FeedQuery) throws -> FeedQuery { try query.validated() }
    static func validate(_ page: FeedPage, query: FeedQuery, release: String?) throws {
        _ = try page.validated(locale: query.locale, limit: query.sort == "recommended" ? 90 : FeedClient.pageSize, release: release)
    }
    static func fetch(from service: any FeedServing, query: FeedQuery, cursor: String?, release: String?) async throws -> FeedPage {
        let first = try await service.page(query: query, cursor: cursor, release: release)
            .validated(locale: query.locale, limit: FeedClient.pageSize, release: release)
        guard query.sort == "recommended" else { return first }
        var items = first.items, next = first.nextCursor
        var seen = Set(items.map(\.id)), cursors = Set([cursor].compactMap { $0 })
        // At most three bounded cloud pages. Personal ranking has enough choices
        // without downloading the catalog or sending any preference/history.
        for _ in 0..<2 {
            guard let token = next else { break }
            guard cursors.insert(token).inserted else { throw FeedError.invalidResponse }
            let page = try await service.page(query: query, cursor: token, release: first.release)
                .validated(locale: query.locale, limit: FeedClient.pageSize, release: first.release)
            for card in page.items { guard seen.insert(card.id).inserted else { throw FeedError.invalidResponse } }
            items.append(contentsOf: page.items); next = page.nextCursor
        }
        guard next == nil || !cursors.contains(next!) else { throw FeedError.invalidResponse }
        return FeedPage(schemaVersion: first.schemaVersion, release: first.release, items: items, nextCursor: next)
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
