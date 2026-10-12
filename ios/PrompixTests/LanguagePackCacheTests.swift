import XCTest
import CryptoKit
import Darwin
@testable import Prompix

final class LanguagePackCacheTests: XCTestCase {
    private var directory: URL!
    private struct Fixture {
        var manifest: Data
        var base: Data
        var locales: [String: Data]
        func edition(_ locales: Set<String> = []) throws -> LanguagePackEdition {
            try LanguagePackEdition(manifestBytes: manifest, baseBytes: base, localeBytes: self.locales.filter { locales.contains($0.key) })
        }
    }

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }

    private func fixture() throws -> Fixture {
        struct Strings: Decodable { let manifest: String; let base: String; let locales: [String: String] }
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "language-pack-fixture", withExtension: "json"))
        let value = try JSONDecoder().decode(Strings.self, from: Data(contentsOf: url))
        return Fixture(manifest: Data(value.manifest.utf8), base: Data(value.base.utf8), locales: value.locales.mapValues { Data($0.utf8) })
    }

    private func edit(_ data: Data, _ change: (inout [String: Any]) -> Void) throws -> Data {
        var value = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        change(&value)
        return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
    }

    private func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private var indexURL: URL { directory.appendingPathComponent(LanguagePackCache.indexFileName) }
    private var artifactsURL: URL { directory.appendingPathComponent("v2-artifacts", isDirectory: true) }
    private func artifactURL(_ hash: String) -> URL { artifactsURL.appendingPathComponent(hash + ".json") }

    private func rewriteLocale(_ fixture: Fixture, locale: String = "ja", _ change: (inout [String: Any]) -> Void) throws -> Fixture {
        var result = fixture
        let bytes = try edit(XCTUnwrap(result.locales[locale]), change)
        result.locales[locale] = bytes
        result.manifest = try edit(result.manifest) { manifest in
            var locales = manifest["locales"] as! [String: [String: Any]]
            locales[locale]!["sha256"] = digest(bytes); locales[locale]!["byteCount"] = bytes.count
            manifest["locales"] = locales
        }
        return result
    }

    func testPartialEditionPreservesRawBytesAndAdvertisedAvailabilityWithoutEnglish() throws {
        let fixture = try fixture(), edition = try fixture.edition(["ja", "fr"])
        XCTAssertEqual(edition.manifestBytes, fixture.manifest)
        XCTAssertEqual(edition.baseBytes, fixture.base)
        XCTAssertEqual(edition.localeBytes, fixture.locales.filter { ["ja", "fr"].contains($0.key) })
        XCTAssertEqual(Set(edition.catalog.prompts[0].localization!.translations.keys), ["ja", "fr"])
        XCTAssertEqual(Set(edition.catalog.prompts[1].localization!.translations.keys), ["ja"])
        XCTAssertNil(edition.catalog.prompts[2].localization)
        XCTAssertEqual(edition.base.availableLanguages["fixture-all-languages"], LanguagePackCatalog.supportedLocales)
        XCTAssertTrue(try fixture.edition().catalog.prompts.compactMap(\.localization).allSatisfy { $0.translations.isEmpty })
        XCTAssertThrowsError(try LanguagePackCatalog.join(manifestBytes: fixture.manifest, baseBytes: fixture.base, localeBytes: edition.localeBytes))
    }

    func testPartialEditionStillRequiresCompleteVerifiedKnownPacks() throws {
        let fixture = try fixture()
        XCTAssertThrowsError(try LanguagePackEdition(manifestBytes: fixture.manifest, baseBytes: fixture.base, localeBytes: ["xx": fixture.locales["ja"]!]))
        XCTAssertThrowsError(try LanguagePackEdition(manifestBytes: fixture.manifest, baseBytes: fixture.base, localeBytes: ["ja": fixture.locales["en"]!]))
        XCTAssertThrowsError(try LanguagePackEdition(manifestBytes: fixture.manifest, baseBytes: Data(fixture.base.dropLast())))
        let wrongSource = try rewriteLocale(fixture) { pack in
            var entries = pack["entries"] as! [[String: Any]]
            entries[0]["sourceFingerprint"] = String(repeating: "f", count: 64); pack["entries"] = entries
        }
        XCTAssertThrowsError(try wrongSource.edition(["ja"]))
        let missing = try rewriteLocale(fixture) { pack in
            var entries = pack["entries"] as! [[String: Any]]; entries.removeLast(); pack["entries"] = entries
        }
        XCTAssertThrowsError(try missing.edition(["ja"]))
    }

    func testStageWritesOnlyRawArtifactsAndDoesNotActivateAnyIndexOrPersonalStore() throws {
        let edition = try fixture().edition(["ja"]), cache = LanguagePackCache(directory: directory)
        let names = ["catalog.json", "favorites.json", "drafts.json", "creators.json"]
        for name in names { try Data("Preserve \(name)".utf8).write(to: directory.appendingPathComponent(name)) }
        let staged = try cache.stage(edition)
        XCTAssertNil(try cache.readIndex())
        XCTAssertFalse(FileManager.default.fileExists(atPath: indexURL.path))
        XCTAssertEqual(try Data(contentsOf: artifactURL(edition.manifest.base.sha256)), edition.baseBytes)
        XCTAssertEqual(try Data(contentsOf: artifactURL(edition.manifest.locales["ja"]!.sha256)), edition.localeBytes["ja"])
        XCTAssertEqual(Set(staged.index.downloadedLocales.keys), ["ja"])
        XCTAssertEqual(try JSONDecoder().decode(LanguagePackCache.Index.self, from: staged.indexData).manifestBytes, edition.manifestBytes)
        for name in names { XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent(name)), Data("Preserve \(name)".utf8)) }
    }

    func testActiveIndexLoadsOnlyRequestedRecordedPacksAndRetainsSameEditionLanguages() throws {
        let fixture = try fixture(), cache = LanguagePackCache(directory: directory)
        let first = try cache.stage(fixture.edition(["en", "ja"]))
        try first.indexData.write(to: indexURL)
        let active = try XCTUnwrap(cache.readIndex())
        XCTAssertEqual(active.manifest.version, "edition-v2-fixture")
        let japanese = try XCTUnwrap(cache.load(active, locales: ["ja"]))
        XCTAssertEqual(Set(japanese.localeBytes.keys), ["ja"])
        XCTAssertEqual(Set(japanese.catalog.prompts[0].localization!.translations.keys), ["ja"])
        XCTAssertTrue(try XCTUnwrap(cache.load(active, locales: [])).localeBytes.isEmpty)
        XCTAssertNil(cache.load(active, locales: ["fr"]))
        XCTAssertNil(cache.load(active, locales: ["xx"]))

        let next = try cache.stage(fixture.edition(["fr"]), retainingIndex: active)
        XCTAssertEqual(Set(next.index.downloadedLocales.keys), ["en", "ja", "fr"])
        XCTAssertEqual(try Data(contentsOf: indexURL), first.indexData, "Staging must leave transaction ownership with Library")
        XCTAssertEqual(Set(try XCTUnwrap(cache.load(next.index, locales: ["ja", "fr"])).localeBytes.keys), ["ja", "fr"])
        // Raw orphan bytes may be reused by exact descriptor, but aren't active
        // until Library commits an index that records them.
        XCTAssertNil(cache.load(active, locales: ["fr"]))
        XCTAssertNotNil(cache.readLocale("fr", base: japanese.base))
    }

    func testStageRetainsOnlyUnchangedDescriptorsAndVerifiedReadablePacks() throws {
        let fixture = try fixture(), cache = LanguagePackCache(directory: directory)
        let first = try cache.stage(fixture.edition(["en", "ja"]))
        let updated = try rewriteLocale(fixture) { pack in
            var entries = pack["entries"] as! [[String: Any]]
            var content = entries[0]["content"] as! [String: Any]; content["title"] = "Updated Japanese title"
            entries[0]["content"] = content; pack["entries"] = entries
        }
        let next = try cache.stage(updated.edition(["fr"]), retainingIndex: first.index)
        XCTAssertEqual(Set(next.index.downloadedLocales.keys), ["en", "fr"], "A changed advertised hash invalidates only that prior pack")
        try Data("broken".utf8).write(to: artifactURL(updated.edition().manifest.locales["en"]!.sha256))
        let afterCorruption = try cache.stage(updated.edition(["fr"]), retainingIndex: next.index)
        XCTAssertEqual(Set(afterCorruption.index.downloadedLocales.keys), ["fr"])
    }

    func testUnrequestedCorruptPackDoesNotBlockHealthyLocaleOrOriginals() throws {
        let edition = try fixture().edition(Set(LanguagePackCatalog.supportedLocales)), cache = LanguagePackCache(directory: directory)
        let staged = try cache.stage(edition)
        try staged.indexData.write(to: indexURL)
        try Data("corrupt".utf8).write(to: artifactURL(edition.manifest.locales["ja"]!.sha256))
        XCTAssertNotNil(cache.load(staged.index, locales: []))
        XCTAssertNotNil(cache.load(staged.index, locales: ["fr"]))
        XCTAssertNil(cache.load(staged.index, locales: ["ja"]))
        XCTAssertNil(cache.load(staged.index, locales: ["fr", "ja"]))
        XCTAssertEqual(try cache.readIndex()?.downloadedLocales.count, 9, "A cache read cannot withdraw an advertised language or mutate active state")
    }

    func testChangedBaseDoesNotInheritPreviousDownloadedRecords() throws {
        var fixture = try fixture()
        let cache = LanguagePackCache(directory: directory), first = try cache.stage(fixture.edition(["en", "ja"]))
        fixture.base = try edit(fixture.base) { base in
            var prompts = base["prompts"] as! [[String: Any]]; prompts[2]["example"] = "Changed original-only example"; base["prompts"] = prompts
        }
        let baseHash = digest(fixture.base), baseCount = fixture.base.count
        fixture.manifest = try edit(fixture.manifest) { manifest in
            var descriptor = manifest["base"] as! [String: Any]
            descriptor["sha256"] = baseHash; descriptor["byteCount"] = baseCount; manifest["base"] = descriptor
        }
        for locale in LanguagePackCatalog.supportedLocales {
            fixture = try rewriteLocale(fixture, locale: locale) { $0["baseSha256"] = baseHash }
        }
        let next = try cache.stage(fixture.edition(["fr"]), retainingIndex: first.index)
        XCTAssertEqual(Set(next.index.downloadedLocales.keys), ["fr"])
        XCTAssertNotNil(cache.load(first.index, locales: ["ja"]), "Staging never deletes the old edition needed for rollback")
    }

    func testValidImmutableFilesAreNeverRewrittenAndCorruptRegularFilesCanBeRepaired() throws {
        let edition = try fixture().edition(["ja"]), cache = LanguagePackCache(directory: directory)
        _ = try cache.stage(edition)
        let rejectingWriter = LanguagePackCache(directory: directory) { _, _ in throw CocoaError(.fileWriteUnknown) }
        XCTAssertNoThrow(try rejectingWriter.stage(edition))
        let url = artifactURL(edition.manifest.locales["ja"]!.sha256)
        try Data("corrupt".utf8).write(to: url)
        XCTAssertNil(cache.readLocale("ja", base: edition.base))
        XCTAssertThrowsError(try rejectingWriter.stage(edition))
        let repaired = try cache.stage(edition)
        XCTAssertEqual(try Data(contentsOf: url), edition.localeBytes["ja"])
        XCTAssertNotNil(cache.load(repaired.index, locales: ["ja"]))
    }

    func testWriterFailureAndFailedReadbackLeaveActiveStateUntouchedAndAllowRetry() throws {
        let fixture = try fixture(), cache = LanguagePackCache(directory: directory)
        let active = try cache.stage(fixture.edition(["ja"])); try active.indexData.write(to: indexURL)
        let next = try fixture.edition(["fr"]), failingHash = next.manifest.locales["fr"]!.sha256
        let failing = LanguagePackCache(directory: directory) { bytes, url in
            if url.lastPathComponent == failingHash + ".json" { throw CocoaError(.fileWriteOutOfSpace) }
            try bytes.write(to: url, options: .atomic)
        }
        XCTAssertThrowsError(try failing.stage(next, retainingIndex: active.index))
        XCTAssertEqual(try Data(contentsOf: indexURL), active.indexData)
        XCTAssertNotNil(cache.load(active.index, locales: ["ja"]))
        let badReadback = LanguagePackCache(directory: directory) { _, url in try Data("broken".utf8).write(to: url, options: .atomic) }
        XCTAssertThrowsError(try badReadback.stage(next, retainingIndex: active.index))
        XCTAssertEqual(try Data(contentsOf: indexURL), active.indexData)
        XCTAssertNil(cache.readLocale("fr", base: next.base))
        let retry = try cache.stage(next, retainingIndex: active.index)
        XCTAssertEqual(Set(retry.index.downloadedLocales.keys), ["ja", "fr"])
        XCTAssertNotNil(cache.load(retry.index, locales: ["fr"]))
    }

    func testIndexRejectsUnknownSchemaFieldsAndMismatchedDownloadedHashes() throws {
        let edition = try fixture().edition(["ja"]), cache = LanguagePackCache(directory: directory)
        let staged = try cache.stage(edition)
        let changes: [(inout [String: Any]) -> Void] = [
            { $0["schemaVersion"] = 2 }, { $0["schemaVersion"] = true }, { $0["unknown"] = "value" },
            { $0["downloadedLocales"] = ["xx": String(repeating: "a", count: 64)] },
            { $0["downloadedLocales"] = ["../ja": edition.manifest.locales["ja"]!.sha256] },
            { $0["downloadedLocales"] = ["ja": String(repeating: "f", count: 64)] },
            { $0["downloadedLocales"] = ["ja": NSNull()] }, { $0["manifestBytes"] = "not base64" },
            { $0.removeValue(forKey: "downloadedLocales") },
        ]
        for change in changes {
            let bytes = try edit(staged.indexData, change)
            XCTAssertThrowsError(try JSONDecoder().decode(LanguagePackCache.Index.self, from: bytes))
            try bytes.write(to: indexURL)
            XCTAssertThrowsError(try cache.readIndex())
            XCTAssertEqual(try Data(contentsOf: indexURL), bytes)
        }
        XCTAssertThrowsError(try LanguagePackCache.Index(manifestBytes: edition.manifestBytes, downloadedLocales: ["ja": edition.manifest.locales["en"]!.sha256]))
    }

    func testIndexAndArtifactReadsAreBoundedAndKeepCorruptFilesForRecovery() throws {
        let edition = try fixture().edition(["ja"]), cache = LanguagePackCache(directory: directory)
        let staged = try cache.stage(edition)
        let oversize = Data(repeating: 0x20, count: LanguagePackCache.indexByteLimit + 1)
        try oversize.write(to: indexURL)
        XCTAssertThrowsError(try cache.readIndex())
        XCTAssertEqual(try Data(contentsOf: indexURL), oversize)
        let manifest = edition.manifestBytes + Data(repeating: 0x20, count: LanguagePackCatalog.manifestByteLimit + 1 - edition.manifestBytes.count)
        let oversizedManifest = try edit(staged.indexData) { $0["manifestBytes"] = manifest.base64EncodedString() }
        try oversizedManifest.write(to: indexURL)
        XCTAssertThrowsError(try cache.readIndex())
        let utf16 = try XCTUnwrap(String(decoding: staged.indexData, as: UTF8.self).data(using: .utf16LittleEndian))
        try utf16.write(to: indexURL)
        XCTAssertThrowsError(try cache.readIndex())
        let url = artifactURL(edition.manifest.base.sha256), invalidBase = edition.baseBytes + Data([0x20])
        try invalidBase.write(to: url)
        XCTAssertNil(cache.readBase(manifest: edition.manifest))
        XCTAssertNil(cache.load(staged.index, locales: ["ja"]))
        XCTAssertEqual(try Data(contentsOf: url), invalidBase)
    }

    func testSymlinkArtifactsAndArtifactDirectoriesAreNeverReadOrWritten() throws {
        let edition = try fixture().edition(["ja"]), cache = LanguagePackCache(directory: directory)
        try FileManager.default.createDirectory(at: artifactsURL, withIntermediateDirectories: true)
        let outside = directory.appendingPathComponent("outside.json")
        try edition.baseBytes.write(to: outside)
        let target = artifactURL(edition.manifest.base.sha256)
        try FileManager.default.createSymbolicLink(at: target, withDestinationURL: outside)
        XCTAssertNil(cache.readBase(manifest: edition.manifest))
        XCTAssertThrowsError(try cache.stage(edition))
        XCTAssertEqual(try Data(contentsOf: outside), edition.baseBytes)
        try FileManager.default.removeItem(at: artifactsURL)
        let outsideDirectory = directory.appendingPathComponent("outside-directory", isDirectory: true)
        try FileManager.default.createDirectory(at: outsideDirectory, withIntermediateDirectories: true)
        try edition.baseBytes.write(to: outsideDirectory.appendingPathComponent(edition.manifest.base.sha256 + ".json"))
        try FileManager.default.createSymbolicLink(at: artifactsURL, withDestinationURL: outsideDirectory)
        XCTAssertNil(cache.readBase(manifest: edition.manifest))
        XCTAssertThrowsError(try cache.stage(edition))
    }

    func testSymlinkIndexAndNonregularArtifactFailWithoutBlockingOrActivation() throws {
        let edition = try fixture().edition(), cache = LanguagePackCache(directory: directory)
        let staged = try cache.stage(edition)
        let outside = directory.appendingPathComponent("outside-index.json")
        try staged.indexData.write(to: outside)
        try FileManager.default.createSymbolicLink(at: indexURL, withDestinationURL: outside)
        XCTAssertThrowsError(try cache.readIndex())
        XCTAssertEqual(try Data(contentsOf: outside), staged.indexData)
        let target = artifactURL(edition.manifest.base.sha256)
        try FileManager.default.removeItem(at: target)
        XCTAssertEqual(mkfifo(target.path, 0o600), 0)
        XCTAssertNil(cache.readBase(manifest: edition.manifest))
        XCTAssertThrowsError(try cache.stage(edition))
        XCTAssertThrowsError(try cache.readIndex())
    }
}
