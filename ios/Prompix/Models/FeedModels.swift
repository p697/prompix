import Foundation

enum FeedError: Error, Equatable {
    case invalidResponse, invalidQuery, removed, snapshotExpired, notFound
    case rateLimited(TimeInterval), unavailable(TimeInterval)
}

/// A card is deliberately separate from Prompt: it cannot be copied, saved or used
/// as a detail until the complete, validated revision has been fetched.
struct FeedCard: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let revision: String
    let kind: PromptKind
    let contentType: String
    let title: String
    let summary: String
    let tags: [String]
    let model: String
    let artwork: String
    let previewLabel: String
    let creator: Prompt.Creator?
    let media: Prompt.Media?
    let cover: Prompt.Cover?
    let language: String
    let availableLanguages: [String]

    func validated(locale: String) throws -> Self {
        guard FeedValidation.id(id), FeedValidation.revision(revision), ["prompt", "skill"].contains(contentType),
              contentType != "skill" || kind == .text,
              FeedValidation.text(title, max: 250), FeedValidation.text(summary, max: 4000),
              FeedValidation.text(model, max: 200), FeedValidation.id(artwork), previewLabel.utf16.count <= 500,
              tags.count <= 50, tags.allSatisfy({ FeedValidation.text($0, max: 100) }),
              FeedValidation.languages(availableLanguages),
              language == "original" || (language == locale && availableLanguages.contains(language)) else { throw FeedError.invalidResponse }
        try ContentValidation.creator(creator)
        try ContentValidation.media(media)
        if let cover {
            guard cover.text.utf16.count <= 500, cover.eyebrow.utf16.count <= 500,
                  cover.tone.utf16.count <= 100 else { throw FeedError.invalidResponse }
        }
        return self
    }
}

struct FeedPage: Codable, Sendable {
    let schemaVersion: Int
    let release: String
    let items: [FeedCard]
    let nextCursor: String?
    func validated(locale: String, limit: Int, release expected: String? = nil) throws -> Self {
        guard schemaVersion == 3, FeedValidation.release(release), expected == nil || release == expected,
              items.count <= limit, Set(items.map(\.id)).count == items.count,
              FeedValidation.cursor(nextCursor), nextCursor == nil || !items.isEmpty else { throw FeedError.invalidResponse }
        for item in items { _ = try item.validated(locale: locale) }
        return self
    }
}

struct FeedDetail: Codable, Sendable {
    let schemaVersion: Int
    let revision: String
    let item: Prompt
    let availableLanguages: [String]
    func validated(id: String, revision expected: String?, locale: String) throws -> Self {
        guard schemaVersion == 3, item.id == id, FeedValidation.revision(revision),
              item.feedRevision == nil || item.feedRevision == revision,
              item.feedLanguages == nil || item.feedLanguages == availableLanguages,
              expected == nil || revision == expected, FeedValidation.languages(availableLanguages) else { throw FeedError.invalidResponse }
        _ = try Catalog(schemaVersion: 1, version: revision, prompts: [item]).validated()
        let translations = item.localization?.translations ?? [:]
        guard translations.keys.allSatisfy({ $0 == locale && availableLanguages.contains($0) }),
              locale == "original" || !availableLanguages.contains(locale) || translations[locale] != nil else { throw FeedError.invalidResponse }
        if let localization = item.localization {
            guard localization.sourceFingerprint == LanguagePackCatalog.sourceFingerprint(item) else { throw FeedError.invalidResponse }
        }
        return self
    }
}

struct FeedCreatorsPage: Codable, Sendable {
    struct Entry: Codable, Identifiable, Sendable {
        let creator: Prompt.Creator
        let count: Int
        var id: String { creator.id }
    }
    let schemaVersion: Int
    let release: String
    let items: [Entry]
    let nextCursor: String?
    func validated(limit: Int, release expected: String? = nil) throws -> Self {
        guard schemaVersion == 3, FeedValidation.release(release), expected == nil || release == expected,
              items.count <= limit, Set(items.map(\.id)).count == items.count,
              FeedValidation.cursor(nextCursor), nextCursor == nil || !items.isEmpty else { throw FeedError.invalidResponse }
        for item in items {
            guard (1...100000).contains(item.count) else { throw FeedError.invalidResponse }
            try ContentValidation.creator(item.creator)
        }
        return self
    }
}

struct FeedState: Codable, Sendable {
    let schemaVersion: Int
    let release: String
    let generation: String
    let removalSequence: String
    let count: Int
    let publishedAt: String?
    func validated() throws -> Self {
        guard schemaVersion == 3, FeedValidation.release(release), FeedValidation.sequence(generation) != nil,
              FeedValidation.sequence(removalSequence) != nil, (0...100000).contains(count) else { throw FeedError.invalidResponse }
        return self
    }
}

struct FeedRemovals: Codable, Sendable {
    struct Entry: Codable, Sendable { let sequence: String; let id: String }
    let schemaVersion: Int
    let items: [Entry]
    let nextAfter: String
    let hasMore: Bool
    func validated(after: String) throws -> Self {
        guard schemaVersion == 3, let initial = FeedValidation.sequence(after), items.count <= 500,
              !hasMore || !items.isEmpty, Set(items.map(\.id)).count == items.count else { throw FeedError.invalidResponse }
        var previous = initial
        for item in items {
            guard let value = FeedValidation.sequence(item.sequence), value > previous, FeedValidation.id(item.id) else { throw FeedError.invalidResponse }
            previous = value
        }
        guard nextAfter == (items.last?.sequence ?? after) else { throw FeedError.invalidResponse }
        return self
    }
}

struct FeedQuery: Codable, Hashable, Sendable {
    var locale: String = ContentLanguage.preferred
    var kind: String?
    var collection: String?
    var creator: String?
    var tag: String?
    var model: String?
    var q = ""

    func validated() throws -> Self {
        var value = self
        guard FeedValidation.locale(locale), kind == nil || ["text", "image", "video", "web", "skill"].contains(kind!),
              [creator, tag, model, q].compactMap({ $0 }).allSatisfy({ !$0.unicodeScalars.contains { $0.value < 32 || $0.value == 127 } }),
              collection == nil || FeedCollections.definitions[collection!] != nil,
              creator == nil || FeedValidation.text(creator!, max: 200),
              tag == nil || FeedValidation.text(tag!, max: 100), model == nil || FeedValidation.text(model!, max: 200) else { throw FeedError.invalidQuery }
        value.q = String(q.decomposedStringWithCompatibilityMapping.unicodeScalars.filter { !(0x300...0x36f).contains($0.value) })
            .precomposedStringWithCompatibilityMapping.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard value.q.utf16.count <= 120, value.q.split(separator: " ").count <= 8 else { throw FeedError.invalidQuery }
        return value
    }
    var parameters: [URLQueryItem] {
        var values = [URLQueryItem(name: "locale", value: locale)]
        for (name, value) in [("kind", kind), ("collection", collection), ("creator", creator), ("tag", tag), ("model", model), ("q", q.isEmpty ? nil : q)] {
            if let value { values.append(URLQueryItem(name: name, value: value)) }
        }
        return values
    }
}

enum FeedValidation {
    static func text(_ value: String, max: Int) -> Bool { !value.isEmpty && value.utf16.count <= max }
    static func id(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 200 && value.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
    }
    static func revision(_ value: String) -> Bool { value.utf8.count == 64 && value.utf8.allSatisfy { (97...102).contains($0) || (48...57).contains($0) } }
    static func release(_ value: String) -> Bool { value.hasPrefix("feed-") && revision(String(value.dropFirst(5))) }
    static func locale(_ value: String) -> Bool { value == "original" || ContentLanguage.supported.contains(value) }
    static func languages(_ values: [String]) -> Bool {
        values.count <= 9 && Set(values).count == values.count && values.allSatisfy(ContentLanguage.supported.contains)
    }
    static func cursor(_ value: String?) -> Bool {
        guard let value else { return true }
        return text(value, max: 2048) && value.unicodeScalars.allSatisfy { $0.value >= 32 && $0.value != 127 }
    }
    static func sequence(_ value: String) -> UInt64? {
        guard !value.isEmpty, value.utf8.count <= 18, value == "0" || !value.hasPrefix("0"),
              value.utf8.allSatisfy({ (48...57).contains($0) }) else { return nil }
        return UInt64(value)
    }
}

/// Shared trust boundary for legacy full records and database cards.
enum ContentValidation {
    static func creator(_ value: Prompt.Creator?) throws {
        guard let value else { return }
        guard FeedValidation.text(value.id, max: 200), FeedValidation.text(value.displayName, max: 200),
              value.username == nil || FeedValidation.text(value.username!, max: 200),
              value.externalID == nil || FeedValidation.text(value.externalID!, max: 200),
              value.bio == nil || FeedValidation.text(value.bio!, max: 2000),
              ["x", "github", "web"].contains(value.platform), value.profileURL.scheme == "https" else { throw Catalog.CatalogError.invalidItems }
        if let avatar = value.avatarURL, !mediaURL(avatar) { throw Catalog.CatalogError.invalidItems }
    }
    static func media(_ value: Prompt.Media?) throws {
        guard let value else { return }
        if let ratio = value.aspectRatio, !(0.1...10).contains(ratio) { throw Catalog.CatalogError.invalidItems }
        guard (value.imageURLs?.count ?? 0) <= 8 else { throw Catalog.CatalogError.invalidItems }
        if let gallery = value.imageURLs, gallery.isEmpty || gallery.first != value.imageURL { throw Catalog.CatalogError.invalidItems }
        guard ([value.imageURL, value.videoURL].compactMap { $0 } + (value.imageURLs ?? [])).allSatisfy(mediaURL),
              value.demoURL == nil || value.demoURL?.scheme == "https" else { throw Catalog.CatalogError.invalidItems }
    }
    static func mediaURL(_ url: URL) -> Bool { url.scheme == "https" && url.host == "api.prompix.dev" && url.path.hasPrefix("/media/") }
}
