import Foundation
import Observation

struct InterestTopic: Decodable, Identifiable, Sendable {
    let id: String
    let symbol: String
    let aliases: [String]
    let exactAliases: [String]?
    let kinds: [String]?
    var title: String { NSLocalizedString("interest.\(id)", tableName: "Recommendations", comment: "Content interest") }
}

enum InterestCatalog {
    static let topics: [InterestTopic] = {
        guard let url = Bundle.main.url(forResource: "interests", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let value = try? JSONDecoder().decode([InterestTopic].self, from: data) else { return [] }
        return value
    }()
    static let ids = Set(topics.map(\.id))
    static func classify(tags: [String], kind: String, isSkill: Bool) -> [String] {
        let normalized = tags.map { $0.precomposedStringWithCompatibilityMapping.lowercased() }
        return topics.filter { topic in
            (topic.id == "skills" && isSkill) || topic.kinds?.contains(kind) == true ||
            topic.exactAliases?.contains(where: normalized.contains) == true ||
            topic.aliases.contains { alias in normalized.contains { $0.contains(alias) } }
        }.map(\.id)
    }
    static func classify(_ card: FeedCard) -> [String] {
        card.topics ?? classify(tags: card.tags, kind: card.kind.rawValue, isSkill: card.contentType == "skill")
    }
}

/// Bounded content preferences stay on this device. No account, identity traits,
/// source body, search query, network client or telemetry is part of this store.
@MainActor @Observable final class LocalRecommendations {
    enum Event { case impression, open, save, unsave, use, dismiss }
    struct Entry: Codable {
        var topics: [String]
        var kind: String
        var creator: String?
        var updatedAt: Date
        var seenAt: Date?
        var openedAt: Date?
        var saved = false
        var used = false
        var dismissed = false
    }
    struct State: Codable {
        var version = 1
        var interests: Set<String> = []
        var learningEnabled = true
        var reduceSuggestive: Bool? = true
        var entries: [String: Entry] = [:]
    }
    static let maximumEntries = 3000
    static let retention: TimeInterval = 90 * 86400
    private(set) var state = State()
    private(set) var storageFailed = false
    private(set) var preferenceRevision = 0
    private let file: URL?
    private var pendingSave: Task<Void, Never>?
    private var readable = true
    var interests: Set<String> { state.interests }
    var learningEnabled: Bool { state.learningEnabled }
    var reduceSuggestive: Bool { state.reduceSuggestive ?? true }
    func allowsRecommended(_ card: FeedCard) -> Bool { state.entries[card.id]?.dismissed != true && (!reduceSuggestive || card.presentation != "suggestive") }
    var hiddenIDs: Set<String> { Set(state.entries.filter { $0.value.dismissed }.map(\.key)) }

    init(directory: URL? = nil, now: Date = Date()) {
        file = directory?.appending(path: "recommendation-preferences.json")
        guard let file, FileManager.default.fileExists(atPath: file.path) else { return }
        do {
            let attributes = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard attributes.isRegularFile == true, attributes.isSymbolicLink != true, (attributes.fileSize ?? .max) <= 2_000_000 else { throw FeedError.invalidResponse }
            let value = try JSONDecoder().decode(State.self, from: Data(contentsOf: file))
            guard value.version == 1, value.entries.count <= Self.maximumEntries,
                  value.interests.isSubset(of: InterestCatalog.ids), value.entries.allSatisfy({ id, entry in
                      FeedValidation.id(id) && entry.topics.count <= 12 && entry.topics.allSatisfy(InterestCatalog.ids.contains)
                      && ["text", "image", "video", "web"].contains(entry.kind)
                      && (entry.creator?.utf8.count ?? 0) <= 200 && entry.updatedAt.timeIntervalSince1970.isFinite
                      && [entry.seenAt, entry.openedAt, entry.updatedAt].compactMap { $0 }.allSatisfy {
                          $0.timeIntervalSince1970.isFinite && $0 <= now.addingTimeInterval(86400)
                      }
                  }) else { throw FeedError.invalidResponse }
            state = value; prune(now: now)
        } catch { storageFailed = true; readable = false }
    }
    @discardableResult func setInterests(_ values: Set<String>) -> Bool {
        guard values.isSubset(of: InterestCatalog.ids) else { return false }
        var next = state; next.interests = values
        return changePreferences(next)
    }
    @discardableResult func setLearning(_ value: Bool) -> Bool {
        var next = state; next.learningEnabled = value
        return changePreferences(next)
    }
    @discardableResult func setReduceSuggestive(_ value: Bool) -> Bool {
        var next = state; next.reduceSuggestive = value
        return changePreferences(next)
    }
    /// Explicit reset is the only operation allowed to replace an unreadable file.
    @discardableResult func reset() -> Bool {
        pendingSave?.cancel(); pendingSave = nil
        do { try persist(State()); state = State(); readable = true; storageFailed = false; preferenceRevision &+= 1; return true }
        catch { storageFailed = true; return false }
    }
    private func changePreferences(_ next: State) -> Bool {
        guard readable else { storageFailed = true; return false }
        pendingSave?.cancel(); pendingSave = nil
        do { try persist(next); state = next; storageFailed = false; preferenceRevision &+= 1; return true }
        catch { storageFailed = true; return false }
    }
    func record(_ event: Event, card: FeedCard, now: Date = Date()) {
        record(event, id: card.id, topics: InterestCatalog.classify(card), kind: card.kind.rawValue, creator: card.creator?.id, now: now)
    }
    func record(_ event: Event, prompt: Prompt, now: Date = Date()) {
        record(event, id: prompt.id, topics: InterestCatalog.classify(tags: prompt.tags, kind: prompt.kind.rawValue, isSkill: prompt.isSkill),
               kind: prompt.kind.rawValue, creator: prompt.creator?.id, now: now)
    }
    private func record(_ event: Event, id: String, topics: [String], kind: String, creator: String?, now: Date) {
        guard readable, FeedValidation.id(id), state.learningEnabled || event == .dismiss else { return }
        var entry = state.entries[id] ?? Entry(topics: topics, kind: kind, creator: creator, updatedAt: now)
        // A cell appearing repeatedly or a repeatedly tapped detail cannot inflate
        // affinity. One bounded signal per content, with recency decay at ranking.
        if event == .impression, let seen = entry.seenAt, now.timeIntervalSince(seen) < 60 { return }
        entry.topics = topics; entry.kind = kind; entry.creator = creator; entry.updatedAt = now
        switch event {
        case .impression: entry.seenAt = now
        case .open: entry.openedAt = now; entry.seenAt = now
        case .save: entry.saved = true
        case .unsave: entry.saved = false
        case .use: entry.used = true
        case .dismiss: entry.dismissed = true
        }
        state.entries[id] = entry; prune(now: now); scheduleSave()
    }
    func forget(_ ids: Set<String>) {
        guard readable, !ids.isDisjoint(with: state.entries.keys) else { return }
        for id in ids { state.entries.removeValue(forKey: id) }
        scheduleSave()
    }
    func flush() {
        pendingSave?.cancel(); pendingSave = nil
        guard readable else { return }
        do { try persist(state); storageFailed = false } catch { storageFailed = true }
    }
    private func scheduleSave() {
        guard pendingSave == nil else { return }
        pendingSave = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
            self?.flush()
        }
    }
    private func persist(_ value: State) throws {
        guard var file else { return }
        let data = try JSONEncoder().encode(value)
        guard data.count <= 2_000_000 else { throw FeedError.invalidResponse }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let parent = try file.deletingLastPathComponent().resourceValues(forKeys: [.isSymbolicLinkKey])
        guard parent.isSymbolicLink != true else { throw FeedError.invalidResponse }
        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var properties = URLResourceValues(); properties.isExcludedFromBackup = true
        try file.setResourceValues(properties)
    }
    private func prune(now: Date) {
        state.entries = state.entries.filter { now.timeIntervalSince($0.value.updatedAt) < Self.retention }
        if state.entries.count > Self.maximumEntries {
            let keep = state.entries.sorted { $0.value.updatedAt == $1.value.updatedAt ? $0.key < $1.key : $0.value.updatedAt > $1.value.updatedAt }.prefix(Self.maximumEntries)
            state.entries = Dictionary(uniqueKeysWithValues: keep.map { ($0.key, $0.value) })
        }
    }

    /// Rerank a bounded candidate pool once. Existing visible cards never jump
    /// when learning changes. Every fifth slot explores beyond learned affinity.
    func rank(_ cards: [FeedCard], now: Date = Date()) -> [FeedCard] {
        var affinity: [String: Double] = [:]
        if state.learningEnabled {
            for entry in state.entries.values {
                let age = max(0, now.timeIntervalSince(entry.updatedAt)) / 86400
                let weight = (entry.dismissed ? -5.0 : (entry.openedAt == nil ? 0 : 1.0) + (entry.saved ? 4 : 0) + (entry.used ? 2 : 0)) * pow(0.5, age / 21)
                for feature in entry.topics { affinity[feature, default: 0] += weight / Double(max(1, entry.topics.count)) }
            }
        }
        let topics = cards.map(InterestCatalog.classify)
        let scores = cards.enumerated().map { index, card -> Double in
            let chosen = Double(topics[index].filter(state.interests.contains).count) * 3
            let learned = topics[index].reduce(0) { $0 + max(-3, min(3, affinity[$1, default: 0] / 4)) }
            let age = state.entries[card.id]?.seenAt.map { now.timeIntervalSince($0) } ?? .infinity
            let seenPenalty = state.learningEnabled ? (age < 86400 ? 9.0 : age < 7 * 86400 ? 4.0 : 0) : 0
            // Unknown is not a safety approval. Until actual visual assessment
            // exists, softly diversify portrait/fashion-heavy candidate pools.
            let unknownPortrait = reduceSuggestive && (card.presentation == nil || card.presentation == "unknown") && !Set(topics[index]).isDisjoint(with: ["portrait", "fashion"])
            return chosen + learned - (unknownPortrait ? 2 : 0) - seenPenalty - Double(index) / Double(max(1, cards.count))
        }
        let entries = state.entries, learningEnabled = state.learningEnabled
        var remaining = Array(cards.indices), result: [Int] = []
        while !remaining.isEmpty {
            // Retain the server's visual/plain lane schedule. Preference cannot
            // turn the main discovery feed back into several text-only screens.
            let wantVisual = Self.visual(cards[result.count])
            let lane = remaining.filter { Self.visual(cards[$0]) == wantVisual }
            let eligible = lane.isEmpty ? remaining : lane
            let exploring = result.count % 5 == 4 - (result.count / 5) % 5
            let selected = eligible.max { left, right in
                func score(_ index: Int) -> Double {
                    let repeated = cards[index].creator.map { creator in result.suffix(5).filter { cards[$0].creator?.id == creator.id }.count } ?? 0
                    let exposure = entries[cards[index].id]?.seenAt.map { now.timeIntervalSince($0) < 86400 } ?? false
                    let base = exploring ? -Double(index) / Double(max(1, cards.count)) - (learningEnabled && exposure ? 9 : 0) : scores[index]
                    return base - Double(repeated) * 3 - (entries[cards[index].id]?.dismissed == true ? 1000 : 0)
                }
                return score(left) == score(right) ? left > right : score(left) < score(right)
            }!
            result.append(selected); remaining.removeAll { $0 == selected }
        }
        return result.map { cards[$0] }
    }
    static func visual(_ card: FeedCard) -> Bool { card.media?.image != nil || card.media?.imageURL != nil }
}
