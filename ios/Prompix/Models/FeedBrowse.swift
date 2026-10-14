import Foundation
import Observation

enum FeedCollections {
    struct Definition: Decodable { let tags: [String]; let kind: String? }
    static let definitions: [String: Definition] = {
        guard let url = Bundle.main.url(forResource: "collections", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let value = try? JSONDecoder().decode([String: Definition].self, from: data) else { return [:] }
        return value
    }()
}

struct FeedBrowse: Codable, Sendable {
    struct Topic: Codable, Identifiable, Sendable {
        let id: String
        let count: Int
        let covers: [FeedCard]
    }
    struct Model: Codable, Identifiable, Sendable {
        let name: String
        let count: Int
        var id: String { name }
    }
    let schemaVersion: Int
    let release: String
    let collections: [Topic]
    let models: [Model]
    let modelCount: Int
    func validated(locale: String) throws -> Self {
        guard schemaVersion == 3, FeedValidation.release(release), collections.count <= 50,
              Set(collections.map(\.id)).count == collections.count,
              models.count <= 50, (models.count...100000).contains(modelCount),
              Set(models.map(\.name)).count == models.count else { throw FeedError.invalidResponse }
        for topic in collections {
            guard FeedValidation.id(topic.id), (0...100000).contains(topic.count), topic.covers.count <= min(2, topic.count),
                  Set(topic.covers.map(\.id)).count == topic.covers.count else { throw FeedError.invalidResponse }
            for card in topic.covers { _ = try card.validated(locale: locale) }
        }
        guard models.allSatisfy({ FeedValidation.text($0.name, max: 200) && (1...100000).contains($0.count) }) else { throw FeedError.invalidResponse }
        return self
    }
}

@MainActor @Observable final class FeedBrowseStore {
    private(set) var value: FeedBrowse?
    private(set) var failure: (any Error)?
    private(set) var isLoading = false
    private(set) var isCached = false
    private(set) var retryAt: Date?
    private var loadedAt: Date?
    private var locale: String?
    private var owner: UUID?
    private let service: any FeedServing
    private let cache: FeedCache
    init(service: any FeedServing, cache: FeedCache) { self.service = service; self.cache = cache }
    func load(locale: String = ContentLanguage.preferred, force: Bool = false, now: Date = Date()) async {
        guard !Task.isCancelled, !isLoading, retryAt == nil || now >= retryAt! else { return }
        if !force, self.locale == locale, let loadedAt, now.timeIntervalSince(loadedAt) < 300 { return }
        let token = UUID(); owner = token; isLoading = true; failure = nil
        defer { if owner == token { isLoading = false } }
        if self.locale != locale {
            value = try? await cache.browse(locale: locale); isCached = value != nil; self.locale = locale
        }
        do {
            let value = try await service.browse(locale: locale).validated(locale: locale)
            try Task.checkCancellation()
            guard owner == token else { return }
            self.value = value; self.loadedAt = now; isCached = false; retryAt = nil
            try? await cache.store(value, locale: locale)
        } catch {
            guard owner == token, !(error is CancellationError), (error as? URLError)?.code != .cancelled else { return }
            failure = error
            if case let FeedError.rateLimited(seconds) = error { retryAt = now.addingTimeInterval(seconds) }
            if case let FeedError.unavailable(seconds) = error { retryAt = now.addingTimeInterval(seconds) }
        }
    }
}
