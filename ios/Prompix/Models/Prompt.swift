import Foundation

enum PromptKind: String, Codable, CaseIterable, Identifiable {
    case text, image, video, web
    var id: String { rawValue }
    var title: String {
        switch self { case .text: "文本"; case .image: "图片"; case .video: "视频"; case .web: "网页" }
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
    var searchableText: String { ([title, summary, prompt, model] + tags).joined(separator: " ") }

    struct Source: Codable, Hashable {
        let name: String
        let url: URL?
        let license: String
        let method: String
        var author: String? = nil
        var repository: URL? = nil
        var revision: String? = nil
    }
    struct Media: Codable, Hashable {
        let image: String?
        let video: String?
        let demoURL: URL?
        var imageURL: URL? = nil
        var aspectRatio: Double? = nil
        var videoURL: URL? = nil
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
            let mediaURLs = [item.media?.imageURL, item.media?.videoURL].compactMap { $0 }
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
        if let topic, !prompt.tags.contains(topic) { return false }
        if let model, prompt.model != model { return false }
        let terms = text.split(whereSeparator: { $0.isWhitespace })
        return terms.allSatisfy { prompt.searchableText.localizedStandardContains(String($0)) }
    }
}
