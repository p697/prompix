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
    var publishedAt: String? = nil
    var isSkill: Bool { contentType == "skill" && skill != nil }
    var displayKind: String { isSkill ? "Skill" : kind.title }
    var displaySymbol: String { isSkill ? "square.stack.3d.up" : kind.symbol }
    var displayModel: String { Self.localizedModel(model) }
    static func localizedModel(_ value: String) -> String {
        switch value {
        case "通用对话模型": String(localized: "通用对话模型")
        case "通用文本模型": String(localized: "通用文本模型")
        case "v0 / 网站生成工具": String(localized: "v0 / 网站生成工具")
        case "图像模型": String(localized: "图像模型")
        default: value
        }
    }
    var searchableText: String {
        ([title, summary, prompt, model, displayModel, displayTitle, displaySummary, displayContent.prompt, displayContent.example, displayKind,
          source.name, source.author ?? "", creator?.searchableIdentity ?? ""] + tags).joined(separator: " ")
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
            query.split(whereSeparator: { $0.isWhitespace }).allSatisfy { searchableIdentity.localizedStandardContains(String($0)) }
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
            guard !item.id.isEmpty, !item.title.isEmpty, !item.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !item.source.name.isEmpty, !item.source.license.isEmpty else { throw CatalogError.invalidItems }
            guard !(removedIDs ?? []).contains(item.id) else { throw CatalogError.invalidItems }
            guard (item.contentType == "skill") == (item.skill != nil) else { throw CatalogError.invalidItems }
            if let creator = item.creator {
                guard !creator.id.isEmpty, !creator.displayName.isEmpty,
                      ["x", "github", "web"].contains(creator.platform), creator.profileURL.scheme == "https" else { throw CatalogError.invalidItems }
                if let avatar = creator.avatarURL {
                    guard avatar.scheme == "https", avatar.host == "api.prompix.dev", avatar.path.hasPrefix("/media/") else { throw CatalogError.invalidItems }
                }
            }
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
            if let ratio = item.media?.aspectRatio, !(0.1...10).contains(ratio) { throw CatalogError.invalidItems }
            guard (item.media?.imageURLs?.count ?? 0) <= 8 else { throw CatalogError.invalidItems }
            if let gallery = item.media?.imageURLs, gallery.isEmpty || gallery.first != item.media?.imageURL { throw CatalogError.invalidItems }
            let mediaURLs = [item.media?.imageURL, item.media?.videoURL].compactMap { $0 } + (item.media?.imageURLs ?? [])
            guard mediaURLs.allSatisfy({ $0.scheme == "https" && $0.host == "api.prompix.dev" && $0.path.hasPrefix("/media/") }) else { throw CatalogError.invalidItems }
            let urls = [item.toolURL, item.source.url, item.media?.demoURL, item.source.repository].compactMap { $0 }
            guard urls.allSatisfy({ $0.scheme == "https" }) else { throw CatalogError.invalidItems }
        }
        return self
    }
    enum CatalogError: Error { case unsupportedVersion, invalidItems }
}

struct PromptQuery {
    var text = ""
    var kind: PromptKind?
    var topic: String?
    var model: String?
    var skillsOnly = false
    var creatorID: String?
    func matches(_ prompt: Prompt) -> Bool {
        if let kind, prompt.kind != kind || prompt.isSkill { return false }
        if skillsOnly && !prompt.isSkill { return false }
        if let creatorID, prompt.creator?.id != creatorID { return false }
        if let topic, !prompt.fits(topic: topic) { return false }
        if let model, prompt.model != model { return false }
        let terms = text.split(whereSeparator: { $0.isWhitespace })
        return terms.allSatisfy { prompt.searchableText.localizedStandardContains(String($0)) }
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
