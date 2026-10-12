import Foundation
import CoreFoundation
import CryptoKit

/// Pure v2 verification and assembly. This does not fetch, cache or install content.
enum LanguagePackCatalog {
    static let manifestByteLimit = 32_000
    static let artifactByteLimit = 10_000_000
    static let supportedLocales = ["en", "zh-Hans", "zh-Hant", "ja", "ko", "es", "pt-BR", "fr", "de"]

    enum ValidationError: Error, Equatable {
        case tooLarge, invalidMetadata, checksum, releaseMismatch, sourceMismatch, availabilityMismatch, missingLocale
    }

    struct Descriptor {
        let url: URL
        let sha256: String
        let byteCount: Int
        let count: Int
        fileprivate init(url: URL, sha256: String, byteCount: Int, count: Int) {
            self.url = url; self.sha256 = sha256; self.byteCount = byteCount; self.count = count
        }
    }

    struct Manifest {
        let version: String
        let publishedAt: String
        let count: Int
        let base: Descriptor
        let locales: [String: Descriptor]
        fileprivate init(version: String, publishedAt: String, count: Int, base: Descriptor, locales: [String: Descriptor]) {
            self.version = version; self.publishedAt = publishedAt; self.count = count; self.base = base; self.locales = locales
        }
    }

    struct Base {
        let catalog: Catalog
        /// Includes an empty list for each original-only item; no translation is inferred.
        let availableLanguages: [String: [String]]
        fileprivate let manifest: Manifest
        fileprivate init(catalog: Catalog, availableLanguages: [String: [String]], manifest: Manifest) {
            self.catalog = catalog; self.availableLanguages = availableLanguages; self.manifest = manifest
        }
    }

    struct LocalePack {
        let locale: String
        let entries: [String: Prompt.TranslatedContent]
        fileprivate init(locale: String, entries: [String: Prompt.TranslatedContent]) {
            self.locale = locale; self.entries = entries
        }
    }

    static func verifyManifest(_ bytes: Data) throws -> Manifest {
        let raw = try object(decode(bytes, maximum: manifestByteLimit), required: ["schemaVersion", "version", "publishedAt", "count", "base", "locales"])
        try schemaVersion(raw)
        let version = try resource(raw["version"])
        let publishedAt = try timestamp(raw["publishedAt"])
        let count = try integer(raw["count"], maximum: 1000)
        let prefix = "https://api.prompix.dev/releases/\(version)/v2"
        let base = try descriptor(raw["base"], location: "\(prefix)/base.json")
        guard base.count == count else { throw ValidationError.invalidMetadata }
        let rawLocales = try object(raw["locales"], required: [], optional: Set(supportedLocales))
        var locales: [String: Descriptor] = [:]
        for (locale, value) in rawLocales {
            let pack = try descriptor(value, location: "\(prefix)/locales/\(locale).json")
            guard pack.count <= count else { throw ValidationError.invalidMetadata }
            guard base.byteCount + pack.byteCount <= artifactByteLimit else { throw ValidationError.tooLarge }
            locales[locale] = pack
        }
        return Manifest(version: version, publishedAt: publishedAt, count: count, base: base, locales: locales)
    }

    static func verifyBase(_ bytes: Data, manifest: Manifest) throws -> Base {
        let raw = try object(artifact(bytes, descriptor: manifest.base), required: ["schemaVersion", "version", "publishedAt", "prompts"], optional: ["removedIDs"])
        try schemaVersion(raw)
        guard try resource(raw["version"]) == manifest.version, try timestamp(raw["publishedAt"]) == manifest.publishedAt else {
            throw ValidationError.releaseMismatch
        }
        let items = try array(raw["prompts"], minimum: 1, maximum: 1000)
        guard items.count == manifest.count else { throw ValidationError.releaseMismatch }
        let removedIDs = try raw["removedIDs"].map { try array($0).map { try resource($0) } }
        var prompts: [Prompt] = []
        var availability: [String: [String]] = [:]
        for item in items {
            var original = try validatePrompt(item)
            let id = try resource(original["id"])
            guard availability[id] == nil, !(removedIDs ?? []).contains(id) else { throw ValidationError.invalidMetadata }
            var languages: [String] = []
            if let value = original["localization"] {
                let localization = try object(value, required: ["sourceLanguage", "sourceFingerprint", "availableLanguages"])
                _ = try text(localization["sourceLanguage"], maximum: 40)
                _ = try hash(localization["sourceFingerprint"])
                languages = try array(localization["availableLanguages"], maximum: supportedLocales.count).map { try choice($0, supportedLocales) }
                guard Set(languages).count == languages.count else { throw ValidationError.availabilityMismatch }
                original["localization"] = ["sourceLanguage": localization["sourceLanguage"]!, "sourceFingerprint": localization["sourceFingerprint"]!, "translations": [:] as [String: Any]]
            }
            let prompt = try JSONDecoder().decode(Prompt.self, from: JSONSerialization.data(withJSONObject: original))
            if let localization = prompt.localization, localization.sourceFingerprint != sourceFingerprint(prompt) {
                throw ValidationError.sourceMismatch
            }
            prompts.append(prompt)
            availability[id] = languages
        }
        for locale in supportedLocales {
            let count = availability.values.filter { $0.contains(locale) }.count
            guard count == (manifest.locales[locale]?.count ?? 0) else { throw ValidationError.availabilityMismatch }
        }
        let catalog = try Catalog(schemaVersion: 1, version: manifest.version, prompts: prompts,
                                  publishedAt: manifest.publishedAt, removedIDs: removedIDs).validated()
        return Base(catalog: catalog, availableLanguages: availability, manifest: manifest)
    }

    static func verifyLocale(_ bytes: Data, locale: String, base: Base) throws -> LocalePack {
        let manifest = base.manifest
        guard let descriptor = manifest.locales[locale] else { throw ValidationError.missingLocale }
        let raw = try object(artifact(bytes, descriptor: descriptor), required: ["schemaVersion", "version", "publishedAt", "locale", "baseSha256", "entries"])
        try schemaVersion(raw)
        guard try resource(raw["version"]) == manifest.version, try timestamp(raw["publishedAt"]) == manifest.publishedAt,
              try choice(raw["locale"], supportedLocales) == locale, try hash(raw["baseSha256"]) == manifest.base.sha256 else {
            throw ValidationError.releaseMismatch
        }
        let entries = try array(raw["entries"], minimum: 1, maximum: 1000)
        guard entries.count == descriptor.count else { throw ValidationError.availabilityMismatch }
        var expected = Dictionary(uniqueKeysWithValues: base.catalog.prompts.filter {
            base.availableLanguages[$0.id]?.contains(locale) == true
        }.map { ($0.id, $0.localization!.sourceFingerprint) })
        var contents: [String: Prompt.TranslatedContent] = [:]
        for value in entries {
            let entry = try object(value, required: ["id", "sourceFingerprint", "content"])
            let id = try resource(entry["id"])
            guard let fingerprint = expected.removeValue(forKey: id), try hash(entry["sourceFingerprint"]) == fingerprint else {
                throw ValidationError.sourceMismatch
            }
            let content = try validateContent(entry["content"])
            contents[id] = try JSONDecoder().decode(Prompt.TranslatedContent.self, from: JSONSerialization.data(withJSONObject: content))
        }
        guard expected.isEmpty else { throw ValidationError.availabilityMismatch }
        return LocalePack(locale: locale, entries: contents)
    }

    /// Exact locale codes only: unsupported or unadvertised requests keep originals.
    static func applyRequestedLocale(manifestBytes: Data, baseBytes: Data, requestedLocale: String? = nil, localeBytes: Data? = nil) throws -> Catalog {
        let base = try verifyBase(baseBytes, manifest: verifyManifest(manifestBytes))
        guard let locale = requestedLocale, base.manifest.locales[locale] != nil else { return base.catalog }
        guard let localeBytes else { throw ValidationError.missingLocale }
        return apply([try verifyLocale(localeBytes, locale: locale, base: base)], to: base)
    }

    /// Complete reconstruction requires exactly every advertised pack.
    static func join(manifestBytes: Data, baseBytes: Data, localeBytes: [String: Data]) throws -> Catalog {
        let base = try verifyBase(baseBytes, manifest: verifyManifest(manifestBytes))
        guard Set(localeBytes.keys) == Set(base.manifest.locales.keys) else { throw ValidationError.missingLocale }
        let packs = try supportedLocales.compactMap { locale -> LocalePack? in
            guard let bytes = localeBytes[locale] else { return nil }
            return try verifyLocale(bytes, locale: locale, base: base)
        }
        return apply(packs, to: base)
    }

    private static func apply(_ packs: [LocalePack], to base: Base) -> Catalog {
        let prompts = base.catalog.prompts.map { original in
            var item = original
            if let localization = item.localization {
                var translations: [String: Prompt.TranslatedContent] = [:]
                for pack in packs { translations[pack.locale] = pack.entries[item.id] }
                item.localization = .init(sourceLanguage: localization.sourceLanguage, sourceFingerprint: localization.sourceFingerprint, translations: translations)
            }
            return item
        }
        return Catalog(schemaVersion: 1, version: base.catalog.version, prompts: prompts,
                       publishedAt: base.catalog.publishedAt, removedIDs: base.catalog.removedIDs)
    }

    /// Matches JSON.stringify(translationText(item)); key order and untouched text are part of identity.
    static func sourceFingerprint(_ item: Prompt) -> String {
        var fields = [("title", item.title), ("summary", item.summary), ("prompt", item.prompt),
                      ("example", item.example), ("previewLabel", item.previewLabel)]
            .map { "\(quoted($0.0)):\(quoted($0.1))" }
        if let cover = item.cover {
            fields.append("\"cover\":{\"text\":\(quoted(cover.text)),\"eyebrow\":\(quoted(cover.eyebrow))}")
        }
        return digest(Data(("{" + fields.joined(separator: ",") + "}").utf8))
    }

    private static func quoted(_ value: String) -> String {
        var result = "\""
        for scalar in value.unicodeScalars {
            switch scalar.value {
            case 0x22: result += "\\\""
            case 0x5c: result += "\\\\"
            case 0x08: result += "\\b"
            case 0x09: result += "\\t"
            case 0x0a: result += "\\n"
            case 0x0c: result += "\\f"
            case 0x0d: result += "\\r"
            case 0...0x1f: result += String(format: "\\u%04x", scalar.value)
            default: result.unicodeScalars.append(scalar)
            }
        }
        return result + "\""
    }

    private static func validatePrompt(_ value: Any) throws -> [String: Any] {
        let item = try object(value, required: ["id", "kind", "title", "summary", "prompt", "example", "tags", "model", "toolURL", "artwork", "previewLabel", "source", "media"],
                              optional: ["contentType", "creator", "skill", "localization", "cover", "publishedAt"])
        _ = try resource(item["id"]); _ = try resource(item["artwork"])
        _ = try choice(item["kind"], ["text", "image", "video", "web"])
        for (key, maximum) in [("title", 250), ("summary", 4000), ("prompt", 50000), ("example", Int.max), ("model", Int.max), ("previewLabel", Int.max)] {
            _ = try text(item[key], maximum: maximum)
        }
        for tag in try array(item["tags"], minimum: 1) { _ = try text(tag) }
        try https(item["toolURL"], nullable: true)
        if let value = item["contentType"] { _ = try choice(value, ["prompt", "skill"]) }
        guard (item["contentType"] as? String == "skill") == (item["skill"] != nil) else { throw ValidationError.invalidMetadata }
        if let value = item["publishedAt"], !(value is String) { throw ValidationError.invalidMetadata }
        if let value = item["cover"] { try validateCover(value, original: true) }
        let source = try object(item["source"], required: ["name", "url", "license", "method"], optional: ["author", "repository", "revision"])
        for key in ["name", "license", "method", "author", "revision"] where source[key] != nil { _ = try text(source[key]) }
        try https(source["url"], nullable: true)
        if let value = source["repository"] { try https(value) }
        if let value = item["creator"] {
            let creator = try object(value, required: ["id", "platform", "displayName", "profileURL"], optional: ["username", "avatarURL", "externalID", "bio"])
            for key in ["id", "displayName", "username", "externalID", "bio"] where creator[key] != nil {
                _ = try text(creator[key], maximum: key == "bio" ? 2000 : 200)
            }
            _ = try choice(creator["platform"], ["x", "github", "web"])
            try https(creator["profileURL"])
            if let value = creator["avatarURL"] { try https(value) }
        }
        if let value = item["skill"] {
            let skill = try object(value, required: ["name", "description", "format", "entrypoint", "repository", "directory", "installURL"], optional: ["files"])
            _ = try text(skill["name"], maximum: 250); _ = try text(skill["description"], maximum: 4000)
            _ = try text(skill["directory"])
            _ = try choice(skill["format"], ["agent-skills"]); _ = try choice(skill["entrypoint"], ["SKILL.md"])
            try https(skill["repository"]); try https(skill["installURL"])
            if let files = skill["files"] { for file in try array(files, maximum: 200) { _ = try text(file) } }
        }
        if !(item["media"] is NSNull) {
            let media = try object(item["media"], required: ["image", "video", "demoURL"], optional: ["imageURL", "imageURLs", "aspectRatio", "videoURL"])
            for key in ["image", "video"] where !(media[key] is NSNull) { _ = try resource(media[key]) }
            try https(media["demoURL"], nullable: true)
            for key in ["imageURL", "videoURL"] where media[key] != nil { try https(media[key]) }
            if let value = media["imageURLs"] {
                let urls = try array(value, minimum: 1, maximum: 8)
                for url in urls { try https(url) }
                guard urls.first as? String == media["imageURL"] as? String else { throw ValidationError.invalidMetadata }
            }
            if let value = media["aspectRatio"] {
                guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), (0.1...10).contains(number.doubleValue) else { throw ValidationError.invalidMetadata }
            }
        }
        return item
    }

    private static func validateContent(_ value: Any?) throws -> [String: Any] {
        let content = try object(value, required: ["title", "summary", "prompt", "example", "previewLabel"], optional: ["cover"])
        for (key, maximum) in [("title", 250), ("summary", 4000), ("prompt", 50000), ("example", 50000), ("previewLabel", 500)] {
            _ = try text(content[key], maximum: maximum)
        }
        if let cover = content["cover"] { try validateCover(cover, original: false) }
        return content
    }

    private static func validateCover(_ value: Any, original: Bool) throws {
        let cover = try object(value, required: original ? ["text", "eyebrow", "tone"] : ["text", "eyebrow"])
        _ = try text(cover["text"], maximum: 100); _ = try text(cover["eyebrow"], maximum: 40)
        if original { _ = try choice(cover["tone"], ["sage", "clay", "ink", "sky", "cream"]) }
    }

    private static func descriptor(_ value: Any?, location: String) throws -> Descriptor {
        let raw = try object(value, required: ["url", "sha256", "byteCount", "count"])
        guard raw["url"] as? String == location, let url = URL(string: location) else { throw ValidationError.invalidMetadata }
        return try Descriptor(url: url, sha256: hash(raw["sha256"]), byteCount: integer(raw["byteCount"], maximum: artifactByteLimit), count: integer(raw["count"], maximum: 1000))
    }

    private static func artifact(_ bytes: Data, descriptor: Descriptor) throws -> Any {
        guard bytes.count <= artifactByteLimit else { throw ValidationError.tooLarge }
        guard bytes.count == descriptor.byteCount, digest(bytes) == descriptor.sha256 else { throw ValidationError.checksum }
        return try decode(bytes, maximum: artifactByteLimit)
    }

    private static func decode(_ bytes: Data, maximum: Int) throws -> Any {
        guard bytes.count <= maximum else { throw ValidationError.tooLarge }
        guard String(data: bytes, encoding: .utf8) != nil else { throw ValidationError.invalidMetadata }
        return try JSONSerialization.jsonObject(with: bytes)
    }

    private static func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }

    private static func object(_ value: Any?, required: Set<String>, optional: Set<String> = []) throws -> [String: Any] {
        guard let object = value as? [String: Any], required.isSubset(of: Set(object.keys)), Set(object.keys).isSubset(of: required.union(optional)) else { throw ValidationError.invalidMetadata }
        return object
    }

    private static func array(_ value: Any?, minimum: Int = 0, maximum: Int = Int.max) throws -> [Any] {
        guard let array = value as? [Any], (minimum...maximum).contains(array.count) else { throw ValidationError.invalidMetadata }
        return array
    }

    // ECMAScript trim whitespace, with limits measured in UTF-16 like the publisher's schema.
    private static let whitespace = CharacterSet(charactersIn: "\u{0009}\u{000a}\u{000b}\u{000c}\u{000d}\u{0020}\u{00a0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}")
    private static func text(_ value: Any?, maximum: Int = Int.max) throws -> String {
        guard let string = value as? String else { throw ValidationError.invalidMetadata }
        let trimmed = string.trimmingCharacters(in: whitespace)
        guard !trimmed.isEmpty, trimmed.utf16.count <= maximum else { throw ValidationError.invalidMetadata }
        return string
    }

    private static func choice(_ value: Any?, _ choices: [String]) throws -> String {
        guard let string = value as? String, choices.contains(string) else { throw ValidationError.invalidMetadata }
        return string
    }

    private static func resource(_ value: Any?) throws -> String {
        guard let string = value as? String, !string.isEmpty, string.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }) else { throw ValidationError.invalidMetadata }
        return string
    }

    private static func hash(_ value: Any?) throws -> String {
        guard let string = value as? String, string.utf8.count == 64, string.utf8.allSatisfy({ (97...102).contains($0) || (48...57).contains($0) }) else { throw ValidationError.invalidMetadata }
        return string
    }

    private static func integer(_ value: Any?, maximum: Int) throws -> Int {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue >= 1,
              number.doubleValue <= Double(maximum), number.doubleValue.rounded() == number.doubleValue else { throw ValidationError.invalidMetadata }
        return number.intValue
    }

    private static func schemaVersion(_ object: [String: Any]) throws {
        guard try integer(object["schemaVersion"], maximum: 2) == 2 else { throw ValidationError.invalidMetadata }
    }

    private static func timestamp(_ value: Any?) throws -> String {
        guard let string = value as? String,
              string.range(of: #"\A[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?Z\z"#, options: .regularExpression) != nil else { throw ValidationError.invalidMetadata }
        let date = string.prefix(10).split(separator: "-").compactMap { Int($0) }
        let year = date[0], month = date[1], day = date[2]
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
        let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        guard (1...12).contains(month), (1...days[month - 1]).contains(day) else { throw ValidationError.invalidMetadata }
        return string
    }

    private static func https(_ value: Any?, nullable: Bool = false) throws {
        if nullable && value is NSNull { return }
        guard let string = value as? String, let url = URL(string: string), url.scheme == "https", let host = url.host, !host.isEmpty else { throw ValidationError.invalidMetadata }
    }
}
