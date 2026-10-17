import Foundation
import Observation

struct FeedCheckpoint: Codable {
    static let fileName = "feed-checkpoint.json"
    var after = "0"
    var removedIDs: [String] = []
    func validated() throws -> Self {
        guard FeedValidation.sequence(after) != nil, removedIDs.count <= 200000,
              removedIDs.allSatisfy(FeedValidation.id), Set(removedIDs).count == removedIDs.count else { throw FeedError.invalidResponse }
        return self
    }
}

@MainActor @Observable final class FeedRepository {
    let discovery: FeedStore
    let search: FeedStore
    let creatorDiscovery: CreatorDiscoveryStore
    let creators: FeedCreatorStore
    let browse: FeedBrowseStore
    let service: any FeedServing
    let cache: FeedCache
    private(set) var state: FeedState?
    private(set) var removedIDs: Set<String>
    private(set) var details: [String: FeedDetail] = [:]
    private var detailOrder: [String] = []
    private var detailSizes: [String: Int] = [:]
    private var checkpoint: FeedCheckpoint
    private let commitRemovals: (FeedCheckpoint) throws -> Void
    init(service: any FeedServing, cache: FeedCache, checkpoint: FeedCheckpoint,
         commitRemovals: @escaping (FeedCheckpoint) throws -> Void) {
        self.service = service; self.cache = cache; self.checkpoint = checkpoint; self.commitRemovals = commitRemovals
        removedIDs = Set(checkpoint.removedIDs)
        creatorDiscovery = CreatorDiscoveryStore(service: service, cache: cache)
        creators = FeedCreatorStore(service: service, cache: cache); browse = FeedBrowseStore(service: service, cache: cache)
        discovery = FeedStore(service: service, cache: cache, memoryPageLimit: 6); search = FeedStore(service: service, cache: cache)
    }
    func makeCreatorDiscoveryStore() -> CreatorDiscoveryStore { CreatorDiscoveryStore(service: service, cache: cache) }
    func makeCreatorStore() -> FeedCreatorStore { FeedCreatorStore(service: service, cache: cache) }
    func makeStore() -> FeedStore { FeedStore(service: service, cache: cache) }

    func creatorPreview(_ entry: FeedCreatorsPage.Entry) -> FeedCard? {
        guard let preview = entry.preview, !removedIDs.contains(preview.id) else { return nil }
        return preview
    }

    /// A few already visible cards can preview an exact scoped query while its
    /// first page arrives. They never become a page, cursor, or result count.
    func previewCards(for value: FeedQuery) -> [FeedCard] {
        guard let query = try? value.validated(), query.q.isEmpty, query.collection == nil,
              query.creator != nil || query.tag != nil || query.model != nil else { return [] }
        var seen = Set<String>()
        var result: [FeedCard] = []
        for card in [discovery.items, search.items].joined() {
            guard !self.removedIDs.contains(card.id),
                  card.language == query.locale || (card.language == "original" && !card.availableLanguages.contains(query.locale)),
                  query.creator == nil || card.creator?.id == query.creator,
                  query.tag == nil || card.tags.contains(query.tag!),
                  query.model == nil || card.model == query.model,
                  query.kind == nil || (query.kind == "skill" ? card.contentType == "skill" : card.contentType != "skill" && card.kind.rawValue == query.kind)
            else { continue }
            guard seen.insert(card.id).inserted else { continue }
            result.append(card)
            if result.count == 6 { break }
        }
        return result
    }
    func refresh() async throws {
        let state = try await service.state().validated()
        var more = true
        while more {
            try Task.checkCancellation()
            let page = try await service.removals(after: checkpoint.after).validated(after: checkpoint.after)
            var next = checkpoint
            next.after = page.nextAfter
            next.removedIDs = Set(next.removedIDs).union(page.items.map(\.id)).sorted()
            try await apply(next)
            more = page.hasMore
        }
        guard let observed = FeedValidation.sequence(checkpoint.after), let expected = FeedValidation.sequence(state.removalSequence),
              observed >= expected else { throw FeedError.invalidResponse }
        try Task.checkCancellation()
        self.state = state
    }
    /// Only a complete matching revision/locale can skip the progressive state.
    func cachedDetail(for card: FeedCard, locale: String = ContentLanguage.preferred) -> Prompt? {
        cachedDetail(id: card.id, revision: card.revision, locale: locale)
    }
    private func cachedDetail(id: String, revision: String?, locale: String) -> Prompt? {
        guard !removedIDs.contains(id), let revision, let value = details[id], value.revision == revision,
              locale == "original" || !value.availableLanguages.contains(locale) || value.item.localization?.translations[locale] != nil else { return nil }
        return value.item
    }
    func detail(for card: FeedCard, locale: String = ContentLanguage.preferred) async throws -> Prompt {
        try await loadDetail(id: card.id, revision: card.revision, locale: locale).item
    }
    func loadDetail(id: String, revision: String?, locale: String) async throws -> FeedDetail {
        guard !removedIDs.contains(id) else { throw FeedError.removed }
        if let item = cachedDetail(id: id, revision: revision, locale: locale), let revision {
            try Task.checkCancellation()
            return FeedDetail(schemaVersion: 3, revision: revision, item: item, availableLanguages: item.feedLanguages ?? [])
        }
        if let revision, let cached = try? await cache.detail(id: id, revision: revision, locale: locale) {
            try Task.checkCancellation()
            guard !removedIDs.contains(id) else { throw FeedError.removed }
            let annotated = Self.annotated(cached)
            remember(annotated); return annotated
        }
        do {
            let result = Self.annotated(try await service.detail(id: id, revision: revision, locale: locale).validated(id: id, revision: revision, locale: locale))
            try Task.checkCancellation()
            guard !removedIDs.contains(id) else { throw FeedError.removed }
            remember(result)
            try? await cache.store(result, locale: locale)
            try Task.checkCancellation()
            guard !removedIDs.contains(id) else { throw FeedError.removed }
            return result
        } catch FeedError.removed {
            var next = checkpoint; next.removedIDs = Set(next.removedIDs).union([id]).sorted()
            try await apply(next)
            throw FeedError.removed
        }
    }
    func resolved(_ snapshot: Prompt) -> Prompt {
        guard let current = details[snapshot.id],
              snapshot.feedRevision == nil || snapshot.feedRevision == current.revision,
              LanguagePackCatalog.sourceFingerprint(current.item) == LanguagePackCatalog.sourceFingerprint(snapshot) else { return snapshot }
        return Self.merging(snapshot, with: current.item, available: current.availableLanguages)
    }
    func availableLanguages(for snapshot: Prompt) -> [String] {
        guard !removedIDs.contains(snapshot.id) else { return [] }
        guard let current = details[snapshot.id],
              snapshot.feedRevision == nil || snapshot.feedRevision == current.revision,
              LanguagePackCatalog.sourceFingerprint(current.item) == LanguagePackCatalog.sourceFingerprint(snapshot) else { return snapshot.feedLanguages ?? snapshot.availableLanguages }
        return current.availableLanguages
    }
    func language(_ locale: String, for snapshot: Prompt) async throws -> Prompt {
        guard !removedIDs.contains(snapshot.id) else { throw FeedError.removed }
        let known = details[snapshot.id].flatMap {
            LanguagePackCatalog.sourceFingerprint($0.item) == LanguagePackCatalog.sourceFingerprint(snapshot) ? $0 : nil
        }
        let result = try await loadDetail(id: snapshot.id, revision: snapshot.feedRevision ?? known?.revision, locale: locale)
        guard LanguagePackCatalog.sourceFingerprint(result.item) == LanguagePackCatalog.sourceFingerprint(snapshot),
              result.item.localization?.translations[locale] != nil else { throw FeedError.notFound }
        return Self.merging(snapshot, with: result.item, available: result.availableLanguages)
    }
    private func apply(_ next: FeedCheckpoint) async throws {
        _ = try next.validated()
        let ids = Set(next.removedIDs)
        guard removedIDs.isSubset(of: ids) else { throw FeedError.invalidResponse }
        // A known takedown blocks use immediately, even if durable storage fails.
        removedIDs = ids; details = details.filter { !ids.contains($0.key) }
        detailSizes = detailSizes.filter { !ids.contains($0.key) }
        detailOrder.removeAll { ids.contains($0) }; discovery.discard(ids); search.discard(ids)
        guard next.after != checkpoint.after || ids != Set(checkpoint.removedIDs) else { return }
        try commitRemovals(next)
        checkpoint = next
        try? await cache.remove(ids: ids)
    }
    private func remember(_ value: FeedDetail) {
        let previous = details[value.item.id]
        let item = previous?.revision == value.revision
            ? Self.merging(previous!.item, with: value.item, available: value.availableLanguages) : value.item
        details[value.item.id] = FeedDetail(schemaVersion: 3, revision: value.revision, item: item, availableLanguages: value.availableLanguages)
        detailSizes[value.item.id] = (try? JSONEncoder().encode(details[value.item.id]).count) ?? 2_000_000
        detailOrder.removeAll { $0 == value.item.id }; detailOrder.append(value.item.id)
        while detailOrder.count > 80 || (detailOrder.count > 1 && detailSizes.values.reduce(0, +) > 16_000_000) {
            let id = detailOrder.removeFirst(); details.removeValue(forKey: id); detailSizes.removeValue(forKey: id)
        }
    }
    static func merging(_ snapshot: Prompt, with fresh: Prompt, available: [String]) -> Prompt {
        guard LanguagePackCatalog.sourceFingerprint(snapshot) == LanguagePackCatalog.sourceFingerprint(fresh) else { return snapshot }
        var item = fresh
        if let metadata = fresh.localization ?? snapshot.localization {
            let translations = (snapshot.localization?.translations ?? [:]).merging(fresh.localization?.translations ?? [:]) { _, value in value }
                .filter { available.contains($0.key) }
            item.localization = Prompt.Localization(sourceLanguage: metadata.sourceLanguage, sourceFingerprint: metadata.sourceFingerprint, translations: translations)
        }
        return item
    }
    private static func annotated(_ detail: FeedDetail) -> FeedDetail {
        var item = detail.item; item.feedRevision = detail.revision; item.feedLanguages = detail.availableLanguages
        return FeedDetail(schemaVersion: 3, revision: detail.revision, item: item, availableLanguages: detail.availableLanguages)
    }
}
