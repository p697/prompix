import XCTest
@testable import Prompix

@MainActor final class FeedRevisionTests: XCTestCase {
    func testSkillSourceImageUsesPhotoArtworkAndRetainsAVisibleTitle() throws {
        let cardData = try FeedFixture.page()
        var raw = try XCTUnwrap(JSONSerialization.jsonObject(with: cardData) as? [String: Any])
        var cards = try XCTUnwrap(raw["items"] as? [[String: Any]])
        cards[0]["contentType"] = "skill"
        cards[0]["media"] = ["imageURL": "https://api.prompix.dev/media/" + String(repeating: "a", count: 64) + ".jpg", "aspectRatio": 1.5]
        raw["items"] = cards
        let page = try JSONDecoder().decode(FeedPage.self, from: JSONSerialization.data(withJSONObject: raw))
        let preview = ContentPreview(try XCTUnwrap(page.items.first))
        XCTAssertTrue(preview.isSkill)
        XCTAssertFalse(preview.usesTextArtwork)
        XCTAssertEqual(PromptCardGeometry.aspectRatio(for: preview), 1.5)
        XCTAssertGreaterThan(PromptCardGeometry.height(for: preview, width: 156, titleFont: .preferredFont(forTextStyle: .footnote)), 104)
    }
    func testSynchronousDetailReuseRequiresMatchingRevisionAndDownloadedLocale() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let service = RevisionTestService(), library = Library(directory: directory, feedService: service)
        let repository = try XCTUnwrap(library.feed), card = FeedFixture.card()
        XCTAssertNil(repository.cachedDetail(for: card, locale: "en"))
        _ = try await repository.detail(for: card, locale: "en")
        XCTAssertNotNil(repository.cachedDetail(for: card, locale: "en"))
        XCTAssertNil(repository.cachedDetail(for: card, locale: "ja"), "A different language must still download its body")
        _ = try await repository.detail(for: card, locale: "en")
        let requests = await service.requests
        XCTAssertEqual(requests.count, 1)
        _ = try await repository.loadDetail(id: card.id, revision: String(repeating: "b", count: 64), locale: "en")
        XCTAssertNil(repository.cachedDetail(for: card, locale: "en"), "A new revision cannot replace an old card's body")
    }

    func testLanguageDownloadsStayPinnedAcrossTranslationOnlyReleasesAndPersistFavorites() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let service = RevisionTestService(), library = Library(directory: directory, feedService: service)
        let repository = try XCTUnwrap(library.feed)
        let first = try await repository.loadDetail(id: "test-item", revision: FeedFixture.revision, locale: "en").item
        XCTAssertEqual(first.feedRevision, FeedFixture.revision)
        XCTAssertEqual(library.advertisedLanguages(for: first), ["en", "ja"])
        XCTAssertTrue(library.toggle(first)); XCTAssertTrue(library.saveDraft("Personal English draft", for: first, language: "en"))
        let secondRevision = String(repeating: "b", count: 64)
        let second = try await repository.loadDetail(id: "test-item", revision: secondRevision, locale: "en").item
        XCTAssertEqual(library.resolvedDetail(first, origin: .catalog).content(in: "en").prompt, "Version a en\n")
        XCTAssertEqual(library.resolvedDetail(second, origin: .catalog).content(in: "en").prompt, "Version b en\n")
        let available = await library.ensureLanguage("ja", for: first)
        XCTAssertTrue(available)
        let last = await service.requests.last
        XCTAssertEqual(last?.0, FeedFixture.revision); XCTAssertEqual(last?.1, "ja")
        let saved = try XCTUnwrap(library.favorites.first)
        XCTAssertEqual(saved.content(in: "ja").prompt, "Version a ja\n")
        XCTAssertEqual(saved.content(in: "en").prompt, "Version a en\n")
        XCTAssertEqual(library.draft(for: saved, language: "en"), "Personal English draft")
        XCTAssertEqual(library.resolvedDetail(second, origin: .catalog).content(in: "en").prompt, "Version b en\n")
        let reopened = Library(directory: directory, feedService: service)
        XCTAssertEqual(reopened.favorites.first?.feedRevision, FeedFixture.revision)
        XCTAssertEqual(reopened.favorites.first?.content(in: "ja").prompt, "Version a ja\n")
        XCTAssertEqual(reopened.draft(for: saved, language: "en"), "Personal English draft")
    }
    func testCancelledLanguageCannotChangeFavoriteOrMemoryEvenWhenTransportCompletes() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let service = RevisionTestService(), library = Library(directory: directory, feedService: service)
        let repository = try XCTUnwrap(library.feed)
        let first = try await repository.loadDetail(id: "test-item", revision: FeedFixture.revision, locale: "en").item
        XCTAssertTrue(library.toggle(first))
        let before = try Data(contentsOf: directory.appending(path: "favorites.json"))
        await service.setDelay()
        let task = Task { await library.ensureLanguage("ja", for: first) }
        try await Task.sleep(for: .milliseconds(20)); task.cancel()
        let completed = await task.value
        XCTAssertFalse(completed)
        XCTAssertEqual(try Data(contentsOf: directory.appending(path: "favorites.json")), before)
        XCTAssertFalse(repository.resolved(first).availableLanguages.contains("ja"))
    }
}

private actor RevisionTestService: FeedServing {
    private(set) var requests: [(String, String)] = []
    private var delay = false
    func setDelay() { delay = true }
    func detail(id: String, revision: String?, locale: String) async throws -> FeedDetail {
        let revision = revision ?? FeedFixture.revision
        requests.append((revision, locale))
        if delay { try? await Task.sleep(for: .milliseconds(120)) }
        var item = FeedFixture.prompt()
        item.localization = Prompt.Localization(sourceLanguage: "en", sourceFingerprint: LanguagePackCatalog.sourceFingerprint(item),
            translations: locale == "original" ? [:] : [locale: .init(title: "Title", summary: "Summary", prompt: "Version \(revision.first!) \(locale)\n", example: "Example", previewLabel: "Preview")])
        return FeedDetail(schemaVersion: 3, revision: revision, item: item, availableLanguages: ["en", "ja"])
    }
    func browse(locale: String) async throws -> FeedBrowse { throw FeedError.unavailable(5) }
    func page(query: FeedQuery, cursor: String?, release: String?) async throws -> FeedPage { throw FeedError.unavailable(5) }
    func creators(q: String, cursor: String?, release: String?) async throws -> FeedCreatorsPage { throw FeedError.unavailable(5) }
    func state() async throws -> FeedState { throw FeedError.unavailable(5) }
    func removals(after: String) async throws -> FeedRemovals { throw FeedError.unavailable(5) }
}
