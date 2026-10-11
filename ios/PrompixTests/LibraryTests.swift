import XCTest
@testable import Prompix

@MainActor final class LibraryTests: XCTestCase {
    private var directory: URL!
    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: directory) }

    func testFavoritesSurviveRelaunchAndStorePromptSnapshot() throws {
        let first = Library(directory: directory)
        let item = try XCTUnwrap(first.prompts.first)
        XCTAssertTrue(first.toggle(item))
        let reopened = Library(directory: directory)
        XCTAssertEqual(reopened.favorites.first, item)
        XCTAssertTrue(reopened.toggle(item))
        XCTAssertTrue(Library(directory: directory).favorites.isEmpty)
    }

    func testInvalidCatalogDoesNotDestroyOfflineFavorites() throws {
        let first = Library(directory: directory)
        let item = try XCTUnwrap(first.prompts.first)
        XCTAssertTrue(first.toggle(item))
        let invalid = directory.appending(path: "invalid.json")
        try Data("{}".utf8).write(to: invalid)
        let failed = Library(directory: directory, catalogURL: invalid)
        XCTAssertNotNil(failed.error)
        XCTAssertEqual(failed.favorites.first?.prompt, item.prompt)
    }

    func testFourKindsAndSearchIntersection() throws {
        let library = Library(directory: directory)
        XCTAssertEqual(Set(library.prompts.map(\.kind)), Set(PromptKind.allCases))
        for kind in PromptKind.allCases { XCTAssertGreaterThanOrEqual(library.prompts.filter { $0.kind == kind }.count, 6) }
        let query = PromptQuery(text: "塔罗", kind: .text)
        XCTAssertEqual(library.prompts.filter(query.matches).map(\.id), ["gentle-tarot"])
        XCTAssertTrue(library.prompts.filter(PromptQuery(text: "塔罗", kind: .web).matches).isEmpty)
        XCTAssertTrue(library.prompts.filter(PromptQuery(text: "  ").matches).count == library.prompts.count)
    }

    func testUnknownSchemaAndDuplicateIDsAreRejected() throws {
        let item = try XCTUnwrap(Library(directory: directory).prompts.first)
        XCTAssertThrowsError(try Catalog(schemaVersion: 2, version: "test", prompts: [item]).validated())
        XCTAssertThrowsError(try Catalog(schemaVersion: 1, version: "test", prompts: [item,item]).validated())
    }

    func testCorruptFavoritesAreNotSilentlyOverwrittenAtLaunch() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appending(path: "favorites.json")
        let bytes = Data("broken".utf8)
        try bytes.write(to: url)
        let library = Library(directory: directory)
        XCTAssertNotNil(library.error)
        XCTAssertEqual(try Data(contentsOf: url), bytes)
    }

    func testBundledMediaExist() throws {
        let library = Library(directory: directory)
        for item in library.prompts {
            if let movie = item.media?.video { XCTAssertNotNil(Bundle.main.url(forResource: movie, withExtension: "mp4"), movie) }
            if let image = item.media?.image { XCTAssertNotNil(UIImage(named: image), image) }
        }
    }
}
