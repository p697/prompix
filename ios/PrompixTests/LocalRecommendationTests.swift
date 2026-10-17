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
    func testPreviouslyUnclassifiedTagsParticipateInLocalInterestRanking() {
        XCTAssertEqual(InterestCatalog.classify(tags: ["时装编辑", "合照构图"], kind: "image", isSkill: false), ["portrait", "fashion"])
        XCTAssertEqual(InterestCatalog.classify(tags: ["信息图", "平面设计"], kind: "image", isSkill: false), ["illustration"])
        XCTAssertEqual(InterestCatalog.classify(tags: ["菜谱生成", "食材利用"], kind: "text", isSkill: false), ["lifestyle"])
        XCTAssertEqual(InterestCatalog.classify(tags: ["项目规划", "客户支持"], kind: "text", isSkill: false), ["business"])
        XCTAssertEqual(InterestCatalog.classify(tags: ["ＷｅｂＧＬ", "着色器"], kind: "text", isSkill: false), ["coding"])
        XCTAssertEqual(InterestCatalog.classify(tags: ["创作灵感", "对话助手"], kind: "image", isSkill: false), [])
        XCTAssertEqual(InterestCatalog.classify(tags: ["菜谱生成"], kind: "text", isSkill: true), ["lifestyle", "skills"])
        XCTAssertEqual(InterestCatalog.classify(tags: ["运动"], kind: "image", isSkill: false), ["lifestyle"])
        XCTAssertEqual(InterestCatalog.classify(tags: ["镜头运动", "3D运动"], kind: "image", isSkill: false), [])
        let profile = LocalRecommendations(now: now)
        profile.setInterests(["fashion"])
        let original = card(1)
        let fashion = FeedCard(id: original.id, revision: original.revision, kind: original.kind, contentType: original.contentType,
                              title: original.title, summary: original.summary, tags: ["时装编辑"], model: original.model,
                              artwork: original.artwork, previewLabel: original.previewLabel, creator: original.creator,
                              media: original.media, cover: original.cover, language: original.language, availableLanguages: [])
        XCTAssertEqual(profile.rank([card(0, topic: "illustration"), fashion], now: now).first?.id, fashion.id)
        XCTAssertNil(fashion.presentation, "An interest tag is not a visual safety assessment")
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

    /// Opt-in replay of frozen public candidate pools. It measures ranking behavior,
    /// not human relevance or engagement, and never reads a user's preference file.
    func testPublishedCandidatePoolsMeasureInterestLiftAndExposureSuppression() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let path = environment["PROMPIX_RECOMMENDATION_POOLS"], let output = environment["PROMPIX_RECOMMENDATION_REPORT"] else {
            throw XCTSkip("Requires external public candidate pools; third-party content is never committed.")
        }
        struct Session: Decodable { let name: String; let kind: String?; let items: [FeedCard] }
        struct Capture: Decodable { let complete: Bool; let release: String; let sessions: [Session] }
        let file = URL(fileURLWithPath: path)
        XCTAssertLessThanOrEqual(try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? .max, 8_000_000)
        let capture = try JSONDecoder().decode(Capture.self, from: Data(contentsOf: file))
        XCTAssertTrue(capture.complete); XCTAssertLessThanOrEqual(capture.sessions.count, 32)
        XCTAssertGreaterThanOrEqual(capture.sessions.filter { $0.kind == nil }.count, 10)
        let profiles = InterestCatalog.topics.map { [$0.id] } + [["portrait", "fashion", "illustration"], ["product", "web", "cinema"], ["writing", "learning", "lifestyle"]]
        var rows: [[String: Any]] = [], exposureRows: [[String: Any]] = [], timings: [Double] = []
        var exposureProfiles: [String: LocalRecommendations] = [:]
        var exposures: [String: Set<String>] = [:]
        let training = capture.sessions.flatMap(\.items).reduce(into: [String: FeedCard]()) { $0[$1.id] = $1 }.values.sorted { $0.id < $1.id }
        func match(_ cards: [FeedCard], _ interests: Set<String>) -> Int {
            cards.filter { !Set(InterestCatalog.classify($0)).isDisjoint(with: interests) }.count
        }
        for session in capture.sessions {
            let cards = session.items
            _ = try FeedPage(schemaVersion: 3, release: capture.release, items: cards, nextCursor: nil)
                .validated(locale: "zh-Hans", limit: 90, release: capture.release)
            XCTAssertEqual(Set(cards.map(\.id)).count, cards.count)
            let neutral = LocalRecommendations(now: now)
            let baseline = neutral.rank(cards, now: now).filter(neutral.allowsRecommended)
            for values in profiles {
                let interests = Set(values), profile = LocalRecommendations(now: now)
                XCTAssertTrue(profile.setInterests(interests))
                let start = ContinuousClock.now
                let full = profile.rank(cards, now: now)
                let elapsed = start.duration(to: .now).components
                timings.append(Double(elapsed.seconds) * 1000 + Double(elapsed.attoseconds) / 1e15)
                XCTAssertEqual(full.map(LocalRecommendations.visual), cards.map(LocalRecommendations.visual))
                XCTAssertEqual(Set(full.map(\.id)), Set(cards.map(\.id)))
                XCTAssertEqual(full.map(\.id), profile.rank(cards, now: now).map(\.id))
                let ranked = full.filter(profile.allowsRecommended), top = Array(ranked.prefix(30)), base = Array(baseline.prefix(30))
                XCTAssertFalse(top.contains { $0.presentation == "suggestive" || $0.presentation == "explicit" })
                if session.kind == nil { XCTAssertGreaterThanOrEqual(top.filter(LocalRecommendations.visual).count, 20) }
                let learned = LocalRecommendations(now: now)
                let poolIDs = Set(cards.map(\.id))
                let history = training.filter { !poolIDs.contains($0.id) && !Set(InterestCatalog.classify($0)).isDisjoint(with: interests) }.prefix(12)
                for card in history { learned.record(.open, card: card, now: now.addingTimeInterval(-3600)) }
                let learnedTop = Array(learned.rank(cards, now: now).filter(learned.allowsRecommended).prefix(30))
                XCTAssertTrue(learned.setLearning(false))
                XCTAssertEqual(learned.rank(cards, now: now).filter(learned.allowsRecommended).map(\.id), baseline.map(\.id))
                let visualSlots = top.filter(LocalRecommendations.visual).count
                let matching = ranked.filter { !Set(InterestCatalog.classify($0)).isDisjoint(with: interests) }
                let visualMatches = matching.filter(LocalRecommendations.visual).count
                let attainableMatches = min(visualSlots, visualMatches) + min(top.count - visualSlots, matching.count - visualMatches)
                let authors = Dictionary(grouping: top.compactMap { $0.creator?.id }, by: { $0 })
                rows.append(["session": session.name, "kind": session.kind ?? "all", "interests": values,
                    "pool": cards.count, "availableMatching": match(ranked, interests), "topCount": top.count,
                    "baselineMatching": match(base, interests), "personalizedMatching": match(top, interests),
                    "learnedMatching": match(learnedTop, interests), "trainingItemsOutsidePool": history.count, "attainableMatching": attainableMatches,
                    "visual": top.filter(LocalRecommendations.visual).count, "distinctCreators": authors.count,
                    "maxCreatorItems": authors.values.map(\.count).max() ?? 0,
                    "unknownPresentation": top.filter { $0.presentation == nil || $0.presentation == "unknown" }.count])
            }
            do {
                let kind = session.kind ?? "all"
                let exposureProfile = exposureProfiles[kind] ?? LocalRecommendations(now: now)
                exposureProfiles[kind] = exposureProfile
                var seen = exposures[kind] ?? []
                let ranked = exposureProfile.rank(cards, now: now).filter(exposureProfile.allowsRecommended)
                let top = Array(ranked.prefix(30)), base = Array(baseline.prefix(30))
                let repeated = top.filter { seen.contains($0.id) }.count
                exposureRows.append(["session": session.name, "kind": kind, "topCount": top.count, "availableUnseen": ranked.filter { !seen.contains($0.id) }.count,
                    "baselineRepeated": base.filter { seen.contains($0.id) }.count, "personalizedRepeated": repeated])
                for card in top { exposureProfile.record(.impression, card: card, now: now); seen.insert(card.id) }
                exposureProfile.flush(); exposures[kind] = seen
            }
        }
        timings.sort()
        let report: [String: Any] = ["at": ISO8601DateFormatter().string(from: Date()), "release": capture.release,
            "scope": "Real public candidate pools replayed through the production native ranker with synthetic local profiles. Tag matches are not human relevance or online engagement.",
            "rows": rows, "exposure": exposureRows, "rankingMedianMS": timings[timings.count / 2],
            "rankingP95MS": timings[min(timings.count - 1, Int(ceil(Double(timings.count) * 0.95)) - 1)], "paidXRequests": 0]
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: output), options: .atomic)
        // Judge improvement against what this finite pool can actually supply,
        // retaining the visual lane schedule. Do not demand unseen items from an exhausted category.
        for values in profiles {
            let cohort = rows.filter { ($0["kind"] as? String) == "all" && ($0["interests"] as? [String]) == values }
            func sum(_ key: String) -> Int { cohort.reduce(0) { $0 + ($1[key] as? Int ?? 0) } }
            let baseline = sum("baselineMatching"), opportunity = sum("attainableMatching") - baseline
            if opportunity >= cohort.count {
                XCTAssertGreaterThanOrEqual(Double(sum("personalizedMatching") - baseline), Double(opportunity) * 0.25,
                                            "Explicit interest must realize a meaningful part of available matching candidates: \(values)")
                XCTAssertGreaterThan(sum("learnedMatching"), baseline, "Disjoint click history should improve relevant topic ranking: \(values)")
            }
        }
        let available = exposureRows.filter { ($0["availableUnseen"] as? Int ?? 0) >= ($0["topCount"] as? Int ?? 0) }
        XCTAssertLessThanOrEqual(available.reduce(0) { $0 + ($1["personalizedRepeated"] as? Int ?? 0) },
                                 available.reduce(0) { $0 + ($1["baselineRepeated"] as? Int ?? 0) })
        print("Published recommendation evaluation: \(rows.count) profile/session combinations, \(exposureRows.count) refresh sessions")
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
