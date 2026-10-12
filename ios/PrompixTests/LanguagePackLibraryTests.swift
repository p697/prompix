import XCTest
import CryptoKit
@testable import Prompix

@MainActor final class LanguagePackLibraryTests: XCTestCase {
    private var directory: URL!
    private var store: URL { directory.appending(path: "store") }
    private var catalogURL: URL { directory.appending(path: "bundle.json") }
    private let fullID = "fixture-all-languages"
    private let sparseID = "fixture-japanese"
    private var preferred: String { ContentLanguage.preferred }
    private var otherLocales: [String] { LanguagePackCatalog.supportedLocales.filter { $0 != preferred } }

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: directory) }

    private struct Fixture {
        let catalog: Catalog
        let manifest: Data
        let base: Data
        let locales: [String: Data]
        func edition(_ selected: Set<String> = []) throws -> LanguagePackEdition {
            try LanguagePackEdition(manifestBytes: manifest, baseBytes: base, localeBytes: locales.filter { selected.contains($0.key) })
        }
        var responses: [String: PackLibraryNetwork.Reply] {
            let prefix = "/releases/\(catalog.version)/v2"
            var result: [String: PackLibraryNetwork.Reply] = ["/v2/latest.json": .bytes(manifest), "\(prefix)/base.json": .bytes(base)]
            for (locale, bytes) in locales { result["\(prefix)/locales/\(locale).json"] = .bytes(bytes) }
            return result
        }
        func localePath(_ locale: String) -> String { "/releases/\(catalog.version)/v2/locales/\(locale).json" }
    }

    /// Derive every test release from the shared, original TypeScript fixture.
    /// Rehash deliberate edits so failures exercise Library policy, not invalid transport bytes.
    private func fixture(version: String = "edition-library-fixture", change: ((inout [String: Any]) -> Void)? = nil) throws -> Fixture {
        struct Source: Decodable { let catalog: String }
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "language-pack-fixture", withExtension: "json"))
        let source = try JSONDecoder().decode(Source.self, from: Data(contentsOf: url))
        var full = try object(Data(source.catalog.utf8))
        full["version"] = version
        change?(&full)
        var prompts = full["prompts"] as! [[String: Any]]
        for index in prompts.indices {
            if var localization = prompts[index]["localization"] as? [String: Any] {
                let prompt = try JSONDecoder().decode(Prompt.self, from: encode(prompts[index]))
                localization["sourceFingerprint"] = LanguagePackCatalog.sourceFingerprint(prompt)
                prompts[index]["localization"] = localization
            }
        }
        full["prompts"] = prompts
        let catalog = try JSONDecoder().decode(Catalog.self, from: encode(full)).validated()
        var original = full
        original["schemaVersion"] = 2
        original["prompts"] = prompts.map { item in
            var item = item
            if var localization = item["localization"] as? [String: Any] {
                let translations = localization.removeValue(forKey: "translations") as! [String: Any]
                localization["availableLanguages"] = LanguagePackCatalog.supportedLocales.filter { translations[$0] != nil }
                item["localization"] = localization
            }
            return item
        }
        let base = try encode(original), prefix = "https://api.prompix.dev/releases/\(version)/v2"
        var packs: [String: Data] = [:], descriptors: [String: Any] = [:]
        for locale in LanguagePackCatalog.supportedLocales {
            let entries: [[String: Any]] = prompts.compactMap { item in
                guard let localization = item["localization"] as? [String: Any],
                      let translations = localization["translations"] as? [String: Any], let content = translations[locale] else { return nil }
                return ["id": item["id"]!, "sourceFingerprint": localization["sourceFingerprint"]!, "content": content]
            }
            guard !entries.isEmpty else { continue }
            let bytes = try encode(["schemaVersion": 2, "version": version, "publishedAt": full["publishedAt"]!,
                "locale": locale, "baseSha256": digest(base), "entries": entries])
            packs[locale] = bytes
            descriptors[locale] = descriptor(bytes, url: "\(prefix)/locales/\(locale).json", count: entries.count)
        }
        let manifest = try encode(["schemaVersion": 2, "version": version, "publishedAt": full["publishedAt"]!, "count": prompts.count,
            "base": descriptor(base, url: "\(prefix)/base.json", count: prompts.count), "locales": descriptors])
        return Fixture(catalog: catalog, manifest: manifest, base: base, locales: packs)
    }
    private func object(_ bytes: Data) throws -> [String: Any] { try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any]) }
    private func encode(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) }
    private func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    private func descriptor(_ bytes: Data, url: String, count: Int) -> [String: Any] {
        ["url": url, "sha256": digest(bytes), "byteCount": bytes.count, "count": count]
    }
    private func makeLibrary(_ fixture: Fixture) throws -> Library {
        try JSONEncoder().encode(fixture.catalog).write(to: catalogURL, options: .atomic)
        return Library(directory: store, catalogURL: catalogURL)
    }
    private func prompt(_ library: Library, id: String? = nil) throws -> Prompt {
        try XCTUnwrap(library.prompts.first { $0.id == (id ?? fullID) })
    }
    private func storeBytes() throws -> [String: Data] {
        var result: [String: Data] = [:]
        for name in ["language-packs.json", "catalog.json", "favorites.json", "drafts.json", "creators.json"] {
            let file = store.appending(path: name)
            if FileManager.default.fileExists(atPath: file.path) { result[name] = try Data(contentsOf: file) }
        }
        return result
    }
    private func network(_ fixture: Fixture, holding paths: Set<String> = []) -> (PackLibraryNetwork, URLSession) {
        let network = PackLibraryNetwork(responses: fixture.responses, holding: paths)
        let identifier = PackLibraryProtocol.registry.insert(network)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PackLibraryProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Prompix-Pack-Library-Test": identifier]
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel(); PackLibraryProtocol.registry.remove(identifier) }
        return (network, session)
    }
    private func waitForRequest(_ network: PackLibraryNetwork, path: String, count: Int = 1) async throws {
        for _ in 0..<400 {
            if network.requests.filter({ $0 == path }).count >= count { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("The isolated session did not request \(path)")
        throw URLError(.timedOut)
    }

    func testV1MigrationRetainsFavoritesCreatorAndIndependentDraftBytes() async throws {
        let old = try fixture(version: "edition-old-v1"), next = try fixture()
        let library = try makeLibrary(old), saved = try prompt(library)
        XCTAssertTrue(library.toggle(saved)); XCTAssertTrue(library.toggleCreator(saved.creator!))
        XCTAssertTrue(library.saveDraft("Original personal edit 中文 🌙", for: saved))
        XCTAssertTrue(library.saveDraft("Japanese personal edit\n保持", for: saved, language: "ja"))
        let before = try storeBytes(), (remote, session) = network(next)

        await library.refresh(force: true, session: session)

        XCTAssertEqual(library.version, next.catalog.version)
        XCTAssertEqual(library.syncState, .current)
        XCTAssertEqual(Set(remote.requests), ["/v2/latest.json", "/releases/\(next.catalog.version)/v2/base.json", next.localePath(preferred)])
        XCTAssertEqual(try prompt(library).availableLanguages, [preferred])
        XCTAssertEqual(library.favorites, [saved])
        XCTAssertEqual(library.savedCreators, [saved.creator!])
        XCTAssertEqual(try storeBytes()["drafts.json"], before["drafts.json"])
        let reopened = Library(directory: store, catalogURL: catalogURL)
        XCTAssertEqual(reopened.version, next.catalog.version)
        XCTAssertEqual(reopened.favorites, [saved])
        XCTAssertEqual(reopened.drafts, library.drafts)
    }

    func testSameVersionLanguageSelectionDownloadsOnlyMissingRequestedPack() async throws {
        let fixture = try fixture(), library = try makeLibrary(fixture), locale = otherLocales[0]
        try library.installLanguagePacks(fixture.edition([preferred]))
        let item = try prompt(library), (remote, session) = network(fixture)
        XCTAssertEqual(library.advertisedLanguages(for: item), LanguagePackCatalog.supportedLocales)

        let success = await library.ensureLanguage(locale, for: item, session: session)

        XCTAssertTrue(success)
        XCTAssertEqual(remote.requests, [fixture.localePath(locale)])
        XCTAssertEqual(library.version, fixture.catalog.version)
        XCTAssertEqual(Set(try prompt(library).availableLanguages), [preferred, locale])
        XCTAssertEqual(try prompt(library).content(in: locale), fixture.catalog.prompts[0].content(in: locale))
    }

    func testCachedLocaleCanBeSelectedAfterRelaunchWithoutAnyNetworkRequest() async throws {
        let fixture = try fixture(), library = try makeLibrary(fixture), locale = otherLocales[0]
        try library.installLanguagePacks(fixture.edition([preferred, locale]))
        let reopened = Library(directory: store, catalogURL: catalogURL)
        XCTAssertEqual(try prompt(reopened).availableLanguages, [preferred], "Launch projects only the app language")
        let (remote, session) = network(fixture)
        remote.setFailureForAllRequests()

        let success = await reopened.ensureLanguage(locale, for: try prompt(reopened), session: session)

        XCTAssertTrue(success)
        XCTAssertTrue(remote.requests.isEmpty)
        XCTAssertEqual(Set(try prompt(reopened).availableLanguages), [preferred, locale])
    }

    func testHealthyUnchangedRefreshSucceedsWithoutAnyActiveOrPersonalStoreWrite() async throws {
        let fixture = try fixture(), initial = try makeLibrary(fixture)
        try initial.installLanguagePacks(fixture.edition([preferred]))
        let item = try prompt(initial)
        XCTAssertTrue(initial.toggle(item)); XCTAssertTrue(initial.toggleCreator(item.creator!))
        XCTAssertTrue(initial.saveDraft("Keep every byte of this personal edit", for: item, language: preferred))
        let before = try storeBytes()
        var attemptedWrites: [String] = []
        let library = Library(directory: store, catalogURL: catalogURL) { _, url in
            attemptedWrites.append(url.lastPathComponent)
            throw CocoaError(.fileWriteOutOfSpace)
        }
        let (remote, session) = network(fixture)

        await library.refresh(force: true, session: session)

        XCTAssertEqual(library.syncState, .current)
        XCTAssertFalse(library.isRefreshing); XCTAssertNil(library.syncMessage)
        XCTAssertTrue(attemptedWrites.isEmpty)
        XCTAssertEqual(remote.requests, ["/v2/latest.json"])
        XCTAssertEqual(try storeBytes(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.appending(path: "catalog-transaction.json").path))
    }

    func testUnchangedRefreshRepairsCorruptBaseBeforeSkippingActiveStoreWrites() async throws {
        let fixture = try fixture(), initial = try makeLibrary(fixture), edition = try fixture.edition([preferred])
        try initial.installLanguagePacks(edition)
        let item = try prompt(initial)
        XCTAssertTrue(initial.toggle(item)); XCTAssertTrue(initial.saveDraft("Keep this cached-release draft", for: item))
        let before = try storeBytes()
        let artifact = store.appending(path: "v2-artifacts/\(edition.manifest.base.sha256).json")
        try Data(repeating: 0x20, count: fixture.base.count).write(to: artifact, options: .atomic)
        var attemptedWrites: [String] = []
        let library = Library(directory: store, catalogURL: catalogURL) { _, url in
            attemptedWrites.append(url.lastPathComponent)
            throw CocoaError(.fileWriteOutOfSpace)
        }
        XCTAssertEqual(library.version, fixture.catalog.version, "The committed projection keeps the active edition available")
        let (remote, session) = network(fixture)

        await library.refresh(force: true, session: session)

        XCTAssertEqual(library.syncState, .current)
        XCTAssertEqual(try Data(contentsOf: artifact), fixture.base)
        XCTAssertEqual(Set(remote.requests), ["/v2/latest.json", "/releases/\(fixture.catalog.version)/v2/base.json"])
        XCTAssertTrue(attemptedWrites.isEmpty)
        XCTAssertEqual(try storeBytes(), before)
        XCTAssertEqual(library.advertisedLanguages(for: try prompt(library)), LanguagePackCatalog.supportedLocales,
                       "Repair must also restore verified availability when launch used the cached projection")
    }

    func testMissingAdvertisedLocaleKeepsAllCommittedBytesAndCanRetrySameVersion() async throws {
        let fixture = try fixture(), library = try makeLibrary(fixture), locale = otherLocales[0]
        try library.installLanguagePacks(fixture.edition([preferred]))
        let item = try prompt(library)
        XCTAssertTrue(library.toggle(item)); XCTAssertTrue(library.saveDraft("Keep this draft", for: item))
        let before = try storeBytes(), (remote, session) = network(fixture)
        remote.set(.status(404), for: fixture.localePath(locale))

        let failed = await library.ensureLanguage(locale, for: item, session: session)

        XCTAssertFalse(failed); XCTAssertEqual(library.syncState, .failed)
        XCTAssertNotNil(library.syncMessage)
        XCTAssertEqual(try prompt(library), item)
        XCTAssertEqual(try storeBytes(), before)
        remote.set(.bytes(fixture.locales[locale]!), for: fixture.localePath(locale))
        let retried = await library.ensureLanguage(locale, for: item, session: session)
        XCTAssertTrue(retried); XCTAssertEqual(library.syncState, .current)
        XCTAssertEqual(try storeBytes()["drafts.json"], before["drafts.json"])
    }

    func testUnsupportedAndUnadvertisedSelectionsUseOriginalWithoutFetchingEnglish() async throws {
        let fixture = try fixture(), library = try makeLibrary(fixture)
        try library.installLanguagePacks(fixture.edition())
        let sparse = try prompt(library, id: sparseID), (remote, session) = network(fixture)
        let unsupported = await library.ensureLanguage("xx", for: sparse, session: session)
        let unavailable = await library.ensureLanguage("en", for: sparse, session: session)
        XCTAssertFalse(unsupported); XCTAssertFalse(unavailable)
        XCTAssertEqual(library.advertisedLanguages(for: sparse), ["ja"])
        XCTAssertEqual(sparse.content(in: "en"), sparse.content(in: nil))
        XCTAssertTrue(remote.requests.isEmpty)
    }

    func testRapidAToBToADoesNotLetCancelledAttemptsClearOrReplaceNewestSelection() async throws {
        let fixture = try fixture(), library = try makeLibrary(fixture), a = otherLocales[0], b = otherLocales[1]
        try library.installLanguagePacks(fixture.edition([preferred]))
        let item = try prompt(library), aPath = fixture.localePath(a), bPath = fixture.localePath(b)
        let (remote, session) = network(fixture, holding: [aPath, bPath])
        let first = Task { await library.ensureLanguage(a, for: item, session: session) }
        try await waitForRequest(remote, path: aPath)
        let second = Task { await library.ensureLanguage(b, for: item, session: session) }
        try await waitForRequest(remote, path: bPath)
        let firstResult = await first.value
        XCTAssertFalse(firstResult); XCTAssertTrue(library.isRefreshing)
        let third = Task { await library.ensureLanguage(a, for: item, session: session) }
        try await waitForRequest(remote, path: aPath, count: 2)
        let secondResult = await second.value
        XCTAssertFalse(secondResult); XCTAssertTrue(library.isRefreshing)
        remote.release(path: aPath, occurrence: 1); remote.release(path: bPath)
        XCTAssertEqual(try prompt(library), item)
        remote.release(path: aPath, occurrence: 2)
        let thirdResult = await third.value
        XCTAssertTrue(thirdResult); XCTAssertFalse(library.isRefreshing)
        XCTAssertEqual(library.syncState, .current)
        XCTAssertEqual(Set(try prompt(library).availableLanguages), [preferred, a])
    }

    func testOriginalSelectionCancelsPendingDownloadWithoutInstallingLateBytes() async throws {
        let fixture = try fixture(), library = try makeLibrary(fixture), locale = otherLocales[0]
        try library.installLanguagePacks(fixture.edition([preferred]))
        let before = try storeBytes(), item = try prompt(library), path = fixture.localePath(locale)
        let (remote, session) = network(fixture, holding: [path])
        let pending = Task { await library.ensureLanguage(locale, for: item, session: session) }
        try await waitForRequest(remote, path: path)

        let original = await library.ensureLanguage(nil, for: item, session: session)
        let cancelled = await pending.value
        remote.release(path: path)

        XCTAssertTrue(original); XCTAssertFalse(cancelled)
        XCTAssertFalse(library.isRefreshing); XCTAssertEqual(library.syncState, .idle)
        XCTAssertNil(library.syncMessage)
        XCTAssertEqual(try prompt(library), item)
        XCTAssertEqual(try storeBytes(), before)
    }

    func testAlreadyCancelledSelectionEnteringLateCannotCancelTheNewerRequest() async throws {
        let fixture = try fixture(), library = try makeLibrary(fixture), oldLocale = otherLocales[0], newLocale = otherLocales[1]
        try library.installLanguagePacks(fixture.edition([preferred]))
        let item = try prompt(library), path = fixture.localePath(newLocale), gate = PackLibraryEntryGate()
        defer { gate.open() }
        let (remote, session) = network(fixture, holding: [path])
        let old = Task {
            await gate.wait()
            return await library.ensureLanguage(oldLocale, for: item, session: session)
        }
        old.cancel()
        let newest = Task { await library.ensureLanguage(newLocale, for: item, session: session) }
        try await waitForRequest(remote, path: path)

        // Deliberately ignore cancellation at this gate so the stale caller enters
        // ensureLanguage only after the new selection owns its suspended download.
        gate.open()
        let oldResult = await old.value
        XCTAssertFalse(oldResult)
        XCTAssertTrue(library.isRefreshing)
        XCTAssertEqual(remote.requests, [path])
        XCTAssertEqual(try prompt(library), item)

        remote.release(path: path)
        let newResult = await newest.value
        XCTAssertTrue(newResult)
        XCTAssertEqual(Set(try prompt(library).availableLanguages), [preferred, newLocale])
        XCTAssertEqual(library.syncState, .current)
        XCTAssertFalse(library.isRefreshing)
    }

    func testChangedSourceDuringDownloadPreventsOlderEditionFromInstalling() async throws {
        let old = try fixture(), locale = otherLocales[0], library = try makeLibrary(old)
        try library.installLanguagePacks(old.edition([preferred]))
        let item = try prompt(library), path = old.localePath(locale), (remote, session) = network(old, holding: [path])
        let pending = Task { await library.ensureLanguage(locale, for: item, session: session) }
        try await waitForRequest(remote, path: path)
        let next = try fixture(version: "edition-new-source") { value in
            var items = value["prompts"] as! [[String: Any]]; items[0]["title"] = "A revised title"; value["prompts"] = items
        }
        try library.installLanguagePacks(next.edition([preferred]))
        let committed = try storeBytes()
        remote.release(path: path)
        let result = await pending.value
        XCTAssertFalse(result)
        XCTAssertEqual(library.version, next.catalog.version)
        XCTAssertEqual(try prompt(library).title, "A revised title")
        XCTAssertEqual(try storeBytes(), committed)
        XCTAssertEqual(library.syncState, .current)
    }

    func testExplicitSameSourceEditionWithRevokedLocaleSupersedesAnOlderHeldDownload() async throws {
        let old = try fixture(), library = try makeLibrary(old), locale = otherLocales[0]
        try library.installLanguagePacks(old.edition([preferred]))
        let item = try prompt(library), path = old.localePath(locale), (remote, session) = network(old, holding: [path])
        let pending = Task { await library.ensureLanguage(locale, for: item, session: session) }
        try await waitForRequest(remote, path: path)
        let next = try fixture(version: "edition-explicit-revocation") { value in
            var items = value["prompts"] as! [[String: Any]], localization = items[0]["localization"] as! [String: Any]
            var translations = localization["translations"] as! [String: Any]; translations[locale] = nil
            localization["translations"] = translations; items[0]["localization"] = localization; value["prompts"] = items
        }
        XCTAssertEqual(LanguagePackCatalog.sourceFingerprint(next.catalog.prompts[0]), LanguagePackCatalog.sourceFingerprint(item))

        try library.installLanguagePacks(next.edition([preferred]))
        let committed = try storeBytes()
        XCTAssertFalse(library.isRefreshing)
        remote.release(path: path)
        let result = await pending.value

        XCTAssertFalse(result)
        XCTAssertEqual(library.version, next.catalog.version)
        XCTAssertFalse(library.advertisedLanguages(for: item).contains(locale))
        XCTAssertNil(try prompt(library).localization?.translations[locale])
        XCTAssertEqual(library.syncState, .current)
        XCTAssertEqual(try storeBytes(), committed)
    }

    func testExplicitV1InstallSupersedesAnInitialHeldV2Refresh() async throws {
        let old = try fixture(version: "edition-legacy-start"), library = try makeLibrary(old), incoming = try fixture()
        let path = "/releases/\(incoming.catalog.version)/v2/base.json", (remote, session) = network(incoming, holding: [path])
        let pending = Task { await library.refresh(force: true, session: session) }
        try await waitForRequest(remote, path: path)
        let next = try fixture(version: "edition-explicit-legacy"), bytes = try JSONEncoder().encode(next.catalog)
        let manifest = CatalogManifest(schemaVersion: 1, version: next.catalog.version, sha256: digest(bytes),
            catalog: URL(string: "https://api.prompix.dev/releases/\(next.catalog.version)/catalog.json")!)

        try library.install(bytes, manifest: manifest)
        let committed = try storeBytes()
        remote.release(path: path)
        await pending.value

        XCTAssertEqual(library.version, next.catalog.version)
        XCTAssertEqual(library.prompts, next.catalog.prompts)
        XCTAssertFalse(library.isRefreshing); XCTAssertEqual(library.syncState, .current)
        XCTAssertEqual(try storeBytes(), committed)
        XCTAssertNil(committed["language-packs.json"])
    }

    func testFailedExplicitInstallLeavesTheCurrentDownloadOwnedAndCompletable() async throws {
        let old = try fixture(), initial = try makeLibrary(old), locale = otherLocales[0]
        try initial.installLanguagePacks(old.edition([preferred]))
        var failWrite = false
        let library = Library(directory: store, catalogURL: catalogURL) { data, url in
            if failWrite { throw CocoaError(.fileWriteOutOfSpace) }
            try data.write(to: url, options: .atomic)
        }
        let item = try prompt(library), before = try storeBytes(), path = old.localePath(locale)
        let (remote, session) = network(old, holding: [path])
        let pending = Task { await library.ensureLanguage(locale, for: item, session: session) }
        try await waitForRequest(remote, path: path)
        let next = try fixture(version: "edition-failed-explicit")
        failWrite = true
        XCTAssertThrowsError(try library.installLanguagePacks(next.edition([preferred])))
        XCTAssertTrue(library.isRefreshing)
        XCTAssertEqual(library.version, old.catalog.version)
        XCTAssertEqual(try storeBytes(), before)

        failWrite = false
        remote.release(path: path)
        let result = await pending.value

        XCTAssertTrue(result)
        XCTAssertEqual(library.version, old.catalog.version)
        XCTAssertEqual(Set(try prompt(library).availableLanguages), [preferred, locale])
        XCTAssertEqual(library.syncState, .current)
    }

    func testRemovalDuringDownloadCannotResurrectPromptFavoriteOrAnyDraftVariant() async throws {
        let old = try fixture(), library = try makeLibrary(old), locale = otherLocales[0]
        try library.installLanguagePacks(old.edition([preferred]))
        let item = try prompt(library)
        XCTAssertTrue(library.toggle(item))
        XCTAssertTrue(library.saveDraft("Original edit", for: item)); XCTAssertTrue(library.saveDraft("Translated edit", for: item, language: locale))
        let path = old.localePath(locale), (remote, session) = network(old, holding: [path])
        let pending = Task { await library.ensureLanguage(locale, for: item, session: session) }
        try await waitForRequest(remote, path: path)
        let next = try fixture(version: "edition-removed-source") { value in
            value["prompts"] = (value["prompts"] as! [[String: Any]]).filter { $0["id"] as? String != item.id }
            value["removedIDs"] = ["fixture-removed", item.id]
        }
        try library.installLanguagePacks(next.edition([preferred]))
        let committed = try storeBytes()
        remote.release(path: path)
        let result = await pending.value
        XCTAssertFalse(result); XCTAssertTrue(library.isRemoved(item))
        XCTAssertFalse(library.toggle(item)); XCTAssertFalse(library.saveDraft("Do not recreate", for: item))
        XCTAssertTrue(library.favorites.isEmpty)
        XCTAssertFalse(library.drafts.keys.contains { $0.hasPrefix(item.id) })
        XCTAssertEqual(try storeBytes(), committed)
    }

    func testMatchingFavoriteAccumulatesDownloadedLanguagesAcrossEditionsWithoutChangingDraftBytes() throws {
        let old = try fixture(), library = try makeLibrary(old), a = otherLocales[0], b = otherLocales[1]
        try library.installLanguagePacks(old.edition([a]))
        let saved = try prompt(library)
        XCTAssertTrue(library.toggle(saved)); XCTAssertTrue(library.saveDraft("Keep original draft", for: saved))
        XCTAssertTrue(library.saveDraft("Keep locale draft", for: saved, language: a))
        let draftBytes = try storeBytes()["drafts.json"]
        let next = try fixture(version: "edition-new-translation")
        try library.installLanguagePacks(next.edition([b]))
        let favorite = try XCTUnwrap(library.favorites.first)
        XCTAssertEqual(Set(favorite.availableLanguages), [a, b])
        XCTAssertEqual(favorite.content(in: a), saved.content(in: a))
        XCTAssertEqual(favorite.content(in: b), next.catalog.prompts[0].content(in: b))
        XCTAssertEqual(library.resolvedDetail(saved, origin: .favorite), favorite)
        XCTAssertEqual(library.resolvedDetail(saved, origin: .catalog), try prompt(library))
        XCTAssertEqual(try storeBytes()["drafts.json"], draftBytes)
        XCTAssertEqual(Library(directory: store, catalogURL: catalogURL).favorites, [favorite])
    }

    func testTitleSummaryAndCoverChangesKeepEntireSavedSnapshot() throws {
        for field in ["title", "summary", "cover"] {
            try? FileManager.default.removeItem(at: store)
            let old = try fixture(), library = try makeLibrary(old), a = otherLocales[0], b = otherLocales[1]
            try library.installLanguagePacks(old.edition([a]))
            let saved = try prompt(library)
            XCTAssertTrue(library.toggle(saved)); XCTAssertTrue(library.saveDraft("Keep personal draft", for: saved, language: a))
            let before = try storeBytes()
            let next = try fixture(version: "edition-changed-\(field)") { value in
                var items = value["prompts"] as! [[String: Any]]
                if field == "cover" { var cover = items[0]["cover"] as! [String: Any]; cover["text"] = "Different cover"; items[0]["cover"] = cover }
                else { items[0][field] = "Different \(field)" }
                var creator = items[0]["creator"] as! [String: Any]; creator["displayName"] = "Updated creator"; items[0]["creator"] = creator
                value["prompts"] = items
            }
            try library.installLanguagePacks(next.edition([b]))
            XCTAssertEqual(try prompt(library).prompt, saved.prompt, "The body alone is insufficient to authorize enrichment")
            XCTAssertEqual(library.favorites, [saved], "Changed \(field) must retain every saved field")
            XCTAssertEqual(library.resolvedDetail(saved, origin: .favorite), saved)
            XCTAssertEqual(library.resolvedDetail(saved, origin: .catalog), try prompt(library))
            XCTAssertEqual(library.advertisedLanguages(for: saved), [a])
            XCTAssertEqual(try storeBytes()["favorites.json"], before["favorites.json"])
            XCTAssertEqual(try storeBytes()["drafts.json"], before["drafts.json"])
            XCTAssertTrue(library.toggle(saved))
            XCTAssertTrue(library.favorites.isEmpty)
            XCTAssertEqual(library.resolvedDetail(saved, origin: .favorite), saved,
                           "Un-saving cannot substitute a different source into an open favorite detail")
        }
    }

    func testExplicitAvailabilityRevocationRemovesSavedTranslationButUnfetchedAdvertisedLocaleSurvives() throws {
        let old = try fixture(), library = try makeLibrary(old), retained = otherLocales[0], revoked = otherLocales[1]
        try library.installLanguagePacks(old.edition([retained, revoked]))
        let saved = try prompt(library)
        XCTAssertTrue(library.toggle(saved)); XCTAssertTrue(library.saveDraft("Keep revoked-language personal edit", for: saved, language: revoked))
        let draftBytes = try storeBytes()["drafts.json"]
        let next = try fixture(version: "edition-revoked-locale") { value in
            var items = value["prompts"] as! [[String: Any]], localization = items[0]["localization"] as! [String: Any]
            var translations = localization["translations"] as! [String: Any]; translations[revoked] = nil
            localization["translations"] = translations; items[0]["localization"] = localization; value["prompts"] = items
        }
        try library.installLanguagePacks(next.edition([preferred]))
        let favorite = try XCTUnwrap(library.favorites.first)
        XCTAssertEqual(Set(favorite.availableLanguages), [preferred, retained])
        XCTAssertEqual(favorite.content(in: retained), saved.content(in: retained))
        XCTAssertEqual(favorite.content(in: revoked), favorite.content(in: nil))
        XCTAssertFalse(library.advertisedLanguages(for: favorite).contains(revoked))
        XCTAssertEqual(try storeBytes()["drafts.json"], draftBytes, "Availability does not delete personal edits")
    }

    func testOpenFavoriteDetailRetainsRevocationsAndAddedTranslationsAfterUnsaving() throws {
        let old = try fixture(), library = try makeLibrary(old), revoked = otherLocales[0], added = otherLocales[1]
        try library.installLanguagePacks(old.edition([revoked]))
        let navigationSnapshot = try prompt(library)
        XCTAssertTrue(library.toggle(navigationSnapshot))
        let next = try fixture(version: "edition-open-detail-revocation") { value in
            var items = value["prompts"] as! [[String: Any]], localization = items[0]["localization"] as! [String: Any]
            var translations = localization["translations"] as! [String: Any]; translations[revoked] = nil
            localization["translations"] = translations; items[0]["localization"] = localization; value["prompts"] = items
        }
        try library.installLanguagePacks(next.edition([added]))
        let enriched = library.resolvedDetail(navigationSnapshot, origin: .favorite)
        XCTAssertEqual(enriched.availableLanguages, [added])
        XCTAssertEqual(enriched.content(in: revoked), enriched.content(in: nil))
        XCTAssertEqual(enriched.content(in: added), next.catalog.prompts[0].content(in: added))

        XCTAssertTrue(library.toggle(enriched))
        XCTAssertTrue(library.favorites.isEmpty)

        let unsaved = library.resolvedDetail(navigationSnapshot, origin: .favorite)
        XCTAssertEqual(unsaved, enriched, "Removing the bookmark must not restore the original navigation snapshot's revoked language")
        XCTAssertEqual(unsaved.content(in: revoked), unsaved.content(in: nil))
        XCTAssertEqual(unsaved.content(in: added), enriched.content(in: added), "The open detail keeps the verified new translation")
    }

    func testUnreadableFavoritesArePreservedThenReloadedWithTheSameSourceAndAvailabilityPolicy() throws {
        let old = try fixture(), library = try makeLibrary(old), a = otherLocales[0], b = otherLocales[1]
        try library.installLanguagePacks(old.edition([a, "ja"]))
        let matching = try prompt(library), changed = try prompt(library, id: sparseID)
        XCTAssertTrue(library.toggle(matching)); XCTAssertTrue(library.toggle(changed))
        let favoritesFile = store.appending(path: "favorites.json"), original = try Data(contentsOf: favoritesFile), corrupt = Data("preserve unreadable favorites".utf8)
        try corrupt.write(to: favoritesFile)
        let blocked = Library(directory: store, catalogURL: catalogURL)
        XCTAssertFalse(blocked.favoritesReadable)
        let next = try fixture(version: "edition-reload-favorites") { value in
            var items = value["prompts"] as! [[String: Any]]; items[1]["summary"] = "A changed source summary"; value["prompts"] = items
        }
        try blocked.installLanguagePacks(next.edition([b]))
        XCTAssertEqual(try Data(contentsOf: favoritesFile), corrupt)
        try original.write(to: favoritesFile)
        blocked.reloadFavorites()
        XCTAssertTrue(blocked.favoritesReadable)
        XCTAssertEqual(blocked.favorites.first { $0.id == changed.id }, changed)
        let enriched = try XCTUnwrap(blocked.favorites.first { $0.id == matching.id })
        XCTAssertTrue(enriched.availableLanguages.contains(a)); XCTAssertTrue(enriched.availableLanguages.contains(b))
        XCTAssertEqual(enriched.content(in: a), matching.content(in: a))
        XCTAssertEqual(Library(directory: store, catalogURL: catalogURL).favorites, blocked.favorites)
    }

    private func transactionFixture() throws -> (old: Fixture, next: Fixture, library: Library) {
        let old = try fixture(version: "edition-before-transaction"), library = try makeLibrary(old)
        try library.installLanguagePacks(old.edition([preferred]))
        let saved = try prompt(library), removed = try prompt(library, id: sparseID)
        XCTAssertTrue(library.toggle(saved)); XCTAssertTrue(library.toggle(removed))
        XCTAssertTrue(library.toggleCreator(saved.creator!))
        XCTAssertTrue(library.saveDraft("Keep survivor draft", for: saved))
        XCTAssertTrue(library.saveDraft("Remove original draft", for: removed)); XCTAssertTrue(library.saveDraft("Remove Japanese draft", for: removed, language: "ja"))
        let next = try fixture(version: "edition-after-transaction") { value in
            var items = value["prompts"] as! [[String: Any]], creator = items[0]["creator"] as! [String: Any]
            creator["displayName"] = "Updated author"; items[0]["creator"] = creator
            value["prompts"] = items.filter { $0["id"] as? String != removed.id }
            value["removedIDs"] = ["fixture-removed", removed.id]
        }
        return (old, next, library)
    }

    func testEveryPersonalStoreAndLanguageIndexRollsBackAfterEachCommitStageFails() throws {
        for failure in ["language-packs.json", "creators.json", "catalog.json", "drafts.json", "favorites.json"] {
            try? FileManager.default.removeItem(at: store)
            let fixture = try transactionFixture(), before = try storeBytes()
            var failing: String? = failure, attempted: [String] = []
            let library = Library(directory: store, catalogURL: catalogURL) { data, url in
                attempted.append(url.lastPathComponent)
                if url.lastPathComponent == failing { throw CocoaError(.fileWriteOutOfSpace) }
                try data.write(to: url, options: .atomic)
            }
            XCTAssertThrowsError(try library.installLanguagePacks(fixture.next.edition([preferred])))
            XCTAssertEqual(attempted.last, failure)
            XCTAssertEqual(try storeBytes(), before)
            XCTAssertEqual(library.version, fixture.old.catalog.version)
            XCTAssertEqual(library.prompts, fixture.library.prompts)
            XCTAssertEqual(library.favorites, fixture.library.favorites)
            XCTAssertEqual(library.drafts, fixture.library.drafts)
            XCTAssertEqual(library.savedCreators, fixture.library.savedCreators)
            let reopened = Library(directory: store, catalogURL: catalogURL)
            XCTAssertEqual(reopened.version, fixture.old.catalog.version)
            XCTAssertEqual(reopened.favorites, fixture.library.favorites)
            XCTAssertEqual(reopened.drafts, fixture.library.drafts)
            XCTAssertFalse(FileManager.default.fileExists(atPath: store.appending(path: "catalog-transaction.json").path))
            failing = nil
            try library.installLanguagePacks(fixture.next.edition([preferred]))
            XCTAssertEqual(library.version, fixture.next.catalog.version)
            XCTAssertFalse(library.favorites.contains { $0.id == sparseID })
            XCTAssertFalse(library.drafts.keys.contains { $0.hasPrefix(sparseID) })
            XCTAssertEqual(library.savedCreators.first?.displayName, "Updated author")
        }
    }

    func testInterruptedCommitRecoversTheIndexAndAllPersonalStoresBeforeRelaunchReadsThem() throws {
        let fixture = try transactionFixture(), before = try storeBytes(), journal = store.appending(path: "catalog-transaction.json")
        var pendingJournal: Data?
        let library = Library(directory: store, catalogURL: catalogURL) { data, url in
            if pendingJournal == nil { pendingJournal = try Data(contentsOf: journal) }
            try data.write(to: url, options: .atomic)
        }
        try library.installLanguagePacks(fixture.next.edition([preferred]))
        // The actual journal models termination after writes and before the commit point.
        try XCTUnwrap(pendingJournal).write(to: journal, options: .atomic)
        let recovered = Library(directory: store, catalogURL: catalogURL)
        XCTAssertEqual(try storeBytes(), before)
        XCTAssertEqual(recovered.version, fixture.old.catalog.version)
        XCTAssertEqual(recovered.favorites, fixture.library.favorites)
        XCTAssertEqual(recovered.drafts, fixture.library.drafts)
        XCTAssertEqual(recovered.savedCreators, fixture.library.savedCreators)
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testFailedFirstV2CommitRestoresAbsentIndexAndLeavesV1Usable() throws {
        let fixture = try fixture(), original = try makeLibrary(fixture), before = try storeBytes()
        let library = Library(directory: store, catalogURL: catalogURL) { data, url in
            try data.write(to: url, options: .atomic)
            if url.lastPathComponent == "catalog.json" { throw CocoaError(.fileWriteOutOfSpace) }
        }
        XCTAssertThrowsError(try library.installLanguagePacks(fixture.edition([preferred])))
        XCTAssertEqual(try storeBytes(), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.appending(path: "language-packs.json").path))
        XCTAssertEqual(library.prompts, original.prompts)
        XCTAssertEqual(Library(directory: store, catalogURL: catalogURL).prompts, original.prompts)
    }

    func testCommittedV2AuthorityRejectsLaterV1Install() throws {
        let fixture = try fixture(), library = try makeLibrary(fixture)
        try library.installLanguagePacks(fixture.edition([preferred]))
        let before = try storeBytes(), legacy = try JSONEncoder().encode(fixture.catalog)
        let manifest = CatalogManifest(schemaVersion: 1, version: fixture.catalog.version, sha256: digest(legacy),
            catalog: URL(string: "https://api.prompix.dev/releases/\(fixture.catalog.version)/catalog.json")!)
        XCTAssertThrowsError(try library.install(legacy, manifest: manifest))
        XCTAssertEqual(try storeBytes(), before)
    }
}

private final class PackLibraryEntryGate: @unchecked Sendable {
    private let lock = NSLock()
    private var isOpen = false
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async {
        await withCheckedContinuation { value in
            let ready = lock.withLock {
                if isOpen { return true }
                continuation = value
                return false
            }
            if ready { value.resume() }
        }
    }
    func open() {
        let value = lock.withLock {
            isOpen = true
            defer { continuation = nil }
            return continuation
        }
        value?.resume()
    }
}

/// Each URLSession gets its own fixture through a unique header. No global session,
/// live service, clock-dependent responses, or third-party content is involved.
private final class PackLibraryNetwork: @unchecked Sendable {
    enum Reply { case bytes(Data), status(Int), offline }
    private let lock = NSLock()
    private var responses: [String: Reply]
    private let holding: Set<String>
    private var recorded: [String] = []
    private var pending: [(path: String, occurrence: Int, transport: PackLibraryProtocol, reply: Reply)] = []
    private var offline = false
    init(responses: [String: Reply], holding: Set<String>) { self.responses = responses; self.holding = holding }
    var requests: [String] { lock.withLock { recorded } }
    func set(_ reply: Reply, for path: String) { lock.withLock { responses[path] = reply } }
    func setFailureForAllRequests() { lock.withLock { offline = true } }
    func start(_ transport: PackLibraryProtocol) {
        let path = transport.request.url!.path
        let reply: Reply? = lock.withLock {
            recorded.append(path)
            let reply = offline ? Reply.offline : responses[path] ?? .status(404)
            if holding.contains(path) {
                pending.append((path, recorded.filter { $0 == path }.count, transport, reply))
                return nil
            }
            return reply
        }
        if let reply { transport.deliver(reply) }
    }
    func release(path: String, occurrence: Int = 1) {
        let response = lock.withLock {
            guard let index = pending.firstIndex(where: { $0.path == path && $0.occurrence == occurrence }) else { return nil as (PackLibraryProtocol, Reply)? }
            let value = pending.remove(at: index)
            return (value.transport, value.reply)
        }
        if let response { response.0.deliver(response.1) }
    }
}

private final class PackLibraryRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var fixtures: [String: PackLibraryNetwork] = [:]
    func insert(_ fixture: PackLibraryNetwork) -> String {
        let key = UUID().uuidString
        lock.withLock { fixtures[key] = fixture }
        return key
    }
    func remove(_ key: String) { _ = lock.withLock { fixtures.removeValue(forKey: key) } }
    func get(_ key: String) -> PackLibraryNetwork? { lock.withLock { fixtures[key] } }
}

private final class PackLibraryProtocol: URLProtocol, @unchecked Sendable {
    static let registry = PackLibraryRegistry()
    private let lock = NSLock()
    private var stopped = false
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard request.url?.host == "api.prompix.dev", let key = request.value(forHTTPHeaderField: "X-Prompix-Pack-Library-Test"),
              let fixture = Self.registry.get(key) else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return
        }
        fixture.start(self)
    }
    override func stopLoading() { lock.withLock { stopped = true } }
    func deliver(_ reply: PackLibraryNetwork.Reply) {
        // URLProtocol callbacks after stopLoading are forbidden. Late releases still
        // exercise cancellation completion while another Library request owns state.
        guard !lock.withLock({ stopped }) else { return }
        if case .offline = reply { client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)); return }
        let bytes: Data, status: Int
        switch reply {
        case let .bytes(value): bytes = value; status = 200
        case let .status(value): bytes = Data(); status = value
        case .offline: return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
            headerFields: ["Content-Type": "application/json", "Content-Length": String(bytes.count)])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !bytes.isEmpty { client?.urlProtocol(self, didLoad: bytes) }
        client?.urlProtocolDidFinishLoading(self)
    }
}
