import XCTest
import CryptoKit
@testable import Prompix

@MainActor final class LanguagePackSyncTests: XCTestCase {
    private var directory: URL!
    override func setUp() async throws { directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString) }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: directory) }

    private func cache() -> LanguagePackCache { LanguagePackCache(directory: directory) }
    private func session(_ fixture: SyncFixture) throws -> (URLSession, LanguageSyncServer) {
        let server = try LanguageSyncServer(fixture), token = LanguageSyncServers.shared.add(server)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LanguageSyncProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Prompix-Language-Test": token]
        return (URLSession(configuration: configuration), server)
    }
    private func edition(_ fixture: SyncFixture, locales: [String]) throws -> LanguagePackEdition {
        try LanguagePackEdition(manifestBytes: fixture.manifest, baseBytes: fixture.base,
                                localeBytes: Dictionary(uniqueKeysWithValues: locales.map { ($0, fixture.locales[$0]!) }))
    }

    func testFirstDownloadRequestsOnlyManifestBaseAndExactLocaleWithCombinedProgress() async throws {
        let fixture = try SyncFixture(), manifest = try LanguagePackCatalog.verifyManifest(fixture.manifest)
        let (session, server) = try session(fixture), samples = LanguageSyncProgress()
        defer { session.invalidateAndCancel() }
        let prepared = try await CatalogSync.prepareLanguagePacks(requestedLocales: ["ja", "ja"], cache: cache(), session: session) { samples.append($0) }
        XCTAssertEqual(server.paths, ["/v2/latest.json", manifest.base.url.path, manifest.locales["ja"]!.url.path])
        XCTAssertEqual(Set(prepared.localeBytes.keys), ["ja"])
        XCTAssertEqual(prepared.baseBytes, fixture.base)
        XCTAssertEqual(prepared.localeBytes["ja"], fixture.locales["ja"])
        XCTAssertEqual(Set(prepared.catalog.prompts[0].localization!.translations.keys), ["ja"])
        let total = fixture.base.count + fixture.locales["ja"]!.count
        XCTAssertEqual(samples.values.last, CatalogDownloadProgress(receivedBytes: total, totalBytes: total))
        XCTAssertEqual(samples.values.map(\.receivedBytes), samples.values.map(\.receivedBytes).sorted())
        XCTAssertTrue(samples.values.allSatisfy { $0.totalBytes == nil || $0.receivedBytes <= $0.totalBytes! })
        XCTAssertNil(try cache().readIndex(), "Preparation must not activate or write an index")
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appending(path: "v2-artifacts").path))
    }

    func testSameVersionLanguageSwitchDownloadsOnlyNewPackAndRetainsPreviouslyVerifiedLanguage() async throws {
        let fixture = try SyncFixture(), manifest = try LanguagePackCatalog.verifyManifest(fixture.manifest), cache = cache()
        let first = try cache.stage(edition(fixture, locales: ["ja"])).index
        let (session, server) = try session(fixture), samples = LanguageSyncProgress()
        defer { session.invalidateAndCancel() }
        let prepared = try await CatalogSync.prepareLanguagePacks(requestedLocales: ["fr"], cache: cache, active: first,
                                                                  session: session) { samples.append($0) }
        XCTAssertEqual(server.paths, ["/v2/latest.json", manifest.locales["fr"]!.url.path])
        XCTAssertEqual(Set(prepared.localeBytes.keys), ["ja", "fr"])
        XCTAssertEqual(prepared.catalog.version, manifest.version)
        XCTAssertNil(prepared.catalog.prompts[0].localization!.translations["en"])
        XCTAssertEqual(samples.values.last?.receivedBytes, fixture.locales["fr"]!.count)
    }

    func testOfflineCachedLanguageUsesActiveManifestWithoutAnyNetworkRequest() async throws {
        let fixture = try SyncFixture(), cache = cache(), original = try edition(fixture, locales: ["ja", "fr"])
        let index = try cache.stage(original).index
        let (session, server) = try session(fixture)
        defer { session.invalidateAndCancel() }
        let prepared = try await CatalogSync.prepareLanguagePacks(requestedLocales: ["ja"], cache: cache, active: index,
                                                                  checkLatest: false, session: session)
        XCTAssertEqual(server.paths, [])
        XCTAssertEqual(prepared.manifestBytes, fixture.manifest)
        XCTAssertEqual(prepared.catalog.prompts, original.catalog.prompts)
        XCTAssertEqual(Set(prepared.localeBytes.keys), ["ja", "fr"])
    }

    func testUnsupportedOrUnadvertisedLanguagesUseOriginalsWithoutEnglishOrOtherPackDownloads() async throws {
        var fixture = try SyncFixture()
        try fixture.restrictLocales(to: ["ja"])
        let manifest = try LanguagePackCatalog.verifyManifest(fixture.manifest)
        let (session, server) = try session(fixture)
        defer { session.invalidateAndCancel() }
        let prepared = try await CatalogSync.prepareLanguagePacks(requestedLocales: ["en", "en-US", "JA", "xx", ""], cache: cache(), session: session)
        XCTAssertEqual(server.paths, ["/v2/latest.json", manifest.base.url.path])
        XCTAssertTrue(prepared.localeBytes.isEmpty)
        XCTAssertTrue(prepared.catalog.prompts.compactMap(\.localization).allSatisfy { $0.translations.isEmpty })
    }

    func testMissingOrCorruptCachedRequestedPackIsRefetchedWithoutWritingPreparedBytes() async throws {
        for corrupt in [false, true] {
            let root = directory.appending(path: UUID().uuidString), cache = LanguagePackCache(directory: root)
            let fixture = try SyncFixture(), manifest = try LanguagePackCatalog.verifyManifest(fixture.manifest)
            let index = try cache.stage(edition(fixture, locales: ["ja"])).index
            let path = root.appending(path: "v2-artifacts/\(manifest.locales["ja"]!.sha256).json")
            if corrupt { try Data(repeating: 0, count: fixture.locales["ja"]!.count).write(to: path) }
            else { try FileManager.default.removeItem(at: path) }
            let (session, server) = try session(fixture)
            defer { session.invalidateAndCancel() }
            let prepared = try await CatalogSync.prepareLanguagePacks(requestedLocales: ["ja"], cache: cache, active: index,
                                                                      checkLatest: false, session: session)
            XCTAssertEqual(server.paths, [manifest.locales["ja"]!.url.path])
            XCTAssertEqual(prepared.localeBytes["ja"], fixture.locales["ja"])
            if corrupt { XCTAssertEqual(try Data(contentsOf: path), Data(repeating: 0, count: fixture.locales["ja"]!.count)) }
            else { XCTAssertFalse(FileManager.default.fileExists(atPath: path.path)) }
        }
    }

    func testCorruptCachedBaseIsRefetchedWhileExactCachedLanguagePackIsReused() async throws {
        let fixture = try SyncFixture(), manifest = try LanguagePackCatalog.verifyManifest(fixture.manifest), cache = cache()
        let index = try cache.stage(edition(fixture, locales: ["ja"])).index
        let path = directory.appending(path: "v2-artifacts/\(manifest.base.sha256).json")
        try Data("broken".utf8).write(to: path)
        let (session, server) = try session(fixture)
        defer { session.invalidateAndCancel() }
        let prepared = try await CatalogSync.prepareLanguagePacks(requestedLocales: ["ja"], cache: cache, active: index,
                                                                  checkLatest: false, session: session)
        XCTAssertEqual(server.paths, [manifest.base.url.path])
        XCTAssertEqual(prepared.localeBytes["ja"], fixture.locales["ja"])
        XCTAssertEqual(try Data(contentsOf: path), Data("broken".utf8))
    }

    func testSameVersionChangedLocaleHashCannotReuseOlderCachedTranslation() async throws {
        let fixture = try SyncFixture(), cache = cache(), index = try cache.stage(edition(fixture, locales: ["ja"])).index
        var changed = fixture
        try changed.changeJapaneseTitle()
        let manifest = try LanguagePackCatalog.verifyManifest(changed.manifest), (session, server) = try session(changed)
        defer { session.invalidateAndCancel() }
        let prepared = try await CatalogSync.prepareLanguagePacks(requestedLocales: ["ja"], cache: cache, active: index, session: session)
        XCTAssertEqual(server.paths, ["/v2/latest.json", manifest.locales["ja"]!.url.path])
        XCTAssertEqual(prepared.localeBytes["ja"], changed.locales["ja"])
        XCTAssertNotEqual(prepared.localeBytes["ja"], fixture.locales["ja"])
    }

    func testMissingCorruptAndPartialRequestedPacksFailWithoutFallbackOrCacheMutation() async throws {
        for failure in ["missing", "checksum", "partial"] {
            let fixture = try SyncFixture(), manifest = try LanguagePackCatalog.verifyManifest(fixture.manifest)
            let (session, server) = try session(fixture)
            defer { session.invalidateAndCancel() }
            let path = manifest.locales["ja"]!.url.path
            if failure == "missing" { server.set(path, .init(bytes: Data(), status: 404)) }
            if failure == "partial" { server.set(path, .init(bytes: fixture.locales["ja"]!, status: 206)) }
            if failure == "checksum" { server.set(path, .init(bytes: Data(repeating: 32, count: fixture.locales["ja"]!.count))) }
            do {
                _ = try await CatalogSync.prepareLanguagePacks(requestedLocales: ["ja"], cache: cache(), session: session)
                XCTFail("Expected \(failure) to reject the complete prepared edition")
            } catch { }
            XCTAssertEqual(server.paths, ["/v2/latest.json", manifest.base.url.path, path])
            XCTAssertFalse(server.paths.contains { $0.contains("/v1/") || $0.hasSuffix("/en.json") })
            XCTAssertNil(try cache().readIndex())
        }
    }

    func testDecodedManifestAndArtifactLimitsIgnoreCompressedAdvertisedLength() async throws {
        for target in ["manifest", "base", "ja"] {
            let fixture = try SyncFixture(), manifest = try LanguagePackCatalog.verifyManifest(fixture.manifest)
            let (session, server) = try session(fixture)
            defer { session.invalidateAndCancel() }
            let path = target == "manifest" ? "/v2/latest.json" : target == "base" ? manifest.base.url.path : manifest.locales["ja"]!.url.path
            let maximum = target == "manifest" ? LanguagePackCatalog.manifestByteLimit : target == "base" ? manifest.base.byteCount : manifest.locales["ja"]!.byteCount
            server.set(path, .init(bytes: Data(repeating: 32, count: maximum + 1), headers: ["Content-Encoding": "gzip", "Content-Length": "1"]))
            do {
                _ = try await CatalogSync.prepareLanguagePacks(requestedLocales: ["ja"], cache: cache(), session: session)
                XCTFail("Decoded \(target) overflow must fail")
            } catch SyncError.tooLarge { }
            catch { XCTFail("Unexpected overflow error: \(error)") }
            XCTAssertNil(try cache().readIndex())
        }
    }

    func testCompressedWireLengthDoesNotRejectAValidDecodedArtifact() async throws {
        let fixture = try SyncFixture(), manifest = try LanguagePackCatalog.verifyManifest(fixture.manifest)
        let (session, server) = try session(fixture)
        defer { session.invalidateAndCancel() }
        server.set(manifest.base.url.path, .init(bytes: fixture.base,
                                               headers: ["Content-Encoding": "gzip", "Content-Length": String(fixture.base.count + 100)]))
        let prepared = try await CatalogSync.prepareLanguagePacks(requestedLocales: [], cache: cache(), session: session)
        XCTAssertEqual(prepared.baseBytes, fixture.base)
        XCTAssertEqual(server.paths, ["/v2/latest.json", manifest.base.url.path])
    }

    func testCancellationStopsTheOutstandingDownloadAndDoesNotPrepareOrWriteAnEdition() async throws {
        let fixture = try SyncFixture(), (session, server) = try session(fixture)
        defer { session.invalidateAndCancel() }
        server.set("/v2/latest.json", .init(bytes: fixture.manifest, suspended: true))
        let cache = cache()
        let task = Task { try await CatalogSync.prepareLanguagePacks(requestedLocales: ["ja"], cache: cache, session: session) }
        for _ in 0..<100 where server.paths.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(server.paths, ["/v2/latest.json"])
        task.cancel()
        do { _ = try await task.value; XCTFail("Cancelled preparation must not succeed") }
        catch is CancellationError { }
        catch let error as URLError { XCTAssertEqual(error.code, .cancelled) }
        XCTAssertEqual(server.paths, ["/v2/latest.json"])
        XCTAssertNil(try cache.readIndex())
    }

    func testExactImmutableResponseURLsRejectSameHostPathAndQueryChanges() async throws {
        for redirected in ["https://api.prompix.dev/another/base.json", "https://api.prompix.dev/v2/latest.json?other=1", "https://example.com/v2/latest.json"] {
            let fixture = try SyncFixture(), (session, server) = try session(fixture)
            defer { session.invalidateAndCancel() }
            server.set("/v2/latest.json", .init(bytes: fixture.manifest, responseURL: URL(string: redirected)!))
            do {
                _ = try await CatalogSync.prepareLanguagePacks(requestedLocales: [], cache: cache(), session: session)
                XCTFail("A different response URL must fail")
            } catch SyncError.invalidResponse { }
            catch { XCTFail("Unexpected redirect error: \(error)") }
            XCTAssertEqual(server.paths, ["/v2/latest.json"])
        }
    }

    func testHTTPRedirectCannotChangeAV2ArtifactPathOnTheSameHost() async throws {
        let fixture = try SyncFixture(), manifest = try LanguagePackCatalog.verifyManifest(fixture.manifest)
        let (session, server) = try session(fixture)
        defer { session.invalidateAndCancel() }
        server.set(manifest.base.url.path, .init(bytes: Data(), redirect: URL(string: "https://api.prompix.dev/another/base.json")!))
        do {
            _ = try await CatalogSync.prepareLanguagePacks(requestedLocales: ["ja"], cache: cache(), session: session)
            XCTFail("Same-host redirects must not change immutable artifact identity")
        } catch SyncError.invalidResponse { }
        catch { XCTFail("Unexpected redirect error: \(error)") }
        XCTAssertEqual(server.paths, ["/v2/latest.json", manifest.base.url.path])
    }
}

private struct SyncFixture {
    var manifest: Data
    var base: Data
    var locales: [String: Data]
    init() throws {
        struct Strings: Decodable { let manifest: String; let base: String; let locales: [String: String] }
        let url = try XCTUnwrap(Bundle(for: LanguagePackSyncTests.self).url(forResource: "language-pack-fixture", withExtension: "json"))
        let strings = try JSONDecoder().decode(Strings.self, from: Data(contentsOf: url))
        manifest = Data(strings.manifest.utf8); base = Data(strings.base.utf8); locales = strings.locales.mapValues { Data($0.utf8) }
    }
    mutating func restrictLocales(to allowed: Set<String>) throws {
        var original = try object(base), items = original["prompts"] as! [[String: Any]]
        for index in items.indices {
            if var localization = items[index]["localization"] as? [String: Any] {
                localization["availableLanguages"] = (localization["availableLanguages"] as! [String]).filter { allowed.contains($0) }
                items[index]["localization"] = localization
            }
        }
        original["prompts"] = items; base = try encode(original)
        locales = try Dictionary(uniqueKeysWithValues: locales.filter { allowed.contains($0.key) }.map { locale, bytes in
            var pack = try object(bytes); pack["baseSha256"] = digest(base)
            return (locale, try encode(pack))
        })
        try updateManifest()
    }
    mutating func changeJapaneseTitle() throws {
        var pack = try object(locales["ja"]!), entries = pack["entries"] as! [[String: Any]], content = entries[0]["content"] as! [String: Any]
        content["title"] = "Updated original test translation"; entries[0]["content"] = content; pack["entries"] = entries
        locales["ja"] = try encode(pack)
        try updateManifest()
    }
    private mutating func updateManifest() throws {
        var value = try object(manifest), descriptor = value["base"] as! [String: Any], descriptors = value["locales"] as! [String: [String: Any]]
        descriptor["sha256"] = digest(base); descriptor["byteCount"] = base.count; value["base"] = descriptor
        descriptors = descriptors.filter { locales[$0.key] != nil }
        for (locale, bytes) in locales { descriptors[locale]!["sha256"] = digest(bytes); descriptors[locale]!["byteCount"] = bytes.count }
        value["locales"] = descriptors; manifest = try encode(value)
    }
    private func object(_ bytes: Data) throws -> [String: Any] { try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any]) }
    private func encode(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) }
    private func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
}

private struct LanguageSyncReply: Sendable {
    var bytes: Data
    var status = 200
    var headers: [String: String] = [:]
    var responseURL: URL? = nil
    var suspended = false
    var redirect: URL? = nil
}
private final class LanguageSyncServer: @unchecked Sendable {
    private let lock = NSLock()
    private var replies: [String: LanguageSyncReply]
    private var requests: [String] = []
    init(_ fixture: SyncFixture) throws {
        let manifest = try LanguagePackCatalog.verifyManifest(fixture.manifest)
        replies = ["/v2/latest.json": .init(bytes: fixture.manifest), manifest.base.url.path: .init(bytes: fixture.base)]
        for (locale, bytes) in fixture.locales { replies[manifest.locales[locale]!.url.path] = .init(bytes: bytes) }
    }
    var paths: [String] { lock.withLock { requests } }
    func set(_ path: String, _ reply: LanguageSyncReply) { lock.withLock { replies[path] = reply } }
    func response(for request: URLRequest) -> LanguageSyncReply {
        lock.withLock { requests.append(request.url!.path); return replies[request.url!.path] ?? .init(bytes: Data(), status: 404) }
    }
}
private final class LanguageSyncServers: @unchecked Sendable {
    static let shared = LanguageSyncServers()
    private let lock = NSLock()
    private var values: [String: LanguageSyncServer] = [:]
    func add(_ server: LanguageSyncServer) -> String { lock.withLock { let key = UUID().uuidString; values[key] = server; return key } }
    func get(_ key: String) -> LanguageSyncServer? { lock.withLock { values[key] } }
}
private final class LanguageSyncProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let token = request.value(forHTTPHeaderField: "X-Prompix-Language-Test"), let server = LanguageSyncServers.shared.get(token), let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return
        }
        let reply = server.response(for: request)
        if let redirect = reply.redirect {
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: redirect), redirectResponse: HTTPURLResponse(url: url, statusCode: 302, httpVersion: nil, headerFields: ["Location": redirect.absoluteString])!)
            return
        }
        var headers = reply.headers
        if headers["Content-Length"] == nil { headers["Content-Length"] = String(reply.bytes.count) }
        let response = HTTPURLResponse(url: reply.responseURL ?? url, statusCode: reply.status, httpVersion: nil, headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if reply.suspended { return }
        for offset in stride(from: 0, to: reply.bytes.count, by: 512) {
            client?.urlProtocol(self, didLoad: reply.bytes.subdata(in: offset..<min(offset + 512, reply.bytes.count)))
        }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
private final class LanguageSyncProgress: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [CatalogDownloadProgress] = []
    var values: [CatalogDownloadProgress] { lock.withLock { storage } }
    func append(_ value: CatalogDownloadProgress) { lock.withLock { storage.append(value) } }
}
