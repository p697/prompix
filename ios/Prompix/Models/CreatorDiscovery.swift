import Foundation

enum CreatorSort: String, CaseIterable, Identifiable, Codable, Sendable {
    case recommended, latest, count, name
    var id: String { rawValue }
    var title: String {
        switch self {
        case .recommended: String(localized: "推荐")
        case .latest: String(localized: "最近更新")
        case .count: String(localized: "作品数量")
        case .name: String(localized: "名称")
        }
    }
}

struct CreatorQuery: Hashable, Sendable {
    var q = ""
    var kind: String?
    var sort: CreatorSort = .recommended
    // Daily cache identity refreshes recommendations on the next foreground visit.
    var day = Self.dayKey()
    static func dayKey(_ date: Date = Date()) -> String {
        ISO8601DateFormatter().string(from: date).prefix(10).description
    }
    func validated() throws -> Self {
        var value = self
        value.q = try FeedQuery(kind: kind, q: q).validated().q
        return value
    }
    var cacheKey: String { [day, sort.rawValue, kind ?? "", q].joined(separator: "\n") }
    var parameters: [URLQueryItem] {
        var result = [URLQueryItem(name: "q", value: q), URLQueryItem(name: "sort", value: sort.rawValue)]
        if let kind { result.append(URLQueryItem(name: "kind", value: kind)) }
        return result
    }
}

enum CreatorDiscoverySource: FeedPageSource {
    static func validate(_ query: CreatorQuery) throws -> CreatorQuery { try query.validated() }
    static func validate(_ page: FeedCreatorsPage, query: CreatorQuery, release: String?) throws {
        _ = try page.validated(limit: FeedClient.pageSize, release: release)
        for item in page.items {
            if let preview = item.preview, let kind = query.kind {
                guard kind == "skill" ? preview.contentType == "skill" : preview.contentType != "skill" && preview.kind.rawValue == kind
                else { throw FeedError.invalidResponse }
            }
        }
    }
    static func fetch(from service: any FeedServing, query: CreatorQuery, cursor: String?, release: String?) async throws -> FeedCreatorsPage {
        try await service.creatorDiscovery(query: query, cursor: cursor, release: release)
    }
    static func cached(in cache: FeedCache?, query: CreatorQuery) async throws -> FeedCreatorsPage? {
        try await cache?.creators(q: "discovery-v1\n" + query.cacheKey)
    }
    static func save(_ page: FeedCreatorsPage, in cache: FeedCache, query: CreatorQuery, now: Date) async throws {
        try await cache.store(page, q: "discovery-v1\n" + query.cacheKey)
    }
}
typealias CreatorDiscoveryStore = PagedFeedStore<CreatorDiscoverySource>

extension FeedServing {
    // Legacy fixture services remain usable; production implements the scoped API.
    func creatorDiscovery(query: CreatorQuery, cursor: String?, release: String?) async throws -> FeedCreatorsPage {
        try await creators(q: query.q, cursor: cursor, release: release)
    }
}
