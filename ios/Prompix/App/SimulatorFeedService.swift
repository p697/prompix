#if DEBUG && targetEnvironment(simulator)
import Foundation

/// First-party fixtures exercise the real views/repository without paid services.
/// Only explicit simulator launches can use them; release builds contain no fixture.
actor SimulatorFeedService: FeedServing {
    static let revision = String(repeating: "d", count: 64)
    static let release = "feed-" + String(repeating: "e", count: 64)
    static let count = 10000
    private let directory: URL
    private let offline: Bool
    private let removed: Bool
    private var failed = Set<String>()
    init(directory: URL, offline: Bool, removed: Bool) {
        self.directory = directory; self.offline = offline; self.removed = removed
    }
    private func record(_ operation: String, query: String = "", cursor: String? = nil) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appending(path: "requests.jsonl")
        let data = try JSONSerialization.data(withJSONObject: ["operation": operation, "query": query, "cursor": cursor ?? "", "offline": offline]) + Data([10])
        if !FileManager.default.fileExists(atPath: url.path) { try Data().write(to: url) }
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd(); try handle.write(contentsOf: data)
        if offline { throw URLError(.notConnectedToInternet) }
    }
    private func creator(_ index: Int) -> Prompt.Creator {
        .init(id: "fixture-author-\(index)", platform: "web", displayName: "Database Author \(index)",
              profileURL: URL(string: "https://example.com/author/\(index)")!)
    }
    private func prompt(_ index: Int) -> Prompt {
        Prompt(id: "database-fixture-\(index)", kind: [.text, .image, .video, .web][index % 4],
               title: String(format: "Database item %04d", index), summary: "First-party content for database feed acceptance.",
               prompt: "  Original fixture \(index)\nPreserve whitespace and [topic].\n", example: "A synthetic example",
               tags: ["好玩一点", "肖像", "写作"], model: "Model \(index % 4)", toolURL: nil,
               artwork: "text-editorial", previewLabel: "Synthetic preview",
               source: .init(name: "Prompix", url: nil, license: "Original", method: "Acceptance fixture"),
               media: nil, creator: creator(index % 75))
    }
    private func card(_ index: Int) -> FeedCard {
        let item = prompt(index)
        return FeedCard(id: item.id, revision: Self.revision, kind: item.kind, contentType: "prompt",
            title: item.title, summary: item.summary, tags: item.tags, model: item.model, artwork: item.artwork,
            previewLabel: item.previewLabel, creator: item.creator, media: nil, cover: nil, language: "original", availableLanguages: ["en", "ja"])
    }
    func page(query: FeedQuery, cursor: String?, release: String?) async throws -> FeedPage {
        try record("page", query: query.q, cursor: cursor)
        if query.q == "slow" { try? await Task.sleep(for: .seconds(2)) }
        if query.q == "retry", failed.insert("page-retry").inserted { throw FeedError.rateLimited(2) }
        let indices = (0..<Self.count).filter { index in
            if removed && index == 0 { return false }
            let item = prompt(index)
            if let kind = query.kind, item.kind.rawValue != kind { return false }
            if let creator = query.creator, item.creator?.id != creator { return false }
            if let model = query.model, item.model != model { return false }
            if let tag = query.tag, !item.tags.contains(tag) { return false }
            if let collection = query.collection, let definition = FeedCollections.definitions[collection] {
                if let kind = definition.kind, kind != item.kind.rawValue { return false }
                if !definition.tags.isEmpty && Set(definition.tags).isDisjoint(with: item.tags) { return false }
            }
            if query.q == "empty" { return false }
            if ["tail", "current"].contains(query.q) { return index == 9999 }
            return true
        }
        let start = Int(cursor ?? "0") ?? 0
        let page = Array(indices.dropFirst(start).prefix(FeedClient.pageSize))
        return FeedPage(schemaVersion: 3, release: Self.release, items: page.map(card),
                        nextCursor: start + page.count < indices.count ? String(start + page.count) : nil)
    }
    func detail(id: String, revision: String?, locale: String) async throws -> FeedDetail {
        try record("detail", query: id + ":" + locale)
        guard let index = Int(id.split(separator: "-").last ?? ""), (0..<Self.count).contains(index) else { throw FeedError.notFound }
        if removed && index == 0 { throw FeedError.removed }
        var item = prompt(index)
        item.localization = .init(sourceLanguage: "en", sourceFingerprint: LanguagePackCatalog.sourceFingerprint(item),
            translations: ["en", "ja"].contains(locale) ? [locale: .init(title: item.title, summary: item.summary,
                prompt: "  \(locale) fixture \(index)\nPreserve whitespace and [topic].\n", example: "Example", previewLabel: "Preview")] : [:])
        return FeedDetail(schemaVersion: 3, revision: Self.revision, item: item, availableLanguages: ["en", "ja"])
    }
    func creators(q: String, cursor: String?, release: String?) async throws -> FeedCreatorsPage {
        try record("creators", query: q, cursor: cursor)
        let values = (0..<75).filter { q.isEmpty || creator($0).matchesSearch(q) }
        let start = Int(cursor ?? "0") ?? 0, indices = Array(values.dropFirst(start).prefix(FeedClient.pageSize))
        return FeedCreatorsPage(schemaVersion: 3, release: Self.release, items: indices.map { index in
            .init(creator: creator(index), count: (Self.count - 1 - index) / 75 + 1)
        }, nextCursor: start + indices.count < values.count ? String(start + indices.count) : nil)
    }
    func browse(locale: String) async throws -> FeedBrowse {
        try record("browse")
        return FeedBrowse(schemaVersion: 3, release: Self.release, collections: FeedCollections.definitions.keys.sorted().map { id in
            let definition = FeedCollections.definitions[id]!
            let indices = (0..<Self.count).filter {
                let item = prompt($0)
                return (definition.kind == nil || definition.kind == item.kind.rawValue) &&
                    (definition.tags.isEmpty || !Set(definition.tags).isDisjoint(with: item.tags)) && (!removed || $0 != 0)
            }
            return .init(id: id, count: indices.count, covers: indices.prefix(2).map(card))
        }, models: (0..<4).map { .init(name: "Model \($0)", count: 2500) }, modelCount: 4)
    }
    func state() async throws -> FeedState {
        try record("state")
        return FeedState(schemaVersion: 3, release: Self.release, generation: "1", removalSequence: removed ? "1" : "0", count: Self.count - (removed ? 1 : 0), publishedAt: nil)
    }
    func removals(after: String) async throws -> FeedRemovals {
        try record("removals", cursor: after)
        return FeedRemovals(schemaVersion: 3, items: removed && after == "0" ? [.init(sequence: "1", id: "database-fixture-0")] : [],
                            nextAfter: removed ? "1" : after, hasMore: false)
    }
}
#endif
