import XCTest
import CryptoKit
@testable import Prompix

final class LanguagePackCatalogTests: XCTestCase {
    private struct Fixture {
        var manifest: Data
        var base: Data
        var locales: [String: Data]
        let catalog: Data
    }

    private func fixture() throws -> Fixture {
        struct Strings: Decodable {
            let manifest: String
            let base: String
            let locales: [String: String]
            let catalog: String
        }
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "language-pack-fixture", withExtension: "json"))
        let strings = try JSONDecoder().decode(Strings.self, from: Data(contentsOf: url))
        return Fixture(manifest: Data(strings.manifest.utf8), base: Data(strings.base.utf8),
                       locales: strings.locales.mapValues { Data($0.utf8) }, catalog: Data(strings.catalog.utf8))
    }

    private func object(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func encode(_ value: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
    }

    private func edit(_ data: Data, _ change: (inout [String: Any]) -> Void) throws -> Data {
        var value = try object(data)
        change(&value)
        return try encode(value)
    }

    private func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    private func rewriteBase(_ fixture: Fixture, _ change: (inout [String: Any]) -> Void) throws -> Fixture {
        var result = fixture
        result.base = try edit(result.base, change)
        result.manifest = try edit(result.manifest) { manifest in
            var descriptor = manifest["base"] as! [String: Any]
            descriptor["sha256"] = digest(result.base); descriptor["byteCount"] = result.base.count
            manifest["base"] = descriptor
        }
        return result
    }

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

    private func rewritePrompt(_ fixture: Fixture, index: Int = 0, _ change: (inout [String: Any]) -> Void) throws -> Fixture {
        try rewriteBase(fixture) { base in
            var prompts = base["prompts"] as! [[String: Any]]
            change(&prompts[index]); base["prompts"] = prompts
        }
    }

    private func rewriteEntry(_ fixture: Fixture, index: Int = 0, _ change: (inout [String: Any]) -> Void) throws -> Fixture {
        try rewriteLocale(fixture) { pack in
            var entries = pack["entries"] as! [[String: Any]]
            change(&entries[index]); pack["entries"] = entries
        }
    }

    private func base(_ fixture: Fixture) throws -> LanguagePackCatalog.Base {
        try LanguagePackCatalog.verifyBase(fixture.base, manifest: LanguagePackCatalog.verifyManifest(fixture.manifest))
    }

    private func requested(_ fixture: Fixture, locale: String? = "ja", bytes: Data? = nil) throws -> Catalog {
        try LanguagePackCatalog.applyRequestedLocale(manifestBytes: fixture.manifest, baseBytes: fixture.base,
                                                    requestedLocale: locale, localeBytes: bytes ?? locale.flatMap { fixture.locales[$0] })
    }

    func testSharedTypeScriptFixtureRoundTripsAllNineLanguagesAndMetadata() throws {
        let fixture = try fixture()
        let expected = try JSONDecoder().decode(Catalog.self, from: fixture.catalog)
        let result = try LanguagePackCatalog.join(manifestBytes: fixture.manifest, baseBytes: fixture.base, localeBytes: fixture.locales)
        XCTAssertEqual(result.schemaVersion, 1)
        XCTAssertEqual(result.version, expected.version)
        XCTAssertEqual(result.publishedAt, expected.publishedAt)
        XCTAssertEqual(result.removedIDs, expected.removedIDs)
        XCTAssertEqual(result.prompts, expected.prompts)
        XCTAssertEqual(Set(result.prompts[0].localization!.translations.keys), Set(LanguagePackCatalog.supportedLocales))
        XCTAssertEqual(result.prompts[1].skill?.files, ["SKILL.md", "LICENSE.txt", "scripts/example.py"])
        XCTAssertEqual(result.prompts[0].creator?.displayName, "Test Author")
        XCTAssertNil(result.prompts[2].localization)
        for (original, actual) in zip(expected.prompts, result.prompts) {
            XCTAssertEqual(Data(actual.prompt.utf8), Data(original.prompt.utf8))
            for (locale, translation) in original.localization?.translations ?? [:] {
                XCTAssertEqual(Data(actual.localization!.translations[locale]!.prompt.utf8), Data(translation.prompt.utf8))
            }
        }
    }

    func testRequestedLanguageKeepsOriginalsAndExposesIndependentAvailability() throws {
        let fixture = try fixture(), base = try base(fixture)
        XCTAssertEqual(base.availableLanguages["fixture-all-languages"], LanguagePackCatalog.supportedLocales)
        XCTAssertEqual(base.availableLanguages["fixture-japanese"], ["ja"])
        XCTAssertEqual(base.availableLanguages["fixture-original-only"], [])
        XCTAssertTrue(base.catalog.prompts.compactMap(\.localization).allSatisfy { $0.translations.isEmpty })
        let result = try requested(fixture)
        XCTAssertEqual(Set(result.prompts[0].localization!.translations.keys), ["ja"])
        XCTAssertEqual(Set(result.prompts[1].localization!.translations.keys), ["ja"])
        XCTAssertNil(result.prompts[2].localization)
        XCTAssertEqual(result.prompts.map(\.prompt), base.catalog.prompts.map(\.prompt))
        let text = try XCTUnwrap(result.prompts[0].localization?.translations["ja"]?.prompt)
        XCTAssertTrue(text.hasPrefix("  Fixture")); XCTAssertTrue(text.hasSuffix("\n  "))
        XCTAssertNil(result.prompts[0].localization?.translations["en"])
    }

    func testUnsupportedAndUnadvertisedRequestsNeverFallBackToEnglish() throws {
        let fixture = try fixture()
        let requests: [String?] = [nil, "", "xx", "en-US", "JA"]
        for locale in requests {
            let result = try requested(fixture, locale: locale)
            XCTAssertTrue(result.prompts.compactMap(\.localization).allSatisfy { $0.translations.isEmpty })
        }
        var sparse = try onlyJapaneseOrOriginals(fixture, includeJapanese: true)
        XCTAssertTrue(try requested(sparse, locale: "en").prompts.compactMap(\.localization).allSatisfy { $0.translations.isEmpty })
        XCTAssertThrowsError(try LanguagePackCatalog.applyRequestedLocale(manifestBytes: fixture.manifest, baseBytes: fixture.base, requestedLocale: "ja"))
        sparse = try onlyJapaneseOrOriginals(fixture, includeJapanese: false)
        let result = try LanguagePackCatalog.join(manifestBytes: sparse.manifest, baseBytes: sparse.base, localeBytes: [:])
        XCTAssertTrue(result.prompts.compactMap(\.localization).allSatisfy { $0.translations.isEmpty })
        XCTAssertEqual(try base(sparse).availableLanguages["fixture-japanese"], [])
    }

    func testChecksumsDecodedByteCountsAndCompleteLocaleSetAreRequired() throws {
        let fixture = try fixture()
        for badBytes in [Data(fixture.base.dropLast()), fixture.base + Data([0x20])] {
            XCTAssertThrowsError(try LanguagePackCatalog.verifyBase(badBytes, manifest: LanguagePackCatalog.verifyManifest(fixture.manifest)))
        }
        for badBytes in [Data(fixture.locales["ja"]!.dropLast()), fixture.locales["en"]!, Data("{}".utf8)] {
            XCTAssertThrowsError(try requested(fixture, bytes: badBytes))
        }
        var missing = fixture.locales; missing["fr"] = nil
        XCTAssertThrowsError(try LanguagePackCatalog.join(manifestBytes: fixture.manifest, baseBytes: fixture.base, localeBytes: missing))
        var extra = fixture.locales; extra["xx"] = fixture.locales["ja"]
        XCTAssertThrowsError(try LanguagePackCatalog.join(manifestBytes: fixture.manifest, baseBytes: fixture.base, localeBytes: extra))
        let wrongLength = try edit(fixture.manifest) { value in
            var descriptor = value["base"] as! [String: Any]
            descriptor["byteCount"] = fixture.base.count + 1; value["base"] = descriptor
        }
        XCTAssertThrowsError(try LanguagePackCatalog.verifyBase(fixture.base, manifest: LanguagePackCatalog.verifyManifest(wrongLength)))
    }

    func testManifestRejectsUnknownFieldsLocationsInvalidNumbersAndIdentities() throws {
        let fixture = try fixture()
        let changes: [(inout [String: Any]) -> Void] = [
            { $0["schemaVersion"] = 1 }, { $0["schemaVersion"] = true }, { $0["version"] = "edition-invalid\n" },
            { $0["publishedAt"] = "2026-02-30T00:00:00Z" }, { $0["publishedAt"] = "2026-10-12T00:00:00+00:00" },
            { $0["count"] = 0 }, { $0["count"] = 1001 }, { $0["count"] = 1.5 }, { $0["count"] = true },
            { $0["count"] = 2 }, { $0["unsupported"] = "value" },
            { var locales = $0["locales"] as! [String: Any]; locales["xx"] = locales["en"]; $0["locales"] = locales },
        ]
        for change in changes { XCTAssertThrowsError(try LanguagePackCatalog.verifyManifest(edit(fixture.manifest, change))) }
        let descriptorChanges: [(String, Any)] = [
            ("url", "https://example.com/releases/edition-v2-fixture/v2/base.json"),
            ("url", "https://api.prompix.dev/releases/edition-v2-fixture/v2/base.json?redirect=1"),
            ("url", "https://api.prompix.dev:443/releases/edition-v2-fixture/v2/base.json"),
            ("sha256", String(repeating: "f", count: 64) + "\n"), ("sha256", String(repeating: "F", count: 64)),
            ("byteCount", 0), ("byteCount", true), ("byteCount", 1.5), ("byteCount", 10_000_001), ("unknown", "value"),
        ]
        for (key, value) in descriptorChanges {
            let bytes = try edit(fixture.manifest) { manifest in
                var descriptor = manifest["base"] as! [String: Any]; descriptor[key] = value; manifest["base"] = descriptor
            }
            XCTAssertThrowsError(try LanguagePackCatalog.verifyManifest(bytes), "\(key): \(value)")
        }
        let wrongLocaleURL = try edit(fixture.manifest) { value in
            var locales = value["locales"] as! [String: [String: Any]]
            locales["ja"]!["url"] = locales["en"]!["url"]; value["locales"] = locales
        }
        XCTAssertThrowsError(try LanguagePackCatalog.verifyManifest(wrongLocaleURL))
    }

    func testBaseRejectsReleaseMismatchDuplicateUnknownAndTombstonedIdentity() throws {
        let fixture = try fixture()
        let changes: [(inout [String: Any]) -> Void] = [
            { $0["version"] = "different-edition" }, { $0["schemaVersion"] = 1 },
            { $0["publishedAt"] = "2026-10-11T00:00:00.000Z" },
            { $0["removedIDs"] = ["fixture-all-languages"] }, { $0["removedIDs"] = ["invalid\n"] },
            { var prompts = $0["prompts"] as! [[String: Any]]; prompts.removeLast(); $0["prompts"] = prompts },
            { var prompts = $0["prompts"] as! [[String: Any]]; prompts[1]["id"] = prompts[0]["id"]; $0["prompts"] = prompts },
            { $0["unsupported"] = true },
        ]
        for change in changes { XCTAssertThrowsError(try base(rewriteBase(fixture, change))) }
        XCTAssertThrowsError(try base(rewritePrompt(fixture) { $0["id"] = "fixture-all-languages\n" }))
        XCTAssertThrowsError(try base(rewritePrompt(fixture) { $0["contentType"] = "skill" }))
        XCTAssertThrowsError(try base(rewritePrompt(fixture) { $0["localization"] = NSNull() }))
    }

    func testEverySourceTextFieldAndCoverTextParticipatesInFingerprint() throws {
        let fixture = try fixture()
        for key in ["title", "summary", "prompt", "example", "previewLabel"] {
            let changed = try rewritePrompt(fixture) { $0[key] = ($0[key] as! String) + " changed" }
            XCTAssertThrowsError(try base(changed)) { XCTAssertEqual($0 as? LanguagePackCatalog.ValidationError, .sourceMismatch) }
        }
        for key in ["text", "eyebrow"] {
            let changed = try rewritePrompt(fixture) { item in
                var cover = item["cover"] as! [String: Any]; cover[key] = "Changed"; item["cover"] = cover
            }
            XCTAssertThrowsError(try base(changed)) { XCTAssertEqual($0 as? LanguagePackCatalog.ValidationError, .sourceMismatch) }
        }
    }

    func testAvailabilityRequiresExactSupportedNonduplicateCoverage() throws {
        let fixture = try fixture()
        for languages in [["ja"], ["ja", "ja"], ["xx"], []] {
            let changed = try rewritePrompt(fixture) { prompt in
                var localization = prompt["localization"] as! [String: Any]
                localization["availableLanguages"] = languages; prompt["localization"] = localization
            }
            XCTAssertThrowsError(try base(changed))
        }
        let changed = try rewritePrompt(fixture) { prompt in
            var localization = prompt["localization"] as! [String: Any]
            localization["translations"] = [:] as [String: Any]; prompt["localization"] = localization
        }
        XCTAssertThrowsError(try base(changed))
    }

    func testPackRejectsWrongReleaseBaseHashAndMissingDuplicateUnknownRemovedEntries() throws {
        let fixture = try fixture()
        let changes: [(inout [String: Any]) -> Void] = [
            { $0["schemaVersion"] = 1 }, { $0["version"] = "different-edition" }, { $0["locale"] = "en" },
            { $0["publishedAt"] = "2026-10-11T00:00:00.000Z" }, { $0["baseSha256"] = String(repeating: "f", count: 64) },
            { var entries = $0["entries"] as! [[String: Any]]; entries.removeLast(); $0["entries"] = entries },
            { var entries = $0["entries"] as! [[String: Any]]; entries[1] = entries[0]; $0["entries"] = entries },
        ]
        for change in changes { XCTAssertThrowsError(try requested(rewriteLocale(fixture, change))) }
        for id in ["unknown", "fixture-original-only", "fixture-removed", "fixture-all-languages\n"] {
            XCTAssertThrowsError(try requested(rewriteEntry(fixture) { $0["id"] = id }))
        }
        XCTAssertThrowsError(try requested(rewriteEntry(fixture) { $0["sourceFingerprint"] = String(repeating: "f", count: 64) }))
    }

    func testNestedUnknownOrMalformedMetadataCannotBeSilentlyDropped() throws {
        let fixture = try fixture()
        for key in ["source", "creator", "cover"] {
            let changed = try rewritePrompt(fixture) { prompt in
                var metadata = prompt[key] as! [String: Any]; metadata["privateNote"] = "Unsupported"; prompt[key] = metadata
            }
            XCTAssertThrowsError(try base(changed))
        }
        XCTAssertThrowsError(try base(rewritePrompt(fixture, index: 1) { prompt in
            var skill = prompt["skill"] as! [String: Any]; skill["files"] = [NSNull()]; prompt["skill"] = skill
        }))
        XCTAssertThrowsError(try base(rewritePrompt(fixture) { $0["publishedAt"] = 42 }))
        XCTAssertThrowsError(try requested(rewriteEntry(fixture) { entry in
            var content = entry["content"] as! [String: Any]; content["unknown"] = true; entry["content"] = content
        }))
        XCTAssertThrowsError(try requested(rewriteEntry(fixture) { entry in
            var content = entry["content"] as! [String: Any]
            var cover = content["cover"] as! [String: Any]; cover["tone"] = "sage"; content["cover"] = cover; entry["content"] = content
        }))
    }

    func testTextValidationUsesTrimmedUTF16LimitsWithoutTrimmingOutput() throws {
        let fixture = try fixture()
        let validTitle = "  " + String(repeating: "🌙", count: 125) + "  "
        let valid = try rewriteEntry(fixture) { entry in
            var content = entry["content"] as! [String: Any]; content["title"] = validTitle; entry["content"] = content
        }
        XCTAssertEqual(try requested(valid).prompts[0].localization?.translations["ja"]?.title, validTitle)
        for (key, value) in [("title", String(repeating: "🌙", count: 126)), ("prompt", " \n\t\u{feff}"), ("example", ""), ("summary", String(repeating: "a", count: 4001))] {
            let changed = try rewriteEntry(fixture) { entry in
                var content = entry["content"] as! [String: Any]; content[key] = value; entry["content"] = content
            }
            XCTAssertThrowsError(try requested(changed))
        }
    }

    func testManifestDecodedByteBoundaryAndInvalidUTF8() throws {
        let fixture = try fixture()
        let padded = fixture.manifest + Data(repeating: 0x20, count: LanguagePackCatalog.manifestByteLimit - fixture.manifest.count)
        XCTAssertNoThrow(try LanguagePackCatalog.verifyManifest(padded))
        XCTAssertThrowsError(try LanguagePackCatalog.verifyManifest(padded + Data([0x20])))
        XCTAssertThrowsError(try LanguagePackCatalog.verifyManifest(fixture.manifest + Data([0xff])))
        XCTAssertThrowsError(try LanguagePackCatalog.verifyBase(Data(repeating: 0x20, count: 10_000_001), manifest: LanguagePackCatalog.verifyManifest(fixture.manifest)))
    }

    func testManifestRejectsFoundationUTF16AndUTF32Autodetection() throws {
        let text = try XCTUnwrap(String(data: fixture().manifest, encoding: .utf8))
        let encodings: [String.Encoding] = [.utf16LittleEndian, .utf16BigEndian, .utf32LittleEndian, .utf32BigEndian]
        for encoding in encodings {
            let bytes = try XCTUnwrap(text.data(using: encoding))
            XCTAssertTrue(bytes.contains(0))
            XCTAssertThrowsError(try LanguagePackCatalog.verifyManifest(bytes))
        }
    }

    func testEscapedUnpairedSurrogatesFailEvenWithMatchingArtifactDescriptors() throws {
        for invalid in [#"Invalid \ud800 source"#, #"Invalid \udc00 source"#] {
            var fixture = try rewritePrompt(fixture(), index: 2) { $0["example"] = "unicode-marker" }
            fixture.base = Data(String(decoding: fixture.base, as: UTF8.self).replacingOccurrences(of: "unicode-marker", with: invalid).utf8)
            fixture.manifest = try edit(fixture.manifest) { value in
                var descriptor = value["base"] as! [String: Any]
                descriptor["sha256"] = digest(fixture.base); descriptor["byteCount"] = fixture.base.count; value["base"] = descriptor
            }
            XCTAssertThrowsError(try base(fixture))

            fixture = try rewriteEntry(self.fixture()) { entry in
                var content = entry["content"] as! [String: Any]; content["prompt"] = "unicode-marker"; entry["content"] = content
            }
            let bytes = Data(String(decoding: fixture.locales["ja"]!, as: UTF8.self).replacingOccurrences(of: "unicode-marker", with: invalid).utf8)
            fixture.locales["ja"] = bytes
            fixture.manifest = try edit(fixture.manifest) { value in
                var locales = value["locales"] as! [String: [String: Any]]
                locales["ja"]!["sha256"] = digest(bytes); locales["ja"]!["byteCount"] = bytes.count; value["locales"] = locales
            }
            XCTAssertThrowsError(try requested(fixture))
        }
    }

    func testValidUnicodeAndEscapedNULRemainIntact() throws {
        let text = "Unicode \u{10000} \u{10ffff} 🌙 Cafe\u{0301} and \u{0000} remain intact"
        var fixture = try rewritePrompt(fixture(), index: 2) { $0["example"] = text }
        XCTAssertEqual(Data(try base(fixture).catalog.prompts[2].example.utf8), Data(text.utf8))
        fixture = try rewriteEntry(self.fixture()) { entry in
            var content = entry["content"] as! [String: Any]; content["prompt"] = text; entry["content"] = content
        }
        let decoded = try XCTUnwrap(requested(fixture).prompts[0].localization?.translations["ja"]?.prompt)
        XCTAssertEqual(Data(decoded.utf8), Data(text.utf8))
    }

    private func onlyJapaneseOrOriginals(_ fixture: Fixture, includeJapanese: Bool) throws -> Fixture {
        var result = try rewriteBase(fixture) { value in
            var prompts = value["prompts"] as! [[String: Any]]
            for index in prompts.indices {
                if var localization = prompts[index]["localization"] as? [String: Any] {
                    localization["availableLanguages"] = includeJapanese ? ["ja"] : []
                    prompts[index]["localization"] = localization
                }
            }
            value["prompts"] = prompts
        }
        result.locales = includeJapanese ? ["ja": result.locales["ja"]!] : [:]
        result.manifest = try edit(result.manifest) { value in
            let locales = value["locales"] as! [String: Any]
            value["locales"] = includeJapanese ? ["ja": locales["ja"]!] : [:]
        }
        if includeJapanese { result = try rebindJapanese(result) }
        return result
    }

    private func rebindJapanese(_ fixture: Fixture) throws -> Fixture {
        try rewriteLocale(fixture) { $0["baseSha256"] = digest(fixture.base) }
    }

    func testBaseAndRequestedLocaleAcceptExactCombinedUTF8LimitAndRejectOneMoreByte() throws {
        for includeJapanese in [false, true] {
            var fixture = try onlyJapaneseOrOriginals(fixture(), includeJapanese: includeJapanese)
            let used = fixture.base.count + (fixture.locales["ja"]?.count ?? 0)
            let remaining = LanguagePackCatalog.artifactByteLimit - used
            let padding = String(repeating: "文", count: remaining / 3) + String(repeating: "x", count: remaining % 3)
            fixture = try rewritePrompt(fixture, index: 2) { $0["example"] = ($0["example"] as! String) + padding }
            if includeJapanese { fixture = try rebindJapanese(fixture) }
            XCTAssertEqual(fixture.base.count + (fixture.locales["ja"]?.count ?? 0), LanguagePackCatalog.artifactByteLimit)
            XCTAssertLessThan(String(data: fixture.base, encoding: .utf8)!.utf16.count, fixture.base.count)
            XCTAssertNoThrow(try requested(fixture, locale: includeJapanese ? "ja" : nil))
            fixture = try rewritePrompt(fixture, index: 2) { $0["example"] = ($0["example"] as! String) + "x" }
            XCTAssertThrowsError(try requested(fixture, locale: includeJapanese ? "ja" : nil))
        }
    }

    func testSourceFingerprintMatchesTypeScriptGoldenVectorIncludingEscapingAndCoverOrder() throws {
        let prompt = try JSONDecoder().decode(Catalog.self, from: fixture().catalog).prompts[0]
        XCTAssertEqual(LanguagePackCatalog.sourceFingerprint(prompt), "2524622fba9eba4d501d10280727a975775023683feb42c6911e62d61a063dba")
        XCTAssertEqual(LanguagePackCatalog.sourceFingerprint(prompt), prompt.localization?.sourceFingerprint)
        XCTAssertEqual(Data(prompt.example.utf8), Data("例子\u{2028}next".utf8))
        let base = try base(fixture())
        XCTAssertEqual(base.catalog.prompts[0].cover?.text, "Café")
    }
}
