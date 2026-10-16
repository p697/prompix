import XCTest
@testable import Prompix

@MainActor final class FeedClientTests: XCTestCase {
    func testLiveFeedContractsAndRequestedDetail() async throws {
        guard ProcessInfo.processInfo.environment["PROMPIX_LIVE_FEED"] == "1" else { throw XCTSkip("Explicit live API verification only") }
        let client = FeedClient()
        defer { client.session.invalidateAndCancel() }
        let page = try await client.page(query: FeedQuery(locale: "zh-Hans"))
        let card = try XCTUnwrap(page.items.first)
        let detail = try await client.detail(id: card.id, revision: card.revision, locale: "zh-Hans")
        XCTAssertEqual(detail.item.content(in: "zh-Hans").title, card.title)
        XCTAssertFalse(detail.item.prompt.isEmpty)
        let state = try await client.state()
        XCTAssertGreaterThanOrEqual(state.count, page.items.count)
        let creators = try await client.creators()
        XCTAssertFalse(creators.items.isEmpty)
        _ = try await client.removals(after: "0")
        let browse = try await client.browse(locale: "zh-Hans")
        XCTAssertEqual(browse.collections.count, 10)
        XCTAssertGreaterThan(browse.models.count, 0)
        let topic = try XCTUnwrap(browse.collections.first { $0.count > 0 })
        let collectionPage = try await client.page(query: FeedQuery(locale: "zh-Hans", collection: topic.id))
        XCTAssertFalse(collectionPage.items.isEmpty)
    }
    func testLatestQueryHasSeparateCacheIdentityAndKeepsLegacyQueryDecodable() async throws {
        let legacy = FeedQuery(locale: "original")
        let decoded = try JSONDecoder().decode(FeedQuery.self, from: JSONEncoder().encode(legacy))
        XCTAssertNil(decoded.sort)
        let latest = try FeedQuery(locale: "original", sort: "latest").validated()
        XCTAssertNotEqual(latest, legacy)
        XCTAssertEqual(latest.parameters.first { $0.name == "sort" }?.value, "latest")
        let discovery = try FeedQuery(locale: "original", sort: "discovery").validated()
        XCTAssertNotEqual(discovery, latest)
        XCTAssertEqual(discovery.parameters.first { $0.name == "sort" }?.value, "discovery")
        XCTAssertThrowsError(try FeedQuery(q: "search", sort: "discovery").validated())
        XCTAssertThrowsError(try FeedQuery(sort: "untrusted").validated())
        let (client, server) = connection()
        server.set("/v3/feed", bytes: try FeedFixture.page())
        _ = try await client.page(query: latest)
        XCTAssertTrue(server.urls[0].query?.contains("sort=latest") == true)
    }
    func testCreatorDiscoverySendsServerFiltersAndValidatesPreviews() async throws {
        let (client, server) = connection()
        let creator = Prompt.Creator(id: "test-author", platform: "web", displayName: "Test", profileURL: URL(string: "https://example.com/test")!)
        let page = FeedCreatorsPage(schemaVersion: 3, release: FeedFixture.release, items: [.init(creator: creator, count: 1)], nextCursor: nil)
        server.set("/v3/creators", bytes: try JSONEncoder().encode(page))
        _ = try await client.creatorDiscovery(query: CreatorQuery(q: " ＣＡＦÉ ", kind: "video", sort: .name))
        let parameters = try XCTUnwrap(URLComponents(url: server.urls[0], resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(parameters.first { $0.name == "q" }?.value, "cafe")
        XCTAssertEqual(parameters.first { $0.name == "kind" }?.value, "video")
        XCTAssertEqual(parameters.first { $0.name == "sort" }?.value, "name")
        XCTAssertEqual(parameters.first { $0.name == "limit" }?.value, "30")
    }
    private func connection() -> (FeedClient, FeedTestServer) {
        let server = FeedTestServer(), token = UUID().uuidString
        FeedTestServers.shared.insert(server, token: token)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FeedTestProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Prompix-Feed-Test": token]
        let client = FeedClient(session: URLSession(configuration: configuration))
        addTeardownBlock { client.session.invalidateAndCancel(); FeedTestServers.shared.remove(token) }
        return (client, server)
    }

    func testCardRequestIsBoundedEncodedAndDoesNotDownloadAnyDetail() async throws {
        let (client, server) = connection()
        server.set("/v3/feed", bytes: try FeedFixture.page())
        let query = FeedQuery(locale: "original", kind: "text", tag: "R&D + design", model: "Model / A", q: " ＣＡＦÉ  ")
        let page = try await client.page(query: query)
        XCTAssertEqual(page.items.count, 1)
        XCTAssertEqual(server.urls.count, 1)
        let parameters = try XCTUnwrap(URLComponents(url: server.urls[0], resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(parameters.first { $0.name == "q" }?.value, "cafe")
        XCTAssertEqual(parameters.first { $0.name == "tag" }?.value, query.tag)
        XCTAssertEqual(parameters.first { $0.name == "limit" }?.value, "30")
        let card = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(page.items[0])) as? [String: Any])
        XCTAssertNil(card["prompt"]); XCTAssertNil(card["source"]); XCTAssertNil(card["skill"])
    }

    func testDetailBindsIdentityRevisionAndExactLocalePreservingWhitespace() async throws {
        let (client, server) = connection(), item = FeedFixture.prompt()
        server.set("/v3/contents/test-item", bytes: try FeedFixture.detail(item))
        let detail = try await client.detail(id: item.id, revision: FeedFixture.revision, locale: "original")
        XCTAssertEqual(detail.item.prompt, "  First-party text\nKeep spacing.\n")
        XCTAssertEqual(detail.item, item)
        for change in ["id", "revision", "fingerprint", "extra-locale"] {
            var raw = try XCTUnwrap(JSONSerialization.jsonObject(with: FeedFixture.detail(item)) as? [String: Any])
            if change == "revision" { raw["revision"] = String(repeating: "b", count: 64) }
            else {
                var changed = try XCTUnwrap(raw["item"] as? [String: Any])
                if change == "id" { changed["id"] = "wrong-item" }
                else {
                    changed["localization"] = ["sourceLanguage": "en", "sourceFingerprint": change == "fingerprint" ? String(repeating: "0", count: 64) : LanguagePackCatalog.sourceFingerprint(item),
                        "translations": change == "extra-locale" ? ["ja": ["title": "日本語", "summary": "概要", "prompt": "本文", "example": "例", "previewLabel": "表示"]] : [:]]
                }
                raw["item"] = changed
            }
            server.set("/v3/contents/test-item", bytes: try JSONSerialization.data(withJSONObject: raw))
            do { _ = try await client.detail(id: item.id, revision: FeedFixture.revision, locale: "original"); XCTFail(change) }
            catch { }
        }
    }

    func testPageRejectsDuplicatesWrongSnapshotUntrustedMediaAndOverflow() async throws {
        let (client, server) = connection()
        for failure in ["duplicate", "snapshot", "media", "count", "bytes", "redirect", "mime"] {
            var raw = try XCTUnwrap(JSONSerialization.jsonObject(with: FeedFixture.page()) as? [String: Any])
            var cards = try XCTUnwrap(raw["items"] as? [[String: Any]])
            if failure == "duplicate" { cards.append(cards[0]) }
            if failure == "count" { cards = Array(repeating: cards[0], count: 31) }
            if failure == "media" { cards[0]["media"] = ["imageURL": "https://untrusted.example/image.jpg"] }
            if failure == "snapshot" { raw["release"] = "feed-" + String(repeating: "b", count: 64) }
            raw["items"] = cards
            server.set("/v3/feed", bytes: failure == "bytes" ? Data(repeating: 32, count: 1_000_001) : try JSONSerialization.data(withJSONObject: raw),
                       headers: failure == "mime" ? ["Content-Type": "text/html"] : [:],
                       responseURL: failure == "redirect" ? URL(string: "https://untrusted.example/v3/feed") : nil)
            do { _ = try await client.page(query: FeedQuery(locale: "original"), release: FeedFixture.release); XCTFail(failure) }
            catch { }
        }
    }

    func testHTTPFailureTypesRetainRetryAndDoNotSilentlyUseAnotherEndpoint() async throws {
        for (status, expected) in [(400, FeedError.invalidQuery), (404, .notFound), (410, .snapshotExpired), (429, .rateLimited(300)), (503, .unavailable(300))] {
            let (client, server) = connection()
            server.set("/v3/feed", bytes: Data("{}".utf8), status: status, headers: ["Retry-After": "99999"])
            do { _ = try await client.page(query: FeedQuery()); XCTFail("HTTP \(status)") }
            catch let error as FeedError { XCTAssertEqual(error, expected) }
        }
        let (client, server) = connection()
        server.set("/v3/contents/test-item", bytes: Data("{}".utf8), status: 410)
        do { _ = try await client.detail(id: "test-item", locale: "original"); XCTFail("Removed detail") }
        catch let error as FeedError { XCTAssertEqual(error, .removed) }
        XCTAssertEqual(server.urls.count, 1)
        XCTAssertTrue(server.urls.allSatisfy { $0.path.hasPrefix("/v3/") })
    }

    func testRateLimitIsSharedAcrossEndpointsAndExpires() async throws {
        let (client, server) = connection()
        server.set("/v3/feed", bytes: Data("{}".utf8), status: 429, headers: ["Retry-After": "60"])
        do { _ = try await client.page(query: FeedQuery()); XCTFail() } catch { }
        do { _ = try await client.state(); XCTFail() }
        catch let FeedError.rateLimited(seconds) { XCTAssertGreaterThan(seconds, 50) }
        XCTAssertEqual(server.urls.count, 1)
        let gate = FeedRequestGate(), now = Date()
        await gate.block(for: 60, now: now)
        do { try await gate.check(now: now.addingTimeInterval(59)); XCTFail() } catch { }
        try await gate.check(now: now.addingTimeInterval(61))
    }

    func testInvalidQueryNeverStartsNetworkAndCancellationReleasesDownload() async throws {
        let (client, server) = connection()
        for q in ["bad\nquery", String(repeating: "a", count: 121), "one two three four five six seven eight nine"] {
            do { _ = try await client.page(query: FeedQuery(q: q)); XCTFail(q) }
            catch let error as FeedError { XCTAssertEqual(error, .invalidQuery) }
        }
        XCTAssertTrue(server.urls.isEmpty)
        server.set("/v3/feed", bytes: try FeedFixture.page(), delay: 2)
        let task = Task { try await client.page(query: FeedQuery(locale: "original")) }
        try await Task.sleep(for: .milliseconds(50)); task.cancel()
        do { _ = try await task.value; XCTFail("Cancelled task succeeded") }
        catch is CancellationError { }
        catch let error as URLError { XCTAssertEqual(error.code, .cancelled) }
    }

    func testRemovalCheckpointCannotSkipGoBackOrAcceptDuplicateIDs() throws {
        let valid = FeedRemovals(schemaVersion: 3, items: [.init(sequence: "3", id: "test-item")], nextAfter: "3", hasMore: false)
        XCTAssertEqual(try valid.validated(after: "1").nextAfter, "3")
        XCTAssertThrowsError(try valid.validated(after: "4"))
        XCTAssertThrowsError(try FeedRemovals(schemaVersion: 3, items: [], nextAfter: "4", hasMore: false).validated(after: "1"))
        XCTAssertThrowsError(try FeedRemovals(schemaVersion: 3, items: [], nextAfter: "1", hasMore: true).validated(after: "1"))
        XCTAssertThrowsError(try FeedRemovals(schemaVersion: 3, items: [.init(sequence: "3", id: "test-item"), .init(sequence: "4", id: "test-item")], nextAfter: "4", hasMore: false).validated(after: "1"))
    }
}

enum FeedFixture {
    static let revision = String(repeating: "a", count: 64)
    static let release = "feed-" + String(repeating: "c", count: 64)
    static func prompt() -> Prompt {
        Prompt(id: "test-item", kind: .text, title: "Synthetic title", summary: "First-party test content",
               prompt: "  First-party text\nKeep spacing.\n", example: "Example", tags: ["fixture"], model: "Test model", toolURL: nil,
               artwork: "text-editorial", previewLabel: "Preview", source: .init(name: "Prompix", url: nil, license: "Original", method: "Written for tests"), media: nil)
    }
    static func card(id: String = "test-item") -> FeedCard {
        FeedCard(id: id, revision: revision, kind: .text, contentType: "prompt", title: "Synthetic title", summary: "First-party test content",
                 tags: ["fixture"], model: "Test model", artwork: "text-editorial", previewLabel: "Preview", creator: nil, media: nil, cover: nil,
                 language: "original", availableLanguages: [])
    }
    static func page() throws -> Data {
        try JSONEncoder().encode(FeedPage(schemaVersion: 3, release: release, items: [card()], nextCursor: nil))
    }
    static func detail(_ item: Prompt) throws -> Data {
        try JSONEncoder().encode(FeedDetail(schemaVersion: 3, revision: revision, item: item, availableLanguages: []))
    }
}

private final class FeedTestServer: @unchecked Sendable {
    struct Reply { let bytes: Data; let status: Int; let headers: [String: String]; let responseURL: URL?; let delay: TimeInterval }
    private let lock = NSLock()
    private var responses: [String: Reply] = [:]
    private var requests: [URL] = []
    var urls: [URL] { lock.withLock { requests } }
    func set(_ path: String, bytes: Data, status: Int = 200, headers: [String: String] = [:], responseURL: URL? = nil, delay: TimeInterval = 0) {
        lock.withLock { responses[path] = Reply(bytes: bytes, status: status, headers: headers, responseURL: responseURL, delay: delay) }
    }
    func reply(_ url: URL) -> Reply? { lock.withLock { requests.append(url); return responses[url.path] } }
}
private final class FeedTestServers: @unchecked Sendable {
    static let shared = FeedTestServers()
    private let lock = NSLock()
    private var values: [String: FeedTestServer] = [:]
    func insert(_ server: FeedTestServer, token: String) { lock.withLock { values[token] = server } }
    func remove(_ token: String) { _ = lock.withLock { values.removeValue(forKey: token) } }
    func get(_ token: String) -> FeedTestServer? { lock.withLock { values[token] } }
}
private final class FeedTestProtocol: URLProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var pending: DispatchWorkItem?
    private var stopped = false
    override class func canInit(with request: URLRequest) -> Bool { request.value(forHTTPHeaderField: "X-Prompix-Feed-Test") != nil }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url, let token = request.value(forHTTPHeaderField: "X-Prompix-Feed-Test"),
              let reply = FeedTestServers.shared.get(token)?.reply(url) else {
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable)); return
        }
        let action = DispatchWorkItem { [weak self] in
            guard let self, !self.lock.withLock({ self.stopped }) else { return }
            let headers = ["Content-Type": "application/json"].merging(reply.headers) { _, new in new }
            let response = HTTPURLResponse(url: reply.responseURL ?? url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: headers)!
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: reply.bytes)
            self.client?.urlProtocolDidFinishLoading(self)
        }
        lock.withLock { pending = action }
        DispatchQueue.global().asyncAfter(deadline: .now() + reply.delay, execute: action)
    }
    override func stopLoading() { lock.withLock { stopped = true; pending?.cancel(); pending = nil } }
}
