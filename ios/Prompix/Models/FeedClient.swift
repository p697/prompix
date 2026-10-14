import Foundation

protocol FeedServing: Sendable {
    func page(query: FeedQuery, cursor: String?, release: String?) async throws -> FeedPage
    func detail(id: String, revision: String?, locale: String) async throws -> FeedDetail
    func creators(q: String, cursor: String?, release: String?) async throws -> FeedCreatorsPage
    func browse(locale: String) async throws -> FeedBrowse
    func state() async throws -> FeedState
    func removals(after: String) async throws -> FeedRemovals
}

struct FeedClient: FeedServing {
    static let pageSize = 30
    let session: URLSession
    private let gate = FeedRequestGate()
    init(session: URLSession? = nil) {
        if let session { self.session = session }
        else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.urlCache = nil
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            configuration.timeoutIntervalForRequest = 20
            configuration.timeoutIntervalForResource = 30
            configuration.httpMaximumConnectionsPerHost = 4
            #if DEBUG && targetEnvironment(simulator)
            if ProcessInfo.processInfo.arguments.contains("--simulate-network-failure") {
                configuration.protocolClasses = [SimulatorNetworkFailure.self]
            }
            #endif
            self.session = URLSession(configuration: configuration)
        }
    }
    func page(query: FeedQuery, cursor: String? = nil, release: String? = nil) async throws -> FeedPage {
        let query = try query.validated()
        let parameters = try pagination(query.parameters, cursor: cursor)
        let page: FeedPage = try await fetch("feed", parameters: parameters)
        return try page.validated(locale: query.locale, limit: Self.pageSize, release: release)
    }
    func detail(id: String, revision: String? = nil, locale: String) async throws -> FeedDetail {
        guard FeedValidation.id(id), FeedValidation.locale(locale), revision == nil || FeedValidation.revision(revision!) else { throw FeedError.invalidQuery }
        var parameters = [URLQueryItem(name: "locale", value: locale)]
        if let revision { parameters.append(URLQueryItem(name: "revision", value: revision)) }
        let detail: FeedDetail = try await fetch("contents/" + id, parameters: parameters, maximum: 2_000_000)
        return try detail.validated(id: id, revision: revision, locale: locale)
    }
    func creators(q: String = "", cursor: String? = nil, release: String? = nil) async throws -> FeedCreatorsPage {
        let query = try FeedQuery(q: q).validated()
        let parameters = try pagination([URLQueryItem(name: "q", value: query.q)], cursor: cursor)
        let page: FeedCreatorsPage = try await fetch("creators", parameters: parameters)
        return try page.validated(limit: Self.pageSize, release: release)
    }
    func browse(locale: String) async throws -> FeedBrowse {
        guard FeedValidation.locale(locale) else { throw FeedError.invalidQuery }
        let value: FeedBrowse = try await fetch("browse", parameters: [URLQueryItem(name: "locale", value: locale)])
        return try value.validated(locale: locale)
    }
    func state() async throws -> FeedState {
        let value: FeedState = try await fetch("state", maximum: 16_384)
        return try value.validated()
    }
    func removals(after: String) async throws -> FeedRemovals {
        guard FeedValidation.sequence(after) != nil else { throw FeedError.invalidQuery }
        let value: FeedRemovals = try await fetch("removals", parameters: [URLQueryItem(name: "after", value: after)], maximum: 150_000)
        return try value.validated(after: after)
    }
    private func pagination(_ parameters: [URLQueryItem], cursor: String?) throws -> [URLQueryItem] {
        guard FeedValidation.cursor(cursor) else { throw FeedError.invalidQuery }
        var values = parameters + [URLQueryItem(name: "limit", value: String(Self.pageSize))]
        if let cursor { values.append(URLQueryItem(name: "cursor", value: cursor)) }
        return values
    }
    private func fetch<T: Decodable & Sendable>(_ path: String, parameters: [URLQueryItem] = [], maximum: Int = 1_000_000) async throws -> T {
        var components = URLComponents(string: "https://api.prompix.dev/v3/" + path)!
        if !parameters.isEmpty { components.queryItems = parameters }
        guard let url = components.url, url.absoluteString.utf8.count <= 4096 else { throw FeedError.invalidQuery }
        try await gate.check()
        let data: Data
        do { data = try await CatalogSync.fetch(url, maximum: maximum, session: session, requiresExactURL: true, timeout: 20, validateResponse: { response in
            let retry = response.value(forHTTPHeaderField: "Retry-After").flatMap(TimeInterval.init)
            switch response.statusCode {
            case 200:
                guard response.mimeType?.lowercased() == "application/json" else { throw FeedError.invalidResponse }
            case 400: throw FeedError.invalidQuery
            case 404: throw FeedError.notFound
            case 410: throw path == "feed" || path == "creators" ? FeedError.snapshotExpired : FeedError.removed
            case 429: throw FeedError.rateLimited(min(300, max(1, retry ?? 60)))
            case 500...599: throw FeedError.unavailable(min(300, max(1, retry ?? 5)))
            default: throw FeedError.invalidResponse
            }
        }) } catch {
            if case let FeedError.rateLimited(seconds) = error { await gate.block(for: seconds) }
            throw error
        }
        try Task.checkCancellation()
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw FeedError.invalidResponse }
    }
}


/// A server rate limit applies across discovery, search, details and metadata.
/// Switching screens must not bypass Retry-After or create a retry storm.
actor FeedRequestGate {
    private var blockedUntil: Date?
    func check(now: Date = Date()) throws {
        if let blockedUntil, blockedUntil > now { throw FeedError.rateLimited(blockedUntil.timeIntervalSince(now)) }
    }
    func block(for seconds: TimeInterval, now: Date = Date()) {
        blockedUntil = max(blockedUntil ?? now, now.addingTimeInterval(seconds))
    }
}
