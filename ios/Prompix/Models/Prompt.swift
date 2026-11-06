import Foundation

enum PromptKind: String, Codable, CaseIterable, Identifiable {
    case text, image, video, web
    var id: String { rawValue }
    var title: String {
        switch self { case .text: String(localized: "文本"); case .image: String(localized: "图片"); case .video: String(localized: "视频"); case .web: String(localized: "网页") }
    }
    var symbol: String {
        switch self { case .text: "text.alignleft"; case .image: "photo"; case .video: "play.rectangle"; case .web: "safari" }
    }
}

struct Prompt: Codable, Identifiable, Hashable {
    let id: String
    let kind: PromptKind
    let title: String
    let summary: String
    let prompt: String
    let example: String
    let tags: [String]
    let model: String
    let toolURL: URL?
    let artwork: String
    let previewLabel: String
    let source: Source
    let media: Media?
    var cover: Cover? = nil
    var contentType: String? = nil
    var creator: Creator? = nil
    var skill: Skill? = nil
    var localization: Localization? = nil
    var presentation: String? = nil
    var publishedAt: String? = nil
    var inputs: Inputs? = nil
    var generation: Generation? = nil
    var variables: [Variable]? = nil
    var facets: Facets? = nil
    var palette: [Swatch]? = nil
    var shots: [Shot]? = nil
    var rights: Rights? = nil
    // Local snapshot metadata; never sent to the content service or included in
    // source fingerprints. It keeps saved and open details on their own revision.
    var feedRevision: String? = nil
    var feedLanguages: [String]? = nil
    var isSkill: Bool { contentType == "skill" && skill != nil }
    var displayKind: String { isSkill ? "Skill" : kind.title }
    var displaySymbol: String { isSkill ? "square.stack.3d.up" : kind.symbol }
    var displayModel: String { Self.localizedModel(model) }
    /// Sources that never named a model say "Unspecified"; the interface then names none.
    static func namesModel(_ value: String) -> Bool { value.caseInsensitiveCompare("Unspecified") != .orderedSame }
    static func localizedModel(_ value: String) -> String {
        switch value {
        case "通用对话模型": String(localized: "通用对话模型")
        case "通用文本模型": String(localized: "通用文本模型")
        case "v0 / 网站生成工具": String(localized: "v0 / 网站生成工具")
        case "图像模型": String(localized: "图像模型")
        default: value
        }
    }
    /// Search originals and the translations already available in the active
    /// catalog. A locale change must not make those original terms disappear.
    var searchableTitles: [String] {
        [title] + (localization?.translations.values.map(\.title) ?? [])
    }
    var searchableText: String {
        let originals = [title, summary, prompt, example, previewLabel]
        let translations = localization?.translations.values.flatMap {
            [$0.title, $0.summary, $0.prompt, $0.example, $0.previewLabel]
        } ?? []
        let identity = [model, displayModel, displayKind, kind.rawValue, isSkill ? "skill skills agent-skills" : "prompt prompts",
                        source.name, source.author ?? "", creator?.searchableIdentity ?? "", skill?.name ?? "", skill?.description ?? ""]
        return (originals + translations + identity + tags).joined(separator: " ")
    }

    struct Creator: Codable, Hashable, Identifiable {
        let id: String
        let platform: String
        let displayName: String
        var username: String? = nil
        let profileURL: URL
        var avatarURL: URL? = nil
        var externalID: String? = nil
        var bio: String? = nil
        var platformName: String { platform == "x" ? "X" : platform == "github" ? "GitHub" : String(localized: "网站") }
        var searchableIdentity: String {
            [displayName, username ?? "", username.map { "@" + $0.trimmingCharacters(in: CharacterSet(charactersIn: "@")) } ?? "", platformName].joined(separator: " ")
        }
        func matchesSearch(_ query: String) -> Bool {
            let identity = searchableIdentity
            return query.split(whereSeparator: { $0.isWhitespace }).allSatisfy { identity.containsSearchTerm(String($0)) }
        }

        var platformIdentity: String? {
            if let externalID, !externalID.isEmpty { return externalID }
            let prefix = platform + "-id-"
            guard id.hasPrefix(prefix) else { return nil }
            let suffix = String(id.dropFirst(prefix.count))
            return !suffix.isEmpty && suffix.allSatisfy(\.isNumber) ? suffix : nil
        }
        var identityKey: String { platform + ":" + id }
        func hasConflictingIdentity(with other: Self) -> Bool {
            guard platform == other.platform else { return true }
            if let first = platformIdentity, let second = other.platformIdentity { return first != second }
            return false
        }
        func matchesIdentity(of other: Self) -> Bool {
            guard !hasConflictingIdentity(with: other) else { return false }
            if let first = platformIdentity, let second = other.platformIdentity { return first == second }
            if id == other.id { return true }
            // X and GitHub handles are case-insensitive within their platforms.
            // A display name is never evidence that two accounts are the same.
            guard ["x", "github"].contains(platform), let first = normalizedUsername,
                  let second = other.normalizedUsername else { return false }
            return first == second
        }
        private var normalizedUsername: String? {
            guard let username else { return nil }
            let normalized = username.trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "@")).lowercased()
            return normalized.isEmpty ? nil : normalized
        }
    }
    struct Skill: Codable, Hashable {
        let name: String
        let description: String
        let format: String
        let entrypoint: String
        let repository: URL
        let directory: String
        let installURL: URL
        var files: [String]? = nil
    }
    struct Localization: Codable, Hashable {
        let sourceLanguage: String
        let sourceFingerprint: String
        let translations: [String: TranslatedContent]
        /// English card text for items without a full English translation.
        var en: CardText? = nil
    }
    struct CardText: Codable, Hashable, Sendable {
        let title: String
        let summary: String
    }

    // Prompix 2.0 fields, defined in packages/schema/enrichment.ts. Every one is
    // optional; vocabularies stay plain strings so a newer server value never makes
    // this app reject a card. `enrichmentSanitized()` drops anything malformed.
    struct Inputs: Codable, Hashable, Sendable {
        let requirement: String
        var count: Int? = nil
        let kinds: [String]
        var ownLikenessOnly: Bool? = nil
    }
    struct Generation: Codable, Hashable, Sendable {
        let modelFamily: String
        var modelVersion: String? = nil
        let mode: String
        var outputAspect: String? = nil
        var durationSeconds: Double? = nil
        var hasAudio: Bool? = nil
    }
    struct Bilingual: Codable, Hashable, Sendable {
        let zh: String
        let en: String
    }
    struct Variable: Codable, Hashable, Sendable {
        let token: String
        let name: Bilingual
        var `default`: String? = nil
        var hint: Bilingual? = nil
    }
    struct Facets: Codable, Hashable, Sendable {
        let useCase: [String]
        let style: [String]
        let subject: [String]
    }
    struct Swatch: Codable, Hashable, Sendable {
        let hex: String
        let weight: Double
    }
    struct Shot: Codable, Hashable, Sendable {
        let index: Int
        var startSec: Double? = nil
        var endSec: Double? = nil
        let text: String
    }
    struct Rights: Codable, Hashable, Sendable {
        let license: String
        let basis: String
        let imageExport: Bool
    }
    struct TranslatedContent: Codable, Hashable {
        let title: String
        let summary: String
        let prompt: String
        let example: String
        let previewLabel: String
        var cover: TranslatedCover? = nil
    }
    struct TranslatedCover: Codable, Hashable {
        let text: String
        let eyebrow: String
    }

    func fits(topic: String) -> Bool {
        // Stable content tags are independent of the interface language.
        if topic == "创作灵感", kind != .text { return true }
        return tags.contains(topic)
    }

    struct SourcePost: Codable, Hashable {
        let id: String
        let authorID: String
        let text: String
        let createdAt: String
        let checkedAt: String
        var parentID: String? = nil

        var date: Date? {
            let parser = ISO8601DateFormatter()
            parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = parser.date(from: createdAt) { return date }
            parser.formatOptions = [.withInternetDateTime]
            return parser.date(from: createdAt)
        }
    }
    struct Source: Codable, Hashable {
        let name: String
        let url: URL?
        let license: String
        let method: String
        var author: String? = nil
        var repository: URL? = nil
        var revision: String? = nil
        var post: SourcePost? = nil
        var context: [SourcePost]? = nil
        var mediaPostID: String? = nil
    }
    struct Cover: Codable, Hashable {
        let text: String
        let eyebrow: String
        let tone: String
    }
    struct Media: Codable, Hashable {
        let image: String?
        let video: String?
        let demoURL: URL?
        var imageURL: URL? = nil
        var imageURLs: [URL]? = nil
        var aspectRatio: Double? = nil
        var videoURL: URL? = nil
        var galleryURLs: [URL] {
            var seen = Set<URL>()
            return ([imageURL].compactMap { $0 } + (imageURLs ?? [])).filter { seen.insert($0).inserted }
        }
    }
}

struct Catalog: Codable {
    let schemaVersion: Int
    let version: String
    let prompts: [Prompt]
    var publishedAt: String? = nil
    var removedIDs: [String]? = nil

    func validated() throws -> Catalog {
        guard schemaVersion == 1 else { throw CatalogError.unsupportedVersion }
        guard !prompts.isEmpty, prompts.count <= 1000, Set(prompts.map(\.id)).count == prompts.count else { throw CatalogError.invalidItems }
        for item in prompts {
            guard item.feedRevision == nil || FeedValidation.revision(item.feedRevision!),
                  item.feedLanguages == nil || FeedValidation.languages(item.feedLanguages!) else { throw CatalogError.invalidItems }
            guard !item.id.isEmpty, !item.title.isEmpty, !item.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !item.source.name.isEmpty, !item.source.license.isEmpty else { throw CatalogError.invalidItems }
            guard !(removedIDs ?? []).contains(item.id) else { throw CatalogError.invalidItems }
            guard (item.contentType == "skill") == (item.skill != nil) else { throw CatalogError.invalidItems }
            try ContentValidation.creator(item.creator)
            if let skill = item.skill {
                guard skill.format == "agent-skills", skill.entrypoint == "SKILL.md", !skill.name.isEmpty,
                      skill.repository.scheme == "https", skill.installURL.scheme == "https" else { throw CatalogError.invalidItems }
            }
            if let localization = item.localization {
                guard localization.sourceFingerprint.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                      localization.translations.count <= ContentLanguage.supported.count else { throw CatalogError.invalidItems }
                for (language, value) in localization.translations {
                    guard ContentLanguage.supported.contains(language), !value.title.isEmpty, !value.summary.isEmpty,
                          !value.prompt.isEmpty, !value.example.isEmpty, !value.previewLabel.isEmpty,
                          value.prompt.count <= 50_000 else { throw CatalogError.invalidItems }
                }
            }
            try ContentValidation.media(item.media)
            let urls = [item.toolURL, item.source.url, item.media?.demoURL, item.source.repository].compactMap { $0 }
            guard urls.allSatisfy({ $0.scheme == "https" }) else { throw CatalogError.invalidItems }
        }
        return self
    }
    enum CatalogError: Error { case unsupportedVersion, invalidItems }
}

struct PromptQuery: Equatable {
    var text = ""
    var kind: PromptKind?
    var topic: String?
    var model: String?
    var skillsOnly = false
    var creatorID: String?
    /// Rank direct intent matches before incidental mentions in long instructions.
    /// Preserve editorial order for empty queries and equal relevance.
    func results(in items: [Prompt], isCancelled: () -> Bool = { false }) -> [Prompt] {
        let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let terms = query.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        func containsTerms(_ value: String) -> Bool {
            terms.allSatisfy { value.containsSearchTerm($0) }
        }
        func relevance(_ item: Prompt) -> Int {
            guard !terms.isEmpty else { return 0 }
            let titles = item.searchableTitles
            if titles.contains(where: { $0.compare(query, options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: .current) == .orderedSame }) { return 4 }
            if titles.contains(where: containsTerms) { return 3 }
            if containsTerms(item.creator?.searchableIdentity ?? item.source.author ?? "") { return 2 }
            if containsTerms(([item.model, item.displayModel] + item.tags).joined(separator: " ")) { return 1 }
            return 0
        }
        var ranked: [(offset: Int, item: Prompt, rank: Int)] = []
        for (offset, item) in items.enumerated() {
            guard !isCancelled() else { return [] }
            if matches(item) { ranked.append((offset, item, relevance(item))) }
        }
        ranked.sort { $0.rank == $1.rank ? $0.offset < $1.offset : $0.rank > $1.rank }
        return ranked.map { $0.item }
    }

    func matches(_ prompt: Prompt) -> Bool {
        if let kind, prompt.kind != kind || prompt.isSkill { return false }
        if skillsOnly && !prompt.isSkill { return false }
        if let creatorID, prompt.creator?.id != creatorID { return false }
        if let topic, !prompt.fits(topic: topic) { return false }
        if let model, prompt.model != model { return false }
        let terms = text.split(whereSeparator: { $0.isWhitespace })
        guard !terms.isEmpty else { return true }
        let searchable = prompt.searchableText
        return terms.allSatisfy { searchable.containsSearchTerm(String($0)) }
    }
}

private extension String {
    func containsSearchTerm(_ term: String) -> Bool {
        range(of: term, options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: .current) != nil
    }
}

struct RelatedPrompts {
    static func select(for item: Prompt, from items: [Prompt], limit: Int = 4) -> [Prompt] {
        let broad = Set(["好玩一点", "创作灵感", "日常有用", "文本", "图片", "视频", "网页"])
        func specificTags(_ prompt: Prompt) -> Set<String> {
            Set(prompt.tags.filter { !broad.contains($0) }.map { $0.lowercased() })
        }
        let tags = specificTags(item)
        var ranked: [(offset: Int, item: Prompt, score: Int)] = []
        for (index, candidate) in items.enumerated() where candidate.id != item.id {
            let shared = tags.intersection(specificTags(candidate)).count
            var score = shared * 6
            if candidate.kind == item.kind { score += 3 }
            if candidate.model == item.model { score += 1 }
            if score > 0 { ranked.append((index, candidate, score)) }
        }
        ranked.sort { left, right in
            left.score == right.score ? left.offset < right.offset : left.score > right.score
        }
        return ranked.prefix(max(0, limit)).map(\.item)
    }
}

/// Public information routes never include personal drafts or saved collections.
enum SupportLinks {
    enum Page: String { case home = "", support, privacy, content, report }
    static func url(_ page: Page, contentID: String? = nil, language: String = Bundle.main.preferredLocalizations.first ?? "en") -> URL {
        var parts = URLComponents(string: "https://prompix.dev")!
        let prefix = language.lowercased().hasPrefix("zh") ? "/zh" : ""
        parts.path = prefix + (page.rawValue.isEmpty ? "" : "/\(page.rawValue)")
        if page == .report, let contentID { parts.queryItems = [URLQueryItem(name: "id", value: contentID)] }
        return parts.url!
    }
}

extension Prompt.Inputs {
    var isValid: Bool {
        ["none", "optional", "required"].contains(requirement) && kinds.count <= 6 && Set(kinds).count == kinds.count
            && (requirement == "none") == kinds.isEmpty && (count.map { (1...8).contains($0) } ?? true)
            && (ownLikenessOnly == nil || kinds.contains("face"))
    }
}
extension Prompt.Generation {
    var isValid: Bool {
        FeedValidation.text(modelFamily, max: 40) && FeedValidation.text(mode, max: 20)
            && (modelVersion.map { FeedValidation.text($0, max: 40) } ?? true)
            && (outputAspect.map { $0.wholeMatch(of: /[1-9]\d{0,2}:[1-9]\d{0,2}/) != nil } ?? true)
            && (durationSeconds.map { $0 > 0 && $0 <= 3600 } ?? true)
    }
}
extension Prompt.Facets {
    var isValid: Bool {
        [(useCase, 2), (style, 3), (subject, 3)].allSatisfy { values, limit in
            values.count <= limit && Set(values).count == values.count && values.allSatisfy { FeedValidation.text($0, max: 40) }
        }
    }
}
enum Enrichment {
    static func palette(_ value: [Prompt.Swatch]?) -> [Prompt.Swatch]? {
        guard let value, value.count == 3,
              value.allSatisfy({ $0.hex.wholeMatch(of: /#[0-9A-F]{6}/) != nil && (0...1).contains($0.weight) }),
              zip(value, value.dropFirst()).allSatisfy({ $0.weight >= $1.weight }),
              value.reduce(0, { $0 + $1.weight }) <= 1.0001 else { return nil }
        return value
    }
    static func rights(_ value: Prompt.Rights?) -> Prompt.Rights? {
        guard let value, FeedValidation.text(value.license, max: 80), ["license", "attribution-only"].contains(value.basis),
              value.basis == "license" || !value.imageExport else { return nil }
        return value
    }
    static func card(_ value: Prompt.CardText?) -> Prompt.CardText? {
        guard let value, FeedValidation.text(value.title, max: 250), FeedValidation.text(value.summary, max: 4000) else { return nil }
        return value
    }
}

extension Prompt {
    /// Keeps only well-formed 2.0 fields. Variables must point at text in the prompt.
    func enrichmentSanitized() -> Prompt {
        var item = self
        if item.inputs?.isValid == false { item.inputs = nil }
        if item.generation?.isValid == false { item.generation = nil }
        if item.facets?.isValid == false { item.facets = nil }
        item.palette = Enrichment.palette(item.palette)
        item.rights = Enrichment.rights(item.rights)
        if let variables = item.variables, variables.count > 16 || Set(variables.map(\.token)).count != variables.count
            || !variables.allSatisfy({ FeedValidation.text($0.token, max: 120) && item.prompt.contains($0.token) }) { item.variables = nil }
        if let shots = item.shots, shots.count < 2 || shots.count > 64 || shots.enumerated().contains(where: { offset, shot in
            shot.index != offset + 1 || !FeedValidation.text(shot.text, max: 2000)
                || (shot.startSec != nil && shot.endSec != nil && shot.endSec! <= shot.startSec!)
        }) { item.shots = nil }
        if let localization = item.localization, localization.en != nil, Enrichment.card(localization.en) == nil {
            item.localization?.en = nil
        }
        return item
    }
}
