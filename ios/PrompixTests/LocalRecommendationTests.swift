import XCTest
@testable import Prompix

@MainActor final class LocalRecommendationTests: XCTestCase {
    private var directory: URL!
    private let now = Date(timeIntervalSince1970: 1_790_000_000)
    override func setUp() async throws { directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString) }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: directory) }
    private func card(_ n: Int, topic: String = "portrait", visual: Bool = true, creator: String? = nil) -> FeedCard {
        FeedCard(id: "recommendation-\(n)", revision: FeedFixture.revision, kind: visual ? .image : .text, contentType: "prompt",
                 title: "Original test card", summary: "First-party test fixture", tags: [], model: "Fixture", artwork: "test", previewLabel: "Preview",
                 creator: creator.map { .init(id: $0, platform: "web", displayName: "Fixture", profileURL: URL(string: "https://example.com")!) },
                 media: visual ? .init(image: "lake", video: nil, demoURL: nil) : nil, cover: nil, language: "original", availableLanguages: [], topics: [topic])
    }
    func testTopicsUseOneStableCatalogAndDoNotInferAppearanceFromAnInterest() {
        XCTAssertEqual(InterestCatalog.ids.count, 12)
        XCTAssertEqual(InterestCatalog.classify(tags: ["人物肖像", "时尚摄影"], kind: "image", isSkill: false), ["portrait", "fashion"])
        XCTAssertTrue(InterestCatalog.classify(tags: ["VIDEO"], kind: "video", isSkill: false).contains("cinema"))
        XCTAssertTrue(InterestCatalog.classify(tags: ["Illustration"], kind: "text", isSkill: true).contains("skills"))
        XCTAssertEqual(InterestCatalog.classify(tags: [], kind: "image", isSkill: false), [])
    }
    func testExplicitInterestsAndLearnedSignalsImproveRankingWithoutDestroyingVisualMix() {
        let profile = LocalRecommendations(now: now)
        let cards = (0..<90).map { card($0, topic: $0 % 3 == 0 ? "product" : "portrait", visual: $0 % 5 != 4) }
        XCTAssertTrue(profile.setInterests(["product"]))
        for n in 100..<120 { profile.record(.save, card: card(n, topic: "product"), now: now) }
        let ranked = profile.rank(cards, now: now)
        XCTAssertEqual(Set(ranked.map(\.id)), Set(cards.map(\.id)))
        XCTAssertEqual(ranked.count, cards.count)
        XCTAssertGreaterThanOrEqual(ranked.prefix(20).filter { $0.topics == ["product"] }.count, 14)
        XCTAssertEqual(ranked.map(LocalRecommendations.visual), cards.map(LocalRecommendations.visual))
    }
    func testViewedContentIsDeprioritizedAndRepeatedCellEventsDoNotAmplifyAffinity() {
        let profile = LocalRecommendations(now: now), cards = (0..<30).map { card($0) }
        for item in cards.prefix(10) {
            for _ in 0..<10 { profile.record(.impression, card: item, now: now); profile.record(.open, card: item, now: now) }
        }
        XCTAssertEqual(profile.state.entries.count, 10)
        XCTAssertTrue(profile.rank(cards, now: now).prefix(10).allSatisfy { !Set(cards.prefix(10).map(\.id)).contains($0.id) })
        XCTAssertEqual(profile.rank(cards, now: now).map(\.id), profile.rank(cards, now: now).map(\.id))
    }
    func testLearningCanBeDisabledWithoutDiscardingExplicitInterests() {
        let profile = LocalRecommendations(now: now)
        profile.setInterests(["product"]); profile.setLearning(false)
        profile.record(.open, card: card(0), now: now)
        XCTAssertTrue(profile.state.entries.isEmpty)
        let result = profile.rank([card(0), card(1, topic: "product")], now: now)
        XCTAssertEqual(result.first?.id, "recommendation-1")
        profile.record(.dismiss, card: card(2), now: now)
        XCTAssertEqual(profile.hiddenIDs, ["recommendation-2"])
    }
    func testCreatorDiversityAndExplorationPreventOnePublisherFromTakingEveryTopSlot() {
        let profile = LocalRecommendations(now: now)
        profile.setInterests(["portrait"])
        let cards = (0..<10).map { card($0, creator: "same") } + (10..<30).map { card($0, creator: "creator-\($0)") }
        let ranked = profile.rank(cards, now: now)
        XCTAssertLessThanOrEqual(ranked.prefix(5).filter { $0.creator?.id == "same" }.count, 2)
        XCTAssertEqual(ranked.count, 30)
    }
    func testPreferencesPersistWithoutPromptTextAndResetKeepsFavorites() throws {
        let profile = LocalRecommendations(directory: directory, now: now)
        profile.setInterests(["portrait", "cinema", "web"])
        profile.record(.save, card: card(0), now: now); profile.flush()
        let file = directory.appending(path: "recommendation-preferences.json")
        let bytes = try Data(contentsOf: file)
        XCTAssertFalse(String(decoding: bytes, as: UTF8.self).contains("Original test card"))
        let reopened = LocalRecommendations(directory: directory, now: now)
        XCTAssertEqual(reopened.interests, profile.interests); XCTAssertEqual(reopened.state.entries.count, 1)
        let personal = directory.appending(path: "favorites.json"), saved = Data("untouched".utf8)
        try saved.write(to: personal)
        XCTAssertTrue(reopened.reset()); XCTAssertTrue(reopened.state.entries.isEmpty)
        XCTAssertEqual(try Data(contentsOf: personal), saved)
    }
    func testCorruptPreferenceFileIsPreservedUntilExplicitReset() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appending(path: "recommendation-preferences.json"), bytes = Data("invalid existing data".utf8)
        try bytes.write(to: file)
        let profile = LocalRecommendations(directory: directory, now: now)
        XCTAssertTrue(profile.storageFailed); XCTAssertFalse(profile.setInterests(["portrait"]))
        profile.record(.open, card: card(1), now: now); profile.flush()
        XCTAssertEqual(try Data(contentsOf: file), bytes)
        XCTAssertTrue(profile.reset()); XCTAssertFalse(profile.storageFailed)
    }
    func testStateIsBoundedAndOldLearningExpires() {
        let profile = LocalRecommendations(now: now)
        for n in 0..<3010 { profile.record(.open, card: card(n), now: now.addingTimeInterval(Double(n))) }
        XCTAssertEqual(profile.state.entries.count, LocalRecommendations.maximumEntries)
        XCTAssertNil(profile.state.entries["recommendation-0"])
        profile.record(.open, card: card(4000), now: now.addingTimeInterval(100 * 86400))
        XCTAssertEqual(profile.state.entries.count, 1)
        profile.forget(["recommendation-4000"]); XCTAssertTrue(profile.state.entries.isEmpty)
    }
    func testInterestChoiceDoesNotOptIntoRevealingImages() {
        let profile = LocalRecommendations(now: now)
        profile.setInterests(["portrait", "fashion", "illustration"])
        var portrait = card(0); portrait.presentation = "general"
        var revealing = card(1); revealing.presentation = "suggestive"
        XCTAssertTrue(profile.reduceSuggestive)
        XCTAssertTrue(profile.allowsRecommended(portrait)); XCTAssertFalse(profile.allowsRecommended(revealing))
        XCTAssertTrue(profile.setReduceSuggestive(false)); XCTAssertTrue(profile.allowsRecommended(revealing))
        XCTAssertEqual(profile.interests, ["portrait", "fashion", "illustration"])
        profile.record(.dismiss, card: revealing, now: now)
        XCTAssertFalse(profile.allowsRecommended(revealing), "Explicit negative feedback still applies")
    }

    func testSessionRotationBoundedPoolsWarmRestorationAndOfflineCache() async throws {
        let server = RecommendationServer(), cache = FeedCache(directory: directory)
        let profile = LocalRecommendations(now: now)
        let store = FeedStore(service: server, cache: cache, memoryPageLimit: 6, recommendations: profile)
        let query = FeedQuery(locale: "original", sort: "recommended"), other = FeedQuery(locale: "original", kind: "image", sort: "recommended")
        await store.load(query, now: now)
        XCTAssertEqual(store.items.count, 90); XCTAssertNil(store.failure)
        let initial = await server.calls
        XCTAssertEqual(initial.count, 3); XCTAssertEqual(Set(initial.compactMap { $0.seed }).count, 1)
        XCTAssertNotNil(initial.first?.seed); XCTAssertNil(store.query?.seed)
        await store.loadMore(now: now); XCTAssertEqual(store.items.count, 180)
        let paged = await server.calls
        XCTAssertEqual(Set(paged.compactMap { $0.seed }).count, 1)
        await store.load(other, now: now)
        store.select(query, now: now); XCTAssertEqual(store.items.count, 90)
        await store.loadMore(now: now)
        let restored = await server.calls; XCTAssertEqual(restored.last?.seed, initial.first?.seed)
        await store.load(query, force: true, now: now)
        let refreshed = await server.calls; XCTAssertNotEqual(refreshed.last?.seed, initial.first?.seed)
        await server.fail()
        let offline = FeedStore(service: server, cache: cache, recommendations: profile)
        await offline.load(query, now: now)
        XCTAssertEqual(offline.items.count, 90); XCTAssertTrue(offline.isCached); XCTAssertNil(offline.nextCursor)
        XCTAssertTrue(query.parameters.allSatisfy { !["interests", "seen", "creatorPreferences", "events"].contains($0.name) })
    }
}

private actor RecommendationServer: FeedServing {
    private(set) var calls: [FeedQuery] = []
    private var failed = false
    func fail() { failed = true }
    func page(query: FeedQuery, cursor: String?, release: String?) async throws -> FeedPage {
        calls.append(query); if failed { throw URLError(.notConnectedToInternet) }
        let start = Int(cursor ?? "0") ?? 0
        return FeedPage(schemaVersion: 3, release: FeedFixture.release,
                        items: (start..<min(300, start + 30)).map { FeedFixture.card(id: "page-\($0)") },
                        nextCursor: start + 30 < 300 ? String(start + 30) : nil)
    }
    func detail(id: String, revision: String?, locale: String) async throws -> FeedDetail { throw FeedError.notFound }
    func creators(q: String, cursor: String?, release: String?) async throws -> FeedCreatorsPage { throw FeedError.notFound }
    func browse(locale: String) async throws -> FeedBrowse { throw FeedError.notFound }
    func state() async throws -> FeedState { throw FeedError.notFound }
    func removals(after: String) async throws -> FeedRemovals { throw FeedError.notFound }
}
