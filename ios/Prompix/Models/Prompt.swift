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
    var searchableText: String { ([title, summary, prompt, model] + tags).joined(separator: " ") }

    func fits(topic: String) -> Bool {
        // Stable content tags are independent of the interface language.
        if topic == "创作灵感", kind != .text { return true }
        return tags.contains(topic)
    }

    struct Source: Codable, Hashable {
        let name: String
        let url: URL?
        let license: String
        let method: String
        var author: String? = nil
        var repository: URL? = nil
        var revision: String? = nil
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
            if let ratio = item.media?.aspectRatio, !(0.1...10).contains(ratio) { throw CatalogError.invalidItems }
            guard (item.media?.imageURLs?.count ?? 0) <= 8 else { throw CatalogError.invalidItems }
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
    func matches(_ prompt: Prompt) -> Bool {
        if let kind, prompt.kind != kind { return false }
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
