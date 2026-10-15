import XCTest
@testable import Prompix

@MainActor final class CreatorDiscoveryTests: XCTestCase {
    func testHomeCoversAvoidRepeatedItemsAndImagesWithoutChangingCandidates() {
        func preview(_ id: String, _ image: String) -> ContentPreview {
            ContentPreview(FeedCard(id: id, revision: FeedFixture.revision, kind: .image, contentType: "prompt",
                title: id, summary: "Preview", tags: [], model: "Test", artwork: "test", previewLabel: "",
                creator: nil, media: .init(image: image, video: nil, demoURL: nil), cover: nil, language: "original", availableLanguages: []))
        }
        let candidates = [preview("first", "one"), preview("copy", "one"), preview("second", "two"),
                          preview("second", "other"), preview("third", "three")]
        let selected = HomeCoverSelection.select(candidates, avoiding: [candidates[0]])
        XCTAssertEqual(selected.map(\.id), ["second", "third"])
        XCTAssertEqual(candidates.map(\.id), ["first", "copy", "second", "second", "third"])
        XCTAssertTrue(HomeCoverSelection.select(candidates, avoiding: candidates).isEmpty)
        XCTAssertTrue(HomeCoverSelection.select(candidates, avoiding: [], limit: 0).isEmpty)
        XCTAssertEqual(HomeCoverSelection.select(candidates, avoiding: [], limit: 1).map(\.id), ["first"])
    }

    func testCacheSeparatesTypeSortSearchAndDayAndNeverResumesCachedCursor() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = FeedCache(directory: directory), server = CreatorDiscoveryServer()
        let base = CreatorQuery(day: "2026-10-15")
        let first = CreatorDiscoveryStore(service: server, cache: cache)
        await first.load(base)
        XCTAssertEqual(first.items.count, 1)
        await server.fail()
        let reopened = CreatorDiscoveryStore(service: server, cache: cache)
        await reopened.load(base)
        XCTAssertEqual(reopened.items.count, 1)
        XCTAssertTrue(reopened.isCached)
        XCTAssertNil(reopened.nextCursor)
        for query in [CreatorQuery(q: "other", day: base.day), CreatorQuery(kind: "image", day: base.day),
                      CreatorQuery(sort: .name, day: base.day), CreatorQuery(day: "2026-10-16")] {
            let other = CreatorDiscoveryStore(service: server, cache: cache)
            await other.load(query)
            XCTAssertTrue(other.items.isEmpty)
            XCTAssertNotNil(other.failure)
        }
    }

    func testChangingTypeCancelsOldRequestAndPagingRetainsCompleteQuery() async throws {
        let server = CreatorDiscoveryServer(), store = CreatorDiscoveryStore(service: server)
        let old = Task { await store.load(CreatorQuery(q: "slow", kind: "image")) }
        try await Task.sleep(for: .milliseconds(20))
        let next = CreatorQuery(kind: "video", sort: .latest)
        await store.load(next)
        await old.value
        XCTAssertEqual(store.query, next)
        XCTAssertEqual(store.items.first?.id, "author-video")
        await store.loadMore()
        XCTAssertEqual(store.items.map(\.id), ["author-video", "author-next"])
        let call = await server.calls.last!
        XCTAssertEqual(call.0, next); XCTAssertEqual(call.1, "next"); XCTAssertEqual(call.2, FeedFixture.release)
    }

    func testKnownRemovalHidesCreatorPreviewEvenBeforeRefreshFinishes() throws {
        let card = FeedFixture.card()
        let creator = Prompt.Creator(id: "author", platform: "web", displayName: "Author", profileURL: URL(string: "https://example.com/author")!)
        let entry = FeedCreatorsPage.Entry(creator: creator, count: 1, preview: card)
        let repository = FeedRepository(service: CreatorDiscoveryServer(), cache: FeedCache(directory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)),
            checkpoint: FeedCheckpoint(after: "1", removedIDs: [card.id]), commitRemovals: { _ in })
        XCTAssertNil(repository.creatorPreview(entry))
    }

    func testPreviewRejectsWrongCreatorAndWrongFilterAndAcceptsLegacyPages() throws {
        let creator = Prompt.Creator(id: "creator-test", platform: "web", displayName: "Test", profileURL: URL(string: "https://example.com/test")!)
        let legacy = FeedCreatorsPage(schemaVersion: 3, release: FeedFixture.release, items: [.init(creator: creator, count: 1)], nextCursor: nil)
        _ = try legacy.validated(limit: 30)
        let wrong = FeedCreatorsPage(schemaVersion: 3, release: FeedFixture.release,
            items: [.init(creator: creator, count: 1, preview: FeedFixture.card())], nextCursor: nil)
        XCTAssertThrowsError(try wrong.validated(limit: 30))
        let card = FeedCard(id: "card", revision: FeedFixture.revision, kind: .image, contentType: "prompt", title: "Test", summary: "Test",
            tags: [], model: "Test", artwork: "test", previewLabel: "Test", creator: creator, media: nil, cover: nil, language: "original", availableLanguages: [])
        let page = FeedCreatorsPage(schemaVersion: 3, release: FeedFixture.release, items: [.init(creator: creator, count: 1, preview: card)], nextCursor: nil)
        try CreatorDiscoverySource.validate(page, query: CreatorQuery(kind: "image"), release: nil)
        XCTAssertThrowsError(try CreatorDiscoverySource.validate(page, query: CreatorQuery(kind: "video"), release: nil))
        XCTAssertThrowsError(try CreatorQuery(kind: "untrusted").validated())
    }
}

private actor CreatorDiscoveryServer: FeedServing {
    var calls: [(CreatorQuery, String?, String?)] = []
    var failure = false
    func fail() { failure = true }
    func creatorDiscovery(query: CreatorQuery, cursor: String?, release: String?) async throws -> FeedCreatorsPage {
        calls.append((query, cursor, release))
        if failure { throw URLError(.notConnectedToInternet) }
        if query.q == "slow" { try? await Task.sleep(for: .milliseconds(150)) }
        let id = cursor == nil ? "author-" + (query.kind ?? "all") : "author-next"
        let creator = Prompt.Creator(id: id, platform: "web", displayName: id, profileURL: URL(string: "https://example.com/test")!)
        return .init(schemaVersion: 3, release: FeedFixture.release, items: [.init(creator: creator, count: 2)], nextCursor: cursor == nil ? "next" : nil)
    }
    func creators(q: String, cursor: String?, release: String?) async throws -> FeedCreatorsPage { throw FeedError.invalidQuery }
    func page(query: FeedQuery, cursor: String?, release: String?) async throws -> FeedPage { throw FeedError.invalidQuery }
    func detail(id: String, revision: String?, locale: String) async throws -> FeedDetail { throw FeedError.invalidQuery }
    func browse(locale: String) async throws -> FeedBrowse { throw FeedError.invalidQuery }
    func state() async throws -> FeedState { throw FeedError.invalidQuery }
    func removals(after: String) async throws -> FeedRemovals { throw FeedError.invalidQuery }
}
