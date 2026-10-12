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

    private func revisedFixture(_ fixture: Fixture, version: String) throws -> Fixture {
        var result = fixture
        result.base = try edit(result.base) { base in
            base["version"] = version
            var prompts = base["prompts"] as! [[String: Any]]
            prompts[2]["example"] = "Original example for \(version)"; base["prompts"] = prompts
        }
        let baseHash = digest(result.base), baseCount = result.base.count
        result.manifest = try edit(result.manifest) { manifest in
            manifest["version"] = version
            var base = manifest["base"] as! [String: Any]
            base["sha256"] = baseHash; base["byteCount"] = baseCount
            base["url"] = "https://api.prompix.dev/releases/\(version)/v2/base.json"; manifest["base"] = base
            var locales = manifest["locales"] as! [String: [String: Any]]
            for locale in locales.keys { locales[locale]!["url"] = "https://api.prompix.dev/releases/\(version)/v2/locales/\(locale).json" }
            manifest["locales"] = locales
        }
        for locale in LanguagePackCatalog.supportedLocales {
            result = try rewriteLocale(result, locale: locale) { $0["version"] = version; $0["baseSha256"] = baseHash }
        }
        return result
    }

    private func writeOrphan(_ character: Character = "a") throws -> URL {
        let url = artifactURL(String(repeating: String(character), count: 64))
        try Data("Inactive artifact".utf8).write(to: url)
        return url
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

    @MainActor func testPruningUsesCurrentDiskIndexAndBoundsArtifactsAcrossEditions() throws {
        let fixture = try fixture(), cache = LanguagePackCache(directory: directory)
        let staleCache = LanguagePackCache(directory: directory)
        for number in 0..<5 {
            let edition = try revisedFixture(fixture, version: "edition-prune-\(number)").edition(Set(LanguagePackCatalog.supportedLocales))
            let staged = try cache.stage(edition)
            try staged.indexData.write(to: indexURL, options: .atomic)
            staged.releaseArtifacts()
            staleCache.pruneInactiveArtifacts()
            staleCache.pruneInactiveArtifacts()
            let names = try FileManager.default.contentsOfDirectory(atPath: artifactsURL.path)
            let expected = Set([edition.manifest.base.sha256] + Array(staged.index.downloadedLocales.values))
            XCTAssertEqual(Set(names), Set(expected.map { $0 + ".json" }))
            XCTAssertEqual(names.count, 10, "Only one base and the nine active packs survive each committed edition")
            XCTAssertNotNil(cache.load(staged.index, locales: ["ja", "fr"]))
            XCTAssertEqual(try Data(contentsOf: indexURL), staged.indexData)
        }
    }

    @MainActor func testSharedLeasesKeepTheSameHashPinnedUntilEveryStageReleases() throws {
        let fixture = try fixture(), cache = LanguagePackCache(directory: directory)
        let active = try cache.stage(fixture.edition())
        try active.indexData.write(to: indexURL); active.releaseArtifacts()
        let first = try cache.stage(fixture.edition(["ja"]))
        let alias = directory.appendingPathComponent("unused").appendingPathComponent("..")
        let secondCache = LanguagePackCache(directory: alias)
        let second = try secondCache.stage(fixture.edition(["ja"]))
        let japanese = artifactURL(first.index.downloadedLocales["ja"]!)
        cache.pruneInactiveArtifacts()
        XCTAssertTrue(FileManager.default.fileExists(atPath: japanese.path))
        first.releaseArtifacts(); first.releaseArtifacts()
        secondCache.pruneInactiveArtifacts()
        XCTAssertTrue(FileManager.default.fileExists(atPath: japanese.path), "Releasing one stage cannot release another's same-hash pin")
        second.releaseArtifacts()
        cache.pruneInactiveArtifacts()
        XCTAssertFalse(FileManager.default.fileExists(atPath: japanese.path))
        XCTAssertNotNil(cache.load(active.index, locales: []))
    }

    @MainActor func testReturnedStageLeaseProtectsPotentiallyRetainedPacksUntilRejection() throws {
        let fixture = try fixture(), cache = LanguagePackCache(directory: directory)
        let previous = try cache.stage(fixture.edition(["ja"]))
        try previous.indexData.write(to: indexURL); previous.releaseArtifacts()
        let pending = try cache.stage(fixture.edition(["fr"]), retainingIndex: previous.index)
        let replacement = try cache.stage(fixture.edition())
        try replacement.indexData.write(to: indexURL); replacement.releaseArtifacts()
        cache.pruneInactiveArtifacts()
        XCTAssertNotNil(cache.load(pending.index, locales: ["ja", "fr"]), "A returned but not committed stage must retain its inherited pack too")
        pending.releaseArtifacts()
        cache.pruneInactiveArtifacts()
        XCTAssertNil(cache.readLocale("ja", base: try fixture.edition().base))
        XCTAssertNil(cache.readLocale("fr", base: try fixture.edition().base))
        XCTAssertNotNil(cache.load(replacement.index, locales: []))
    }

    @MainActor func testAncestorDirectoryAliasesSharePinsWithoutAcceptingFinalSymlinks() throws {
        let fixture = try fixture(), physicalDirectory = directory.appendingPathComponent("shared-cache")
        let cache = LanguagePackCache(directory: physicalDirectory)
        let active = try cache.stage(fixture.edition())
        try active.indexData.write(to: physicalDirectory.appendingPathComponent(LanguagePackCache.indexFileName))
        active.releaseArtifacts()
        let aliasParent = directory.appendingPathComponent("alias-parent")
        try FileManager.default.createSymbolicLink(at: aliasParent, withDestinationURL: directory)
        let alias = LanguagePackCache(directory: aliasParent.appendingPathComponent("shared-cache"))
        let pending = try alias.stage(fixture.edition(["ja"]))
        cache.pruneInactiveArtifacts()
        XCTAssertNotNil(cache.load(pending.index, locales: ["ja"]), "Different ancestor paths to the same cache share live pins")
        pending.releaseArtifacts()
        cache.pruneInactiveArtifacts()
        XCTAssertNil(cache.readLocale("ja", base: try fixture.edition().base))
    }

    @MainActor func testAbandonedStageLeaseReleasesOnDeinit() throws {
        let fixture = try fixture(), cache = LanguagePackCache(directory: directory)
        let active = try cache.stage(fixture.edition())
        try active.indexData.write(to: indexURL); active.releaseArtifacts()
        func abandonStage() throws {
            let staged = try cache.stage(fixture.edition(["ja"]))
            XCTAssertEqual(Set(staged.index.downloadedLocales.keys), ["ja"])
        }
        try abandonStage()
        cache.pruneInactiveArtifacts()
        XCTAssertNil(cache.readLocale("ja", base: try fixture.edition().base))
        XCTAssertNotNil(cache.load(active.index, locales: []))
    }

    @MainActor func testBackgroundStageRemainsPinnedAcrossCancellationAndAnotherCacheSweep() async throws {
        final class Gate: @unchecked Sendable {
            private let lock = NSLock()
            private var entered = false
            let resume = DispatchSemaphore(value: 0)

            func signalEntry() {
                lock.lock(); defer { lock.unlock() }
                entered = true
            }

            var hasEntered: Bool {
                lock.lock(); defer { lock.unlock() }
                return entered
            }
        }
        let fixture = try fixture(), cache = LanguagePackCache(directory: directory)
        let active = try cache.stage(fixture.edition(["en"]))
        try active.indexData.write(to: indexURL); active.releaseArtifacts()
        let candidate = try revisedFixture(fixture, version: "edition-inflight").edition(["ja"])
        let gate = Gate(), pausedName = candidate.manifest.locales["ja"]!.sha256 + ".json"
        let backgroundCache = LanguagePackCache(directory: directory) { bytes, url in
            if url.lastPathComponent == pausedName {
                gate.signalEntry()
                guard gate.resume.wait(timeout: .now() + 10) == .success else { throw CocoaError(.fileWriteUnknown) }
            }
            try bytes.write(to: url, options: .atomic)
        }
        let task = Task.detached { try backgroundCache.stage(candidate) }
        defer { gate.resume.signal() }
        let entryDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while !gate.hasEntered, ContinuousClock.now < entryDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(gate.hasEntered, "Background staging must reach the paused write before pruning")
        let candidateBase = artifactURL(candidate.manifest.base.sha256)
        cache.pruneInactiveArtifacts()
        XCTAssertTrue(FileManager.default.fileExists(atPath: candidateBase.path), "In-flight writes are protected across cache instances")
        task.cancel()
        cache.pruneInactiveArtifacts()
        XCTAssertTrue(FileManager.default.fileExists(atPath: candidateBase.path), "Task cancellation does not release a still-running stage")
        gate.resume.signal()
        let staged = try await task.value
        cache.pruneInactiveArtifacts()
        XCTAssertNotNil(cache.load(staged.index, locales: ["ja"]), "The returned result stays pinned until its owner rejects it")
        staged.releaseArtifacts()
        cache.pruneInactiveArtifacts()
        XCTAssertFalse(FileManager.default.fileExists(atPath: candidateBase.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: artifactURL(candidate.manifest.locales["ja"]!.sha256).path))
        XCTAssertNotNil(cache.load(active.index, locales: ["en"]))
    }

    @MainActor func testFailedStageReleasesPinsButMissingActiveIndexPreventsCleanup() throws {
        let fixture = try fixture(), candidate = try fixture.edition(["ja"])
        let failedName = candidate.manifest.locales["ja"]!.sha256 + ".json"
        let failing = LanguagePackCache(directory: directory) { bytes, url in
            if url.lastPathComponent == failedName { throw CocoaError(.fileWriteOutOfSpace) }
            try bytes.write(to: url, options: .atomic)
        }
        XCTAssertThrowsError(try failing.stage(candidate))
        let partialBase = artifactURL(candidate.manifest.base.sha256)
        failing.pruneInactiveArtifacts()
        XCTAssertTrue(FileManager.default.fileExists(atPath: partialBase.path), "A failed first install has no committed pointer authorizing cleanup")
        let cache = LanguagePackCache(directory: directory)
        let current = try cache.stage(revisedFixture(fixture, version: "edition-after-failure").edition())
        try current.indexData.write(to: indexURL); current.releaseArtifacts()
        cache.pruneInactiveArtifacts()
        XCTAssertFalse(FileManager.default.fileExists(atPath: partialBase.path), "Thrown stages release pins on partial artifacts")
        XCTAssertNotNil(cache.load(current.index, locales: []))
    }

    @MainActor func testAnyRollbackJournalAndInvalidOrMissingIndexSuppressPruning() throws {
        let cache = LanguagePackCache(directory: directory), active = try cache.stage(fixture().edition())
        try active.indexData.write(to: indexURL); active.releaseArtifacts()
        let orphan = try writeOrphan(), journal = directory.appendingPathComponent("catalog-transaction.json")
        let validJournal = try JSONSerialization.data(withJSONObject: ["files": [["name": LanguagePackCache.indexFileName, "data": active.indexData.base64EncodedString()]]])
        for bytes in [validJournal, Data("false".utf8), Data()] {
            try bytes.write(to: journal)
            cache.pruneInactiveArtifacts()
            XCTAssertTrue(FileManager.default.fileExists(atPath: orphan.path))
            XCTAssertEqual(try Data(contentsOf: journal), bytes)
            try FileManager.default.removeItem(at: journal)
        }
        try FileManager.default.createSymbolicLink(at: journal, withDestinationURL: directory.appendingPathComponent("missing-journal"))
        cache.pruneInactiveArtifacts()
        XCTAssertTrue(FileManager.default.fileExists(atPath: orphan.path), "Even a dangling journal symlink blocks cleanup")
        try FileManager.default.removeItem(at: journal)
        for bytes in [Data("broken".utf8), Data("{}".utf8)] {
            try bytes.write(to: indexURL)
            cache.pruneInactiveArtifacts()
            XCTAssertTrue(FileManager.default.fileExists(atPath: orphan.path))
            XCTAssertEqual(try Data(contentsOf: indexURL), bytes)
        }
        try FileManager.default.removeItem(at: indexURL)
        cache.pruneInactiveArtifacts()
        XCTAssertTrue(FileManager.default.fileExists(atPath: orphan.path))
        try active.indexData.write(to: indexURL)
        cache.pruneInactiveArtifacts()
        XCTAssertFalse(FileManager.default.fileExists(atPath: orphan.path))
    }

    @MainActor func testPruningNeverRemovesUnsafeEntriesUnknownNamesOrPersonalFiles() throws {
        let cache = LanguagePackCache(directory: directory), active = try cache.stage(fixture().edition(["ja", "fr"]))
        try active.indexData.write(to: indexURL); active.releaseArtifacts()
        let personalNames = ["favorites.json", "drafts.json", "creators.json", "catalog.json"]
        for name in personalNames { try Data(name.utf8).write(to: directory.appendingPathComponent(name)) }
        let symlink = artifactURL(String(repeating: "b", count: 64))
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: directory.appendingPathComponent("favorites.json"))
        let fifo = artifactURL(String(repeating: "c", count: 64))
        XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
        let folder = artifactURL(String(repeating: "d", count: 64))
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
        let nested = folder.appendingPathComponent("keep.json"); try Data("Nested".utf8).write(to: nested)
        let unknownNames = [String(repeating: "F", count: 64) + ".json", "notes.json", String(repeating: "e", count: 64) + ".json.tmp"]
        for name in unknownNames { try Data(name.utf8).write(to: artifactsURL.appendingPathComponent(name)) }
        let orphan = try writeOrphan()
        cache.pruneInactiveArtifacts()
        XCTAssertFalse(FileManager.default.fileExists(atPath: orphan.path))
        for url in [symlink, fifo, folder, nested] { XCTAssertTrue(FileManager.default.fileExists(atPath: url.path)) }
        for name in unknownNames { XCTAssertEqual(try Data(contentsOf: artifactsURL.appendingPathComponent(name)), Data(name.utf8)) }
        for name in personalNames { XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent(name)), Data(name.utf8)) }
        XCTAssertNotNil(cache.load(active.index, locales: ["ja", "fr"]), "All recorded locales survive, regardless of which locale the UI uses")
    }

    @MainActor func testPruningRejectsSymlinkCacheRootArtifactDirectoryAndIndex() throws {
        let cache = LanguagePackCache(directory: directory), active = try cache.stage(fixture().edition())
        try active.indexData.write(to: indexURL); active.releaseArtifacts()
        let orphan = try writeOrphan()
        let rootLink = directory.appendingPathComponent("linked-root")
        try FileManager.default.createSymbolicLink(at: rootLink, withDestinationURL: directory)
        LanguagePackCache(directory: rootLink).pruneInactiveArtifacts()
        XCTAssertTrue(FileManager.default.fileExists(atPath: orphan.path))
        let outsideIndex = directory.appendingPathComponent("outside-index.json")
        try active.indexData.write(to: outsideIndex)
        try FileManager.default.removeItem(at: indexURL)
        try FileManager.default.createSymbolicLink(at: indexURL, withDestinationURL: outsideIndex)
        cache.pruneInactiveArtifacts()
        XCTAssertTrue(FileManager.default.fileExists(atPath: orphan.path))
        try FileManager.default.removeItem(at: indexURL); try active.indexData.write(to: indexURL)
        let otherDirectory = directory.appendingPathComponent("other-artifacts")
        try FileManager.default.moveItem(at: artifactsURL, to: otherDirectory)
        try FileManager.default.createSymbolicLink(at: artifactsURL, withDestinationURL: otherDirectory)
        cache.pruneInactiveArtifacts()
        XCTAssertTrue(FileManager.default.fileExists(atPath: otherDirectory.appendingPathComponent(orphan.lastPathComponent).path))
        XCTAssertEqual(try Data(contentsOf: outsideIndex), active.indexData)
    }

    @MainActor func testPruneDeletionFailureIsNonfatalAndCanBeRetried() throws {
        try XCTSkipIf(geteuid() == 0, "Root can bypass the directory write permission used by this failure test")
        let cache = LanguagePackCache(directory: directory), active = try cache.stage(fixture().edition())
        try active.indexData.write(to: indexURL); active.releaseArtifacts()
        let orphan = try writeOrphan()
        XCTAssertEqual(chmod(artifactsURL.path, 0o500), 0)
        defer { _ = chmod(artifactsURL.path, 0o700) }
        cache.pruneInactiveArtifacts()
        XCTAssertTrue(FileManager.default.fileExists(atPath: orphan.path))
        XCTAssertEqual(try Data(contentsOf: indexURL), active.indexData)
        XCTAssertNotNil(cache.load(active.index, locales: []))
        XCTAssertEqual(chmod(artifactsURL.path, 0o700), 0)
        cache.pruneInactiveArtifacts()
        XCTAssertFalse(FileManager.default.fileExists(atPath: orphan.path))
    }
}
