import XCTest
@testable import Prompix

final class PromptSearchTests: XCTestCase {
    func testPublishedCatalogSearchTiming() throws {
        guard let path = ProcessInfo.processInfo.environment["PROMPIX_SEARCH_BENCHMARK_CATALOG"] else {
            throw XCTSkip("Requires an external published-catalog fixture; content is never committed.")
        }
        let catalog = try JSONDecoder().decode(Catalog.self, from: Data(contentsOf: URL(fileURLWithPath: path))).validated()
        for term in ["portrait", "studio portrait", "unmatched-search-term"] {
            let start = ContinuousClock.now
            _ = PromptQuery(text: term).results(in: catalog.prompts)
            print("Search benchmark: \(catalog.prompts.count) items, \(term), \(start.duration(to: .now))")
        }
        let start = ContinuousClock.now
        _ = CreatorDirectory.browse(in: catalog.prompts, query: CreatorQuery())
        print("Creator browse benchmark: \(catalog.prompts.count) items, \(start.duration(to: .now))")
    }

    func testCancelledSearchStopsBeforeScanningTheRemainingCatalog() {
        let items = (0..<1000).map { prompt(id: "item-\($0)") }
        var visited = 0
        let results = PromptQuery(text: "useful").results(in: items) {
            visited += 1
            return visited == 2
        }
        XCTAssertTrue(results.isEmpty, "Cancelled work must not publish partial results")
        XCTAssertEqual(visited, 2)
    }

    func testMultipleWordsMustAllMatchEvenWhenSpreadAcrossFields() {
        let author = creator(name: "Maya Chen", username: "maya")
        let relevant = prompt(id: "relevant", title: "Studio portrait", body: "Shape soft light.", creator: author)
        let incomplete = prompt(id: "incomplete", title: "Studio portrait", body: "Shape hard shadows.", creator: author)
        XCTAssertEqual(PromptQuery(text: "  MAYA  portrait\nsoft ").results(in: [incomplete, relevant]).map(\.id), ["relevant"])
        XCTAssertTrue(PromptQuery(text: "portrait camera").results(in: [relevant]).isEmpty)
    }

    func testCaseDiacriticsAndWidthDoNotHideRelevantResults() {
        let item = prompt(id: "cafe", title: "Café design", body: "Design a café interior.")
        XCTAssertEqual(PromptQuery(text: "ＣＡＦＥ design").results(in: [item]).map(\.id), ["cafe"])
        XCTAssertTrue(PromptQuery(text: "cafe").matches(item))
    }

    func testSearchIncludesOriginalExampleAndAllAvailableTranslatedFields() {
        var item = prompt(id: "translated", title: "Original title", example: "An original moonstone example.")
        item.localization = .init(sourceLanguage: "en", sourceFingerprint: String(repeating: "a", count: 64), translations: [
            "ja": .init(title: "星空の物語", summary: "静かな夜", prompt: "流れ星を探す", example: "青い森", previewLabel: "夜の散歩"),
            "fr": .init(title: "Café créatif", summary: "Une idée simple", prompt: "Créer une histoire", example: "Une forêt", previewLabel: "Illustration")
        ])
        for query in ["original moonstone", "星空 流れ星", "青い森", "夜の散歩", "cafe histoire", "foret"] {
            XCTAssertTrue(PromptQuery(text: query).matches(item), "Missing searchable field: \(query)")
        }
        XCTAssertFalse(PromptQuery(text: "neverdownloadedtranslation").matches(item))
    }

    func testTitleRelevanceIncludesAvailableTranslationsAndKeepsEditorialTies() {
        var translated = prompt(id: "title", title: "Travel ideas")
        translated.localization = .init(sourceLanguage: "en", sourceFingerprint: String(repeating: "a", count: 64), translations: [
            "ja": .init(title: "京都", summary: "旅", prompt: "京都を歩く", example: "朝", previewLabel: "旅行")
        ])
        let body = prompt(id: "body", body: "京都 is one possible destination.")
        let tiedBody = prompt(id: "body2", body: "An itinerary near 京都.")
        XCTAssertEqual(PromptQuery(text: "京都").results(in: [body, tiedBody, translated]).map(\.id), ["title", "body", "body2"])
    }

    func testStableKindAndSkillTermsWorkAlongsideNativeFilters() {
        let image = prompt(id: "image", title: "Lighting study", kind: .image)
        let text = prompt(id: "text", title: "A lighting note", kind: .text)
        var skill = prompt(id: "skill", title: "Workspace helper")
        skill.contentType = "skill"
        skill.skill = .init(name: "knowledge-capture", description: "Collect research notes", format: "agent-skills", entrypoint: "SKILL.md",
                            repository: URL(string: "https://example.com/repo")!, directory: "knowledge", installURL: URL(string: "https://example.com/install")!)
        XCTAssertEqual(PromptQuery(text: "image").results(in: [text, image, skill]).map(\.id), ["image"])
        XCTAssertEqual(PromptQuery(text: "SKILLS research").results(in: [image, skill, text]).map(\.id), ["skill"])
        XCTAssertEqual(PromptQuery(text: "knowledge-capture", skillsOnly: true).results(in: [image, skill, text]).map(\.id), ["skill"])
        XCTAssertTrue(PromptQuery(text: "research", kind: .text).results(in: [skill]).isEmpty)
    }

    func testCreatorHandlePlatformAndNameRemainSearchable() {
        let author = creator(name: "José Silva", username: "studio_js")
        let item = prompt(id: "attributed", creator: author)
        XCTAssertTrue(PromptQuery(text: "@STUDIO_JS jose GitHub").matches(item))
        XCTAssertTrue(author.matchesSearch("jose @studio_js"))
        XCTAssertFalse(author.matchesSearch("jose @unrelated"))
    }

    private func creator(name: String, username: String) -> Prompt.Creator {
        .init(id: "github-\(username)", platform: "github", displayName: name, username: username,
              profileURL: URL(string: "https://github.com/\(username)")!)
    }

    private func prompt(id: String, title: String = "Example", kind: PromptKind = .text,
                        body: String = "Create a useful result.", example: String = "A result", creator: Prompt.Creator? = nil) -> Prompt {
        .init(id: id, kind: kind, title: title, summary: "Test summary", prompt: body, example: example, tags: [], model: "Test model",
              toolURL: nil, artwork: "paper", previewLabel: "Preview", source: .init(name: "Test source", url: nil, license: "Original", method: "test"),
              media: nil, creator: creator)
    }
}
