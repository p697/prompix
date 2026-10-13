import XCTest
import CryptoKit
@testable import Prompix

@MainActor final class GlobalDiscoveryTests: XCTestCase {
    private var directory: URL!
    private var catalogURL: URL { directory.appending(path: "fixture-catalog.json") }
    private var storeDirectory: URL { directory.appending(path: "store", directoryHint: .isDirectory) }

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testPromptGridFitsNarrowPanesAndAsymmetricDivision() {
        for width: CGFloat in [240, 390, 680, 900] {
            let layout = PromptGridLayout(width: width)
            XCTAssertEqual(layout.columns, width >= 760 ? 4 : 2)
            XCTAssertEqual(layout.widths.reduce(0, +) + layout.gaps.reduce(0, +), width, accuracy: 0.01)
            XCTAssertTrue(layout.widths.allSatisfy { $0 > 0 })
        }
        let division = CGRect(x: 430, y: 0, width: 56, height: 600)
        let divided = PromptGridLayout(width: 850, division: division)
        XCTAssertEqual(divided.widths[0] + divided.gaps[0] + divided.widths[1], division.minX - 8, accuracy: 0.01)
        XCTAssertEqual(divided.gaps[1], division.width + 16)
        XCTAssertEqual(divided.widths.reduce(0, +) + divided.gaps.reduce(0, +), 850, accuracy: 0.01)
        XCTAssertGreaterThan(divided.widths[0], divided.widths[3])
        let edgeDivision = PromptGridLayout(width: 900, division: CGRect(x: 30, y: 0, width: 40, height: 600))
        XCTAssertTrue(edgeDivision.widths.allSatisfy { $0 >= 140 }, "An edge sliver must not become a column.")
        let narrowHalf = PromptGridLayout(width: 800, division: CGRect(x: 210, y: 0, width: 50, height: 600))
        XCTAssertEqual(narrowHalf.columns, 2)
        XCTAssertTrue(narrowHalf.widths.allSatisfy { $0 >= 140 })
    }

    func testCreatorSearchAcceptsDisplayedHandlesAndMultipleIdentityTerms() {
        let author = creator(id: "github-sample", name: "Sample Artist", username: "sample_artist", platform: "github")
        XCTAssertTrue(author.matchesSearch("@SAMPLE_artist"))
        XCTAssertTrue(author.matchesSearch("Artist GitHub"))
        XCTAssertFalse(author.matchesSearch("@different"))
        XCTAssertTrue(PromptQuery(text: "@sample_artist").matches(prompt(id: "attributed", creator: author)))
    }

    func testSearchFindsWordsOnlyInTheDisplayedTranslatedInstructions() {
        var item = prompt(id: "translated-search")
        item.localization = Prompt.Localization(sourceLanguage: "zh", sourceFingerprint: String(repeating: "a", count: 64), translations: [
            ContentLanguage.preferred: .init(title: item.title, summary: item.summary,
                prompt: "Use the keyword aurorabloom in this instruction.", example: "Demonstrate with a moonstone example.", previewLabel: item.previewLabel)
        ])
        XCTAssertTrue(PromptQuery(text: "aurorabloom").matches(item))
        XCTAssertTrue(PromptQuery(text: "moonstone").matches(item))
        XCTAssertFalse(PromptQuery(text: "unrelatedkeyword").matches(item))
    }

    func testSearchPrioritizesTitleAndCreatorOverIncidentalBodyMentions() {
        let body = prompt(id: "incidental", body: "Deploy with Supabase as an optional service.")
        let author = prompt(id: "author", creator: creator(id: "supabase", name: "Supabase", username: "supabase"))
        let title = prompt(id: "title", title: "Supabase development guide")
        let exact = prompt(id: "exact", title: "SUPABASE")
        XCTAssertEqual(PromptQuery(text: " Supabase ").results(in: [body, author, title, exact]).map(\.id), ["exact", "title", "author", "incidental"])
    }

    func testSearchRanksDisplayedTranslatedTitleAndRetainsBodyOnlyMatches() {
        var translated = prompt(id: "translated")
        translated.localization = Prompt.Localization(sourceLanguage: "zh-Hans", sourceFingerprint: String(repeating: "a", count: 64), translations: [
            ContentLanguage.preferred: .init(title: "Aurorabloom", summary: translated.summary,
                prompt: translated.prompt, example: translated.example, previewLabel: translated.previewLabel)
        ])
        let body = prompt(id: "body", body: "Describe aurorabloom in a poem.")
        XCTAssertEqual(PromptQuery(text: "aurorabloom").results(in: [body, translated]).map(\.id), ["translated", "body"])
    }

    func testSearchRetainsEditorialTiesAndFacetFiltering() {
        let first = prompt(id: "first", title: "Planning ideas")
        let image = prompt(id: "image", title: "Planning images", kind: .image)
        let second = prompt(id: "second", title: "Planning notes")
        XCTAssertEqual(PromptQuery(text: "planning", kind: .text).results(in: [first, image, second]).map(\.id), ["first", "second"])
        XCTAssertEqual(PromptQuery(text: "  ").results(in: [image, second, first]).map(\.id), ["image", "second", "first"])
    }

    func testRankedSearchStillRequiresEveryTermAcrossFields() {
        let relevant = prompt(id: "relevant", title: "Supabase", body: "Deploy a project.")
        let unrelated = prompt(id: "unrelated", title: "Supabase", body: "Draw a scene.")
        XCTAssertEqual(PromptQuery(text: "supabase deploy").results(in: [unrelated, relevant]).map(\.id), ["relevant"])
    }

    func testCreatorDirectoryKeepsSameNamedAccountsSeparateAndCountsExactIdentities() {
        let first = creator(id: "x:101", name: "Sam", username: "sam-art")
        let second = creator(id: "github:202", name: "Sam", username: "sam-code", platform: "github")
        let items = [
            prompt(id: "one", creator: first),
            prompt(id: "two", creator: second),
            prompt(id: "three", creator: first),
            prompt(id: "unattributed")
        ]

        let entries = CreatorDirectory.entries(in: items)

        XCTAssertEqual(entries.map(\.id), [first.id, second.id])
        XCTAssertEqual(entries.map(\.count), [2, 1])
        XCTAssertEqual(entries.map(\.creator.profileURL), [first.profileURL, second.profileURL])
    }

    func testCreatorDirectorySortOrderDoesNotDependOnCatalogOrder() {
        let frequent = creator(id: "x:9", name: "Zoe")
        let alphaFirst = creator(id: "x:1", name: "Alpha")
        let alphaSecond = creator(id: "x:2", name: "Alpha")
        let beta = creator(id: "x:3", name: "Beta")
        let items = [
            prompt(id: "b", creator: beta),
            prompt(id: "a2", creator: alphaSecond),
            prompt(id: "z1", creator: frequent),
            prompt(id: "a1", creator: alphaFirst),
            prompt(id: "z2", creator: frequent)
        ]
        let expected = [frequent.id, alphaFirst.id, alphaSecond.id, beta.id]

        XCTAssertEqual(CreatorDirectory.entries(in: items).map(\.id), expected)
        XCTAssertEqual(CreatorDirectory.entries(in: Array(items.reversed())).map(\.id), expected)
    }

    func testCreatorDirectoryRetainsEnrichedAvatarAndProfileRegardlessOfPublicationOrder() throws {
        let basic = creator(id: "x:101", name: "Taylor")
        var enriched = basic
        enriched.avatarURL = URL(string: "https://api.prompix.dev/media/taylor-avatar.jpg")!
        enriched.username = "taylor-design"
        enriched.bio = "A test creator who works with typography."
        let items = [prompt(id: "old", creator: basic), prompt(id: "new", creator: enriched)]

        let forward = try XCTUnwrap(CreatorDirectory.entries(in: items).first)
        let reverse = try XCTUnwrap(CreatorDirectory.entries(in: Array(items.reversed())).first)

        XCTAssertEqual(forward.creator, enriched)
        XCTAssertEqual(reverse.creator, enriched)
        XCTAssertEqual(forward.count, 2)
        XCTAssertEqual(reverse.count, 2)
    }

    func testCreatorDirectoryUnifiesLegacyAndVerifiedWorksWithStableProfileSelection() throws {
        var legacy = creator(id: "x-taylor", name: "Old profile", username: "Taylor")
        legacy.avatarURL = URL(string: "https://api.prompix.dev/media/old-photo.jpg")!
        legacy.bio = "An old biography must not outweigh verified identity."
        var verified = creator(id: "x-id-123", name: "Current profile", username: "taylor")
        verified.externalID = "123"
        let items = [prompt(id: "old-work", creator: legacy), prompt(id: "new-work", creator: verified)]
        let library = try makeLibrary(items: items)

        for order in [items, Array(items.reversed())] {
            let entries = CreatorDirectory.entries(in: order)
            XCTAssertEqual(entries.map(\.creator), [verified])
            XCTAssertEqual(entries.map(\.count), [2])
            XCTAssertEqual(library.items(for: entries[0].creator).count, entries[0].count)
        }
        XCTAssertEqual(library.items(for: legacy).count, 2)
    }

    func testCreatorDirectoryNeverMergesConflictingVerifiedAccountsThroughAHandle() throws {
        var first = creator(id: "x-id-123", name: "Earlier owner", username: "shared")
        first.externalID = "123"
        var second = creator(id: "x-id-456", name: "Later owner", username: "shared")
        second.externalID = "456"
        let items = [prompt(id: "first-work", creator: first), prompt(id: "second-work", creator: second)]
        let library = try makeLibrary(items: items)

        let entries = CreatorDirectory.entries(in: items)
        XCTAssertEqual(Set(entries.map(\.id)), Set([first.id, second.id]))
        XCTAssertEqual(entries.map(\.count), [1, 1])
        for entry in entries { XCTAssertEqual(library.items(for: entry.creator).count, entry.count) }
    }

    func testAmbiguousLegacyHandleRemainsIndependentInDirectoryProfilesAndBookmarks() throws {
        let legacy = creator(id: "x-shared", name: "Unresolved source profile", username: "shared")
        var first = creator(id: "x-id-123", name: "Earlier owner", username: "shared")
        first.externalID = "123"
        var second = creator(id: "x-id-456", name: "Later owner", username: "shared")
        second.externalID = "456"
        let items = [prompt(id: "legacy-work", creator: legacy), prompt(id: "first-work", creator: first), prompt(id: "second-work", creator: second)]
        let library = try makeLibrary(items: items)

        for order in [items, Array(items.reversed())] {
            let entries = CreatorDirectory.entries(in: order)
            XCTAssertEqual(Set(entries.map(\.id)), Set([legacy.id, first.id, second.id]))
            XCTAssertEqual(entries.map(\.count), [1, 1, 1])
            XCTAssertEqual(entries.reduce(0) { $0 + $1.count }, items.count)
            for entry in entries { XCTAssertEqual(library.items(for: entry.creator).count, entry.count) }
        }
        XCTAssertEqual(library.currentCreator(legacy), legacy)
        XCTAssertEqual(library.items(for: legacy).map(\.id), ["legacy-work"])
        XCTAssertTrue(library.toggleCreator(legacy))
        XCTAssertTrue(library.isCreatorSaved(legacy))
        XCTAssertFalse(library.isCreatorSaved(first))
        XCTAssertFalse(library.isCreatorSaved(second))
        XCTAssertTrue(library.toggleCreator(first))
        XCTAssertEqual(library.savedCreators.count, 2, "Saving one verified owner must not remove the unresolved bookmark")
        XCTAssertTrue(library.toggleCreator(first))
        XCTAssertEqual(library.savedCreators, [legacy])

        let reopened = Library(directory: storeDirectory, catalogURL: catalogURL)
        XCTAssertEqual(reopened.savedCreators, [legacy])
        XCTAssertFalse(reopened.isCreatorSaved(first))
        XCTAssertFalse(reopened.isCreatorSaved(second))
        XCTAssertTrue(reopened.toggleCreator(legacy))
        XCTAssertTrue(reopened.savedCreators.isEmpty)
    }

    func testCreatorDirectoryMergesCompatibleLegacyHandlesWithoutGuessingFromNames() {
        let first = creator(id: "legacy-one", name: "Same display name", username: "taylor")
        let second = creator(id: "legacy-two", name: "Same display name", username: "TAYLOR")
        let unrelated = creator(id: "other", name: "Same display name", username: "different")
        let items = [prompt(id: "first", creator: first), prompt(id: "second", creator: second), prompt(id: "third", creator: unrelated)]
        let entries = CreatorDirectory.entries(in: items)
        XCTAssertEqual(entries.map(\.count), [2, 1])
        XCTAssertEqual(entries.map(\.creator), CreatorDirectory.entries(in: Array(items.reversed())).map(\.creator))
    }

    func testLanguageCanonicalizationUsesExplicitChineseScriptBeforeRegion() {
        let cases = [
            "zh-TW": "zh-Hant", "zh_HK": "zh-Hant", "zh-MO": "zh-Hant",
            "zh-Hant": "zh-Hant", "zh-Hant-CN": "zh-Hant",
            "zh-Hans-HK": "zh-Hans", "zh-Hans-TW": "zh-Hans", "zh-CN": "zh-Hans",
            "pt_BR": "pt-BR", "PT-br": "pt-BR", "pt-PT": "pt-BR",
            "en_US": "en", "ja-JP": "ja", "ko-KR": "ko", "es-MX": "es",
            "fr-CA": "fr", "de-DE": "de", "ru-RU": "en", "unknown": "en", "": "en"
        ]
        for (input, expected) in cases {
            XCTAssertEqual(ContentLanguage.canonical(input), expected, input)
        }
    }

    func testRequestedTranslationUsesCanonicalLocaleAndPreservesCompleteContent() throws {
        let item = localizedPrompt(id: "localized")
        let japanese = try XCTUnwrap(item.localization?.translations["ja"])
        let traditional = try XCTUnwrap(item.localization?.translations["zh-Hant"])

        XCTAssertEqual(item.content(in: "ja-JP"), japanese)
        XCTAssertEqual(item.content(in: "zh_TW"), traditional)
        XCTAssertEqual(item.content(in: "zh-Hant-CN"), traditional)
        XCTAssertTrue(item.content(in: "ja-JP").prompt.contains("{{topic}}"))
        XCTAssertEqual(item.availableLanguages, ["en", "zh-Hant", "ja"])
    }

    func testMissingOrUnsupportedContentLanguageReturnsSourceInsteadOfEnglishTranslation() {
        let item = localizedPrompt(id: "localized")
        let original = Prompt.TranslatedContent(title: item.title, summary: item.summary, prompt: item.prompt,
            example: item.example, previewLabel: item.previewLabel,
            cover: item.cover.map { Prompt.TranslatedCover(text: $0.text, eyebrow: $0.eyebrow) })

        XCTAssertNotEqual(item.content(in: "en").prompt, item.prompt)
        XCTAssertEqual(item.content(in: nil), original)
        XCTAssertEqual(item.content(in: "fr-FR"), original, "A supported but untranslated language must preserve the source")
        XCTAssertEqual(item.content(in: "ru-RU"), original, "An unsupported explicit request must not select an unrelated English translation")
        XCTAssertEqual(item.content(in: "unknown"), original)
        XCTAssertEqual(prompt(id: "no-translations").content(in: "ja").prompt, item.prompt)
    }

    func testSkillFiltersDoNotLeakIntoTextModalityAndCombineWithExactCreator() {
        let first = creator(id: "github:101", name: "Alex", username: "alex-one", platform: "github")
        let second = creator(id: "github:102", name: "Alex", username: "alex-two", platform: "github")
        var firstSkill = prompt(id: "skill-one", creator: first)
        firstSkill.contentType = "skill"
        firstSkill.skill = skill()
        var secondSkill = prompt(id: "skill-two", creator: second)
        secondSkill.contentType = "skill"
        secondSkill.skill = skill()
        let text = prompt(id: "text", creator: first)
        let image = prompt(id: "image", kind: .image, creator: first)
        let items = [firstSkill, secondSkill, text, image]

        XCTAssertEqual(items.filter(PromptQuery().matches).map(\.id), items.map(\.id))
        XCTAssertEqual(items.filter(PromptQuery(kind: .text).matches).map(\.id), [text.id])
        XCTAssertEqual(items.filter(PromptQuery(skillsOnly: true).matches).map(\.id), [firstSkill.id, secondSkill.id])
        XCTAssertEqual(items.filter(PromptQuery(skillsOnly: true, creatorID: first.id).matches).map(\.id), [firstSkill.id])
        XCTAssertEqual(items.filter(PromptQuery(kind: .image, creatorID: first.id).matches).map(\.id), [image.id])
        XCTAssertTrue(items.filter(PromptQuery(kind: .image, creatorID: second.id).matches).isEmpty)
        XCTAssertEqual(items.filter(PromptQuery(text: "ALEX-ONE", skillsOnly: true).matches).map(\.id), [firstSkill.id])
    }

    func testSearchFindsSourceAndUnlinkedAuthorWithoutMatchingPromptText() {
        let first = prompt(id: "first", source: Prompt.Source(name: "YouMind OpenLab", url: nil,
            license: "Original test fixture", method: "original", author: "Aster & Morgan"))
        let second = prompt(id: "second", source: Prompt.Source(name: "prompts.chat", url: nil,
            license: "Original test fixture", method: "original", author: "River Workshop"))
        let items = [first, second]

        XCTAssertNil(first.creator, "Multi-author attribution should remain searchable without an invented profile")
        XCTAssertEqual(items.filter(PromptQuery(text: "youmind openlab").matches).map(\.id), [first.id])
        XCTAssertEqual(items.filter(PromptQuery(text: "ASTER & MORGAN").matches).map(\.id), [first.id])
        XCTAssertEqual(items.filter(PromptQuery(text: "prompts.chat").matches).map(\.id), [second.id])
        XCTAssertEqual(items.filter(PromptQuery(text: "River Workshop").matches).map(\.id), [second.id])
    }

    func testTranslatedDraftsRemainIsolatedFromSourceAndSurviveRelaunch() throws {
        let item = localizedPrompt(id: "draft")
        let library = try makeLibrary(items: [item])
        XCTAssertTrue(library.saveDraft("My original-language revision", for: item))
        XCTAssertTrue(library.saveDraft("My English revision", for: item, language: "en-US"))
        XCTAssertTrue(library.saveDraft("日本語の編集 {{topic}}", for: item, language: "ja-JP"))
        XCTAssertTrue(library.saveDraft("繁體中文的修改 {{topic}}", for: item, language: "zh-TW"))

        let reopened = Library(directory: storeDirectory, catalogURL: catalogURL)

        XCTAssertEqual(reopened.draft(for: item), "My original-language revision")
        XCTAssertEqual(reopened.draft(for: item, language: "en"), "My English revision")
        XCTAssertEqual(reopened.draft(for: item, language: "ja"), "日本語の編集 {{topic}}")
        XCTAssertEqual(reopened.draft(for: item, language: "zh-Hant"), "繁體中文的修改 {{topic}}")
        XCTAssertEqual(reopened.prompts.first, item, "Private edits must not alter the downloaded source or its translations")
    }

    func testRestoringOneTranslationPreservesOtherLanguagesAndOriginalDraft() throws {
        let item = localizedPrompt(id: "restore")
        let library = try makeLibrary(items: [item])
        XCTAssertTrue(library.saveDraft("Keep source edit", for: item))
        XCTAssertTrue(library.saveDraft("Keep English edit", for: item, language: "en"))
        XCTAssertTrue(library.saveDraft("Replace Japanese edit", for: item, language: "ja"))
        XCTAssertTrue(library.saveDraft(item.content(in: "ja").prompt, for: item, language: "ja-JP"))

        let reopened = Library(directory: storeDirectory, catalogURL: catalogURL)

        XCTAssertEqual(reopened.draft(for: item), "Keep source edit")
        XCTAssertEqual(reopened.draft(for: item, language: "en"), "Keep English edit")
        XCTAssertEqual(reopened.draft(for: item, language: "ja"), item.content(in: "ja").prompt)
        XCTAssertEqual(reopened.drafts.count, 2, "Restored text should no longer occupy a private draft entry")
    }

    func testAddingTranslationsToExistingContentPreservesLegacyOriginalDraft() throws {
        let original = prompt(id: "legacy")
        let library = try makeLibrary(items: [original])
        XCTAssertTrue(library.saveDraft("A draft created before multilingual support", for: original))
        let enriched = localizedPrompt(id: original.id)

        try install([enriched], version: "edition-translations", into: library)
        let reopened = Library(directory: storeDirectory, catalogURL: catalogURL)

        XCTAssertEqual(reopened.prompts, [enriched])
        XCTAssertEqual(reopened.draft(for: enriched), "A draft created before multilingual support")
        XCTAssertEqual(reopened.draft(for: enriched, language: "ja"), enriched.content(in: "ja").prompt)
        XCTAssertTrue(reopened.saveDraft("New Japanese draft", for: enriched, language: "ja"))
        XCTAssertEqual(reopened.draft(for: enriched), "A draft created before multilingual support")
    }

    func testCatalogRemovalDeletesEveryLanguageDraftButPreservesUnrelatedContent() throws {
        let removed = localizedPrompt(id: "removed")
        let kept = localizedPrompt(id: "removed-but-unrelated")
        let library = try makeLibrary(items: [removed, kept])
        XCTAssertTrue(library.saveDraft("Remove source edit", for: removed))
        XCTAssertTrue(library.saveDraft("Remove English edit", for: removed, language: "en"))
        XCTAssertTrue(library.saveDraft("Remove Japanese edit", for: removed, language: "ja"))
        XCTAssertTrue(library.saveDraft("Keep source edit", for: kept))
        XCTAssertTrue(library.saveDraft("Keep Japanese edit", for: kept, language: "ja"))
        XCTAssertTrue(library.toggle(removed))
        XCTAssertTrue(library.toggle(kept))

        try install([kept], version: "edition-removed", removedIDs: [removed.id], into: library)
        let reopened = Library(directory: storeDirectory, catalogURL: catalogURL)

        XCTAssertEqual(reopened.prompts, [kept])
        XCTAssertEqual(reopened.favorites, [kept])
        XCTAssertEqual(reopened.drafts.count, 2)
        XCTAssertEqual(reopened.draft(for: kept), "Keep source edit")
        XCTAssertEqual(reopened.draft(for: kept, language: "ja"), "Keep Japanese edit")
        XCTAssertEqual(reopened.draft(for: removed), removed.prompt)
        XCTAssertEqual(reopened.draft(for: removed, language: "en"), removed.content(in: "en").prompt)
        XCTAssertEqual(reopened.draft(for: removed, language: "ja"), removed.content(in: "ja").prompt)
    }

    func testFailedTranslationWriteKeepsPreviouslySavedSourceAndTranslation() throws {
        let item = localizedPrompt(id: "write-failure")
        let library = try makeLibrary(items: [item])
        XCTAssertTrue(library.saveDraft("Keep source draft", for: item))
        XCTAssertTrue(library.saveDraft("Keep Japanese draft", for: item, language: "ja"))
        let draftFile = storeDirectory.appending(path: "drafts.json")
        let savedBytes = try Data(contentsOf: draftFile)
        try FileManager.default.removeItem(at: draftFile)
        try FileManager.default.createDirectory(at: draftFile, withIntermediateDirectories: true)

        XCTAssertFalse(library.saveDraft("Unwritten replacement", for: item, language: "ja"))
        XCTAssertEqual(library.draft(for: item), "Keep source draft")
        XCTAssertEqual(library.draft(for: item, language: "ja"), "Keep Japanese draft")

        try FileManager.default.removeItem(at: draftFile)
        try savedBytes.write(to: draftFile, options: .atomic)
        let reopened = Library(directory: storeDirectory, catalogURL: catalogURL)
        XCTAssertEqual(reopened.draft(for: item), "Keep source draft")
        XCTAssertEqual(reopened.draft(for: item, language: "ja"), "Keep Japanese draft")
    }

    func testSavedCreatorSnapshotsSurviveRelaunchAndRemovalUsesExactAccountID() throws {
        let first = creator(id: "x:101", name: "Sam", username: "sam-art")
        let second = creator(id: "github:202", name: "Sam", username: "sam-code", platform: "github")
        let library = try makeLibrary(items: [prompt(id: "one", creator: first)])
        XCTAssertTrue(library.toggleCreator(first))
        XCTAssertTrue(library.toggleCreator(second))

        let reopened = Library(directory: storeDirectory, catalogURL: catalogURL)
        XCTAssertEqual(reopened.savedCreators, [second, first])
        let renamedFirst = creator(id: first.id, name: "A new display name", username: "renamed-art")
        XCTAssertTrue(reopened.isCreatorSaved(renamedFirst))
        XCTAssertTrue(reopened.toggleCreator(renamedFirst))

        let afterRemoval = Library(directory: storeDirectory, catalogURL: catalogURL)
        XCTAssertEqual(afterRemoval.savedCreators, [second])
        XCTAssertTrue(afterRemoval.isCreatorSaved(second))
        XCTAssertFalse(afterRemoval.isCreatorSaved(first))
    }

    func testFailedCreatorWritePreservesTheSavedSnapshotInMemoryAndAfterRecovery() throws {
        let saved = creator(id: "x:101", name: "Saved creator")
        let other = creator(id: "x:102", name: "Another creator")
        let library = try makeLibrary(items: [prompt(id: "one")])
        XCTAssertTrue(library.toggleCreator(saved))
        let file = storeDirectory.appending(path: "creators.json")
        let savedBytes = try Data(contentsOf: file)
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: true)

        XCTAssertFalse(library.toggleCreator(other))
        XCTAssertFalse(library.toggleCreator(saved))
        XCTAssertEqual(library.savedCreators, [saved])
        XCTAssertTrue(library.isCreatorSaved(saved))
        XCTAssertFalse(library.isCreatorSaved(other))
        XCTAssertNotNil(library.error)

        try FileManager.default.removeItem(at: file)
        try savedBytes.write(to: file, options: .atomic)
        XCTAssertEqual(Library(directory: storeDirectory, catalogURL: catalogURL).savedCreators, [saved])
    }

    func testSavedCreatorUpgradesFromHandleToVerifiedIdentityAndUsesCurrentProfile() throws {
        let original = creator(id: "x-taylor", name: "Taylor", username: "@Taylor")
        var verified = creator(id: "x-id-123", name: "Taylor Design", username: "taylor")
        verified.externalID = "123"
        verified.avatarURL = URL(string: "https://api.prompix.dev/media/taylor-new.jpg")!
        verified.bio = "Current creator biography."
        let library = try makeLibrary(items: [prompt(id: "original", creator: original)])
        XCTAssertTrue(library.toggleCreator(original))

        // No shared prompt ID is required when the platform handle is unchanged.
        try install([prompt(id: "new-work", creator: verified)], version: "verified", into: library)

        XCTAssertEqual(library.savedCreators, [verified])
        XCTAssertEqual(library.currentCreator(original), verified)
        XCTAssertEqual(library.items(for: original).map(\.id), ["new-work"])
        XCTAssertTrue(library.isCreatorSaved(original))
        XCTAssertTrue(library.isCreatorSaved(verified))
        let reopened = Library(directory: storeDirectory, catalogURL: catalogURL)
        XCTAssertEqual(reopened.savedCreators, [verified])
        XCTAssertTrue(reopened.toggleCreator(verified))
        XCTAssertTrue(reopened.savedCreators.isEmpty, "Opening the verified profile must remove the original bookmark, not add a duplicate")
    }

    func testVerifiedCreatorRenameRefreshesSavedProfileByNumericIdentity() throws {
        var original = creator(id: "legacy-account-key", name: "Before", username: "old-handle")
        original.externalID = "123"
        var renamed = creator(id: "x-id-123", name: "After", username: "new-handle")
        renamed.externalID = "123"
        renamed.avatarURL = URL(string: "https://api.prompix.dev/media/renamed.jpg")!
        let library = try makeLibrary(items: [prompt(id: "old-work", creator: original)])
        XCTAssertTrue(library.toggleCreator(original))

        try install([prompt(id: "different-work", creator: renamed)], version: "renamed", into: library)

        XCTAssertEqual(library.savedCreators, [renamed])
        XCTAssertEqual(library.currentCreator(original).profileURL, renamed.profileURL)
        XCTAssertEqual(library.items(for: original).map(\.id), ["different-work"])
        XCTAssertEqual(Library(directory: storeDirectory, catalogURL: catalogURL).savedCreators, [renamed])
    }

    func testStablePromptAttributionMigratesRenamedLegacyCreatorBeforeReusedHandle() throws {
        let original = creator(id: "x-old-handle", name: "Original creator", username: "old-handle")
        var renamed = creator(id: "x-id-123", name: "Original creator renamed", username: "new-handle")
        renamed.externalID = "123"
        var unrelated = creator(id: "x-id-456", name: "New handle owner", username: "old-handle")
        unrelated.externalID = "456"
        let library = try makeLibrary(items: [prompt(id: "stable-work", creator: original)])
        XCTAssertTrue(library.toggleCreator(original))

        try install([prompt(id: "unrelated-work", creator: unrelated), prompt(id: "stable-work", creator: renamed)],
            version: "renamed-and-reused", into: library)

        XCTAssertEqual(library.savedCreators, [renamed])
        XCTAssertEqual(library.currentCreator(original), renamed)
        XCTAssertEqual(library.items(for: original).map(\.id), ["stable-work"])
        XCTAssertFalse(library.isCreatorSaved(unrelated))
        XCTAssertTrue(library.toggleCreator(renamed))
        XCTAssertTrue(library.savedCreators.isEmpty)
    }

    func testLaunchMigratesLegacyBookmarkUsingSavedPromptBeforeEnrichingIt() throws {
        let original = creator(id: "x-old-handle", name: "Before", username: "old-handle")
        var renamed = creator(id: "x-id-123", name: "After", username: "new-handle")
        renamed.externalID = "123"
        let oldPrompt = prompt(id: "stable-work", creator: original)
        let library = try makeLibrary(items: [oldPrompt])
        XCTAssertTrue(library.toggleCreator(original))
        XCTAssertTrue(library.toggle(oldPrompt))
        let updatedPrompt = prompt(id: oldPrompt.id, creator: renamed)
        let catalog = Catalog(schemaVersion: 1, version: "already-downloaded", prompts: [updatedPrompt])
        try JSONEncoder().encode(catalog).write(to: storeDirectory.appending(path: "catalog.json"), options: .atomic)

        let reopened = Library(directory: storeDirectory, catalogURL: catalogURL)

        XCTAssertEqual(reopened.savedCreators, [renamed])
        XCTAssertEqual(reopened.favorites, [updatedPrompt])
        XCTAssertEqual(reopened.currentCreator(original), renamed)
        XCTAssertEqual(Library(directory: storeDirectory, catalogURL: catalogURL).savedCreators, [renamed])
    }

    func testDifferentVerifiedAccountsNeverMergeThroughReusedHandleOrStablePrompt() throws {
        var original = creator(id: "x-id-123", name: "Same name", username: "same-handle")
        original.externalID = "123"
        var unrelated = creator(id: "x-id-456", name: original.displayName, username: original.username)
        unrelated.externalID = "456"
        let library = try makeLibrary(items: [prompt(id: "stable-work", creator: original)])
        XCTAssertTrue(library.toggleCreator(original))

        try install([prompt(id: "stable-work", creator: unrelated)], version: "changed-attribution", into: library)

        XCTAssertEqual(library.savedCreators, [original])
        XCTAssertEqual(library.currentCreator(original), original)
        XCTAssertTrue(library.items(for: original).isEmpty)
        XCTAssertFalse(library.isCreatorSaved(unrelated))
        XCTAssertFalse(original.matchesIdentity(of: unrelated))
        XCTAssertTrue(library.toggleCreator(unrelated))
        XCTAssertEqual(library.savedCreators, [unrelated, original])
        XCTAssertFalse(original.matchesIdentity(of: creator(id: original.id, name: original.displayName, username: original.username, platform: "github")))
    }

    func testCreatorMigrationWriteFailurePreservesOldMetadataAndCatalogUntilRetry() throws {
        let original = creator(id: "x-old-handle", name: "Before", username: "old-handle")
        var renamed = creator(id: "x-id-123", name: "After", username: "new-handle")
        renamed.externalID = "123"
        let oldPrompt = prompt(id: "stable-work", creator: original)
        let newPrompt = prompt(id: oldPrompt.id, creator: renamed)
        let library = try makeLibrary(items: [oldPrompt])
        XCTAssertTrue(library.toggleCreator(original))
        try install([oldPrompt], version: "before-migration", into: library)
        let creatorsFile = storeDirectory.appending(path: "creators.json")
        let catalogFile = storeDirectory.appending(path: "catalog.json")
        let creatorBytes = try Data(contentsOf: creatorsFile)
        let catalogBytes = try Data(contentsOf: catalogFile)
        try FileManager.default.removeItem(at: creatorsFile)
        try FileManager.default.createDirectory(at: creatorsFile, withIntermediateDirectories: true)

        XCTAssertThrowsError(try install([newPrompt], version: "after-migration", into: library))
        XCTAssertEqual(library.savedCreators, [original])
        XCTAssertEqual(library.prompts, [oldPrompt])
        XCTAssertEqual(library.version, "before-migration")
        XCTAssertEqual(try Data(contentsOf: catalogFile), catalogBytes)

        try FileManager.default.removeItem(at: creatorsFile)
        try creatorBytes.write(to: creatorsFile, options: .atomic)
        let reopened = Library(directory: storeDirectory, catalogURL: catalogURL)
        XCTAssertEqual(reopened.savedCreators, [original])
        XCTAssertEqual(try Data(contentsOf: creatorsFile), creatorBytes)
        try install([newPrompt], version: "after-migration", into: reopened)
        XCTAssertEqual(reopened.savedCreators, [renamed])
        XCTAssertEqual(reopened.items(for: renamed), [newPrompt])
    }

    func testCatalogWriteFailureRollsBackCreatorMigration() throws {
        let original = creator(id: "x-old-handle", name: "Before", username: "old-handle")
        var renamed = creator(id: "x-id-123", name: "After", username: "new-handle")
        renamed.externalID = "123"
        let oldPrompt = prompt(id: "stable-work", creator: original)
        let library = try makeLibrary(items: [oldPrompt])
        XCTAssertTrue(library.toggleCreator(original))
        let creatorsFile = storeDirectory.appending(path: "creators.json")
        let originalBytes = try Data(contentsOf: creatorsFile)
        try FileManager.default.createDirectory(at: storeDirectory.appending(path: "catalog.json"), withIntermediateDirectories: true)

        XCTAssertThrowsError(try install([prompt(id: oldPrompt.id, creator: renamed)], version: "unwritten", into: library))

        XCTAssertEqual(library.savedCreators, [original])
        XCTAssertEqual(library.prompts, [oldPrompt])
        XCTAssertEqual(try Data(contentsOf: creatorsFile), originalBytes)
    }

    func testCorruptCreatorStoreBlocksWritesAndRetentionUntilExplicitRecovery() throws {
        let saved = creator(id: "x:101", name: "Saved creator")
        let other = creator(id: "x:102", name: "Another creator")
        let item = localizedPrompt(id: "saved-prompt")
        let library = try makeLibrary(items: [item])
        XCTAssertTrue(library.toggle(item))
        XCTAssertTrue(library.saveDraft("Keep my prompt edit", for: item, language: "ja"))
        let file = storeDirectory.appending(path: "creators.json")
        let broken = Data("An unreadable creator store".utf8)
        try broken.write(to: file, options: .atomic)
        let reopened = Library(directory: storeDirectory, catalogURL: catalogURL)

        XCTAssertFalse(reopened.savedCreatorsReadable)
        XCTAssertNil(reopened.savedImageURLs, "An unknown saved-creator set must never initiate avatar deletion")
        XCTAssertFalse(reopened.toggleCreator(other))
        reopened.reloadSavedCreators()
        XCTAssertFalse(reopened.savedCreatorsReadable)
        XCTAssertEqual(try Data(contentsOf: file), broken)
        XCTAssertEqual(reopened.favorites, [item])
        XCTAssertEqual(reopened.draft(for: item, language: "ja"), "Keep my prompt edit")

        try JSONEncoder().encode([saved]).write(to: file, options: .atomic)
        reopened.reloadSavedCreators()
        XCTAssertTrue(reopened.savedCreatorsReadable)
        XCTAssertEqual(reopened.savedCreators, [saved])
        XCTAssertNotNil(reopened.savedImageURLs)
        XCTAssertTrue(reopened.toggleCreator(other))
        XCTAssertEqual(Library(directory: storeDirectory, catalogURL: catalogURL).savedCreators, [other, saved])
    }

    func testCreatorBookmarkEditsDoNotRewritePromptFavoritesOrLanguageDrafts() throws {
        let item = localizedPrompt(id: "independent-storage")
        let saved = creator(id: "x:101", name: "Bookmarked creator")
        let library = try makeLibrary(items: [item])
        XCTAssertTrue(library.toggle(item))
        XCTAssertTrue(library.saveDraft("Keep source draft", for: item))
        XCTAssertTrue(library.saveDraft("Keep Japanese draft", for: item, language: "ja"))
        let files = ["favorites.json", "drafts.json"]
        let before = try files.map { try Data(contentsOf: storeDirectory.appending(path: $0)) }

        XCTAssertTrue(library.toggleCreator(saved))
        XCTAssertTrue(library.toggleCreator(saved))
        XCTAssertEqual(try files.map { try Data(contentsOf: storeDirectory.appending(path: $0)) }, before)

        let reopened = Library(directory: storeDirectory, catalogURL: catalogURL)
        XCTAssertTrue(reopened.savedCreators.isEmpty)
        XCTAssertEqual(reopened.favorites, [item])
        XCTAssertEqual(reopened.draft(for: item), "Keep source draft")
        XCTAssertEqual(reopened.draft(for: item, language: "ja"), "Keep Japanese draft")
    }

    func testImageRetentionUnionsSavedPromptAndCreatorAvatarsAndStopsForUnreadableFavorites() throws {
        let coverURL = URL(string: "https://api.prompix.dev/media/prompt-cover.jpg")!
        let firstAvatar = URL(string: "https://api.prompix.dev/media/first-avatar.jpg")!
        let secondAvatar = URL(string: "https://api.prompix.dev/media/second-avatar.jpg")!
        var author = creator(id: "x:101", name: "Prompt author")
        author.avatarURL = firstAvatar
        var second = creator(id: "x:102", name: "Saved creator")
        second.avatarURL = secondAvatar
        var sharedAvatar = creator(id: "x:103", name: "Shared avatar creator")
        sharedAvatar.avatarURL = firstAvatar
        let item = prompt(id: "with-media", creator: author,
            media: Prompt.Media(image: nil, video: nil, demoURL: nil, imageURL: coverURL))
        let library = try makeLibrary(items: [item])
        XCTAssertTrue(library.toggle(item))
        XCTAssertTrue(library.toggleCreator(second))
        XCTAssertTrue(library.toggleCreator(sharedAvatar))
        XCTAssertEqual(library.savedImageURLs, Set([coverURL, firstAvatar, secondAvatar]))

        XCTAssertTrue(library.toggleCreator(second))
        XCTAssertEqual(library.savedImageURLs, Set([coverURL, firstAvatar]))
        XCTAssertTrue(library.toggle(item))
        XCTAssertEqual(library.savedImageURLs, Set([firstAvatar]), "A shared avatar remains retained while its creator is saved")
        XCTAssertTrue(library.toggleCreator(sharedAvatar))
        XCTAssertEqual(library.savedImageURLs, Set<URL>())

        XCTAssertTrue(library.toggleCreator(second))
        try Data("Unreadable prompt favorites".utf8).write(to: storeDirectory.appending(path: "favorites.json"), options: .atomic)
        let reopened = Library(directory: storeDirectory, catalogURL: catalogURL)
        XCTAssertTrue(reopened.savedCreatorsReadable)
        XCTAssertFalse(reopened.favoritesReadable)
        XCTAssertNil(reopened.savedImageURLs, "Either unreadable store must suspend destructive retention reconciliation")
    }

    func testSavedPromptsReceiveTranslationsOnlyWhenOriginalInstructionsAreUnchanged() throws {
        let unchanged = prompt(id: "stable-instructions")
        let changed = localizedPrompt(id: "changed-instructions")
        let library = try makeLibrary(items: [unchanged, changed])
        XCTAssertTrue(library.toggle(unchanged))
        XCTAssertTrue(library.toggle(changed))
        XCTAssertTrue(library.saveDraft("Keep stable-source edit", for: unchanged))
        XCTAssertTrue(library.saveDraft("Keep changed-source edit", for: changed))
        XCTAssertTrue(library.saveDraft("Keep prior Japanese edit", for: changed, language: "ja"))
        let draftFile = storeDirectory.appending(path: "drafts.json")
        let originalDraftBytes = try Data(contentsOf: draftFile)
        let enrichedCreator = creator(id: "x:101", name: "Newly resolved author")
        var enrichedUnchanged = localizedPrompt(id: unchanged.id)
        enrichedUnchanged.creator = enrichedCreator
        var incomingChanged = prompt(id: changed.id, creator: enrichedCreator, body: "A different instruction about {{topic}}.")
        incomingChanged.localization = enrichedUnchanged.localization
        let expectedFavorites = [changed, enrichedUnchanged]

        try install([enrichedUnchanged, incomingChanged], version: "edition-enriched-favorites", into: library)

        XCTAssertEqual(library.favorites, expectedFavorites)
        XCTAssertEqual(library.prompts, [enrichedUnchanged, incomingChanged])
        XCTAssertEqual(try Data(contentsOf: draftFile), originalDraftBytes)
        let afterInstall = Library(directory: storeDirectory, catalogURL: catalogURL)
        XCTAssertEqual(afterInstall.favorites, expectedFavorites)

        // Exercise launch-time enrichment independently from the installation path.
        let favoriteFile = storeDirectory.appending(path: "favorites.json")
        try JSONEncoder().encode([changed, unchanged]).write(to: favoriteFile, options: .atomic)
        let afterLaunch = Library(directory: storeDirectory, catalogURL: catalogURL)
        XCTAssertEqual(afterLaunch.favorites, expectedFavorites)
        XCTAssertEqual(try JSONDecoder().decode([Prompt].self, from: Data(contentsOf: favoriteFile)), expectedFavorites)
        XCTAssertEqual(afterLaunch.draft(for: enrichedUnchanged), "Keep stable-source edit")
        XCTAssertEqual(afterLaunch.draft(for: changed), "Keep changed-source edit")
        XCTAssertEqual(afterLaunch.draft(for: changed, language: "ja"), "Keep prior Japanese edit")
        XCTAssertEqual(afterLaunch.draft(for: enrichedUnchanged, language: "ja"), enrichedUnchanged.content(in: "ja").prompt)
        XCTAssertEqual(try Data(contentsOf: draftFile), originalDraftBytes)
    }

    func testCatalogTransactionRestoresEveryStoreAfterEachCommitStageFails() throws {
        for failureName in ["creators.json", "catalog.json", "drafts.json", "favorites.json"] {
            if FileManager.default.fileExists(atPath: storeDirectory.path) { try FileManager.default.removeItem(at: storeDirectory) }
            let fixture = try transactionFixture()
            let before = try storeBytes()
            var failingFile: String? = failureName
            var attempted: [String] = []
            let library = Library(directory: storeDirectory, catalogURL: catalogURL) { data, url in
                attempted.append(url.lastPathComponent)
                if url.lastPathComponent == failingFile { throw CocoaError(.fileWriteOutOfSpace) }
                try data.write(to: url, options: .atomic)
            }
            let favorites = library.favorites
            let drafts = library.drafts

            XCTAssertThrowsError(try install([fixture.updated], version: "after-transaction", removedIDs: [fixture.removed.id], into: library))

            XCTAssertEqual(attempted.last, failureName)
            XCTAssertEqual(try storeBytes(), before, "Failure at \(failureName) must restore all prior bytes")
            XCTAssertEqual(library.version, "before-transaction")
            XCTAssertEqual(library.prompts, [fixture.original, fixture.removed])
            XCTAssertEqual(library.savedCreators, [fixture.original.creator!])
            XCTAssertEqual(library.currentCreator(fixture.original.creator!), fixture.original.creator)
            XCTAssertEqual(library.favorites, favorites)
            XCTAssertEqual(library.drafts, drafts)
            XCTAssertNotNil(library.savedImageURLs)
            XCTAssertFalse(FileManager.default.fileExists(atPath: storeDirectory.appending(path: "catalog-transaction.json").path))
            let reopened = Library(directory: storeDirectory, catalogURL: catalogURL)
            XCTAssertEqual(reopened.version, "before-transaction")
            XCTAssertEqual(reopened.favorites, favorites)
            XCTAssertEqual(reopened.drafts, drafts)

            failingFile = nil
            try install([fixture.updated], version: "after-transaction", removedIDs: [fixture.removed.id], into: library)
            XCTAssertEqual(library.version, "after-transaction")
            XCTAssertEqual(library.savedCreators, [fixture.updated.creator!])
            XCTAssertFalse(library.isSaved(fixture.removed))
            XCTAssertNil(library.drafts[fixture.removed.id])
            XCTAssertNil(library.drafts[fixture.removed.id + "::ja"])
            XCTAssertEqual(Library(directory: storeDirectory, catalogURL: catalogURL).prompts, [fixture.updated])
        }
    }

    func testFailedFirstCatalogCommitRestoresAnAbsentCacheFile() throws {
        let original = prompt(id: "initial")
        _ = try makeLibrary(items: [original])
        let cache = storeDirectory.appending(path: "catalog.json")
        let library = Library(directory: storeDirectory, catalogURL: catalogURL) { data, url in
            try data.write(to: url, options: .atomic)
            throw CocoaError(.fileWriteOutOfSpace)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: cache.path))

        XCTAssertThrowsError(try install([prompt(id: "incoming")], version: "failed-first-cache", into: library))

        XCTAssertFalse(FileManager.default.fileExists(atPath: cache.path), "Rollback must remove a file that did not previously exist")
        XCTAssertEqual(library.prompts, [original])
        XCTAssertEqual(Library(directory: storeDirectory, catalogURL: catalogURL).prompts, [original])
    }

    func testLaunchRollsBackAnInterruptedTransactionBeforeReadingPersonalStores() throws {
        let fixture = try transactionFixture()
        let before = try storeBytes()
        let journal = storeDirectory.appending(path: "catalog-transaction.json")
        var pendingJournal: Data?
        let library = Library(directory: storeDirectory, catalogURL: catalogURL) { data, url in
            if pendingJournal == nil { pendingJournal = try Data(contentsOf: journal) }
            try data.write(to: url, options: .atomic)
        }
        try install([fixture.updated], version: "interrupted-commit", removedIDs: [fixture.removed.id], into: library)
        // Recreate termination after all data writes but before deleting the journal.
        // It is the actual journal emitted by the transaction, not a mirrored fixture schema.
        try XCTUnwrap(pendingJournal).write(to: journal, options: .atomic)

        let recovered = Library(directory: storeDirectory, catalogURL: catalogURL)

        XCTAssertEqual(try storeBytes(), before)
        XCTAssertEqual(recovered.version, "before-transaction")
        XCTAssertEqual(recovered.prompts, [fixture.original, fixture.removed])
        XCTAssertEqual(recovered.savedCreators, [fixture.original.creator!])
        XCTAssertTrue(recovered.isSaved(fixture.removed))
        XCTAssertEqual(recovered.draft(for: fixture.removed), "Keep removed source draft")
        XCTAssertEqual(recovered.draft(for: fixture.removed, language: "ja"), "Keep removed Japanese draft")
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testFailedRollbackRetainsJournalAndBlocksMutationsUntilLaunchRecovery() throws {
        let fixture = try transactionFixture()
        let before = try storeBytes()
        let favoriteFile = storeDirectory.appending(path: "favorites.json")
        let journal = storeDirectory.appending(path: "catalog-transaction.json")
        let library = Library(directory: storeDirectory, catalogURL: catalogURL) { data, url in
            if url.lastPathComponent == "favorites.json" {
                try FileManager.default.removeItem(at: url)
                try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
                throw CocoaError(.fileWriteOutOfSpace)
            }
            try data.write(to: url, options: .atomic)
        }
        XCTAssertThrowsError(try install([fixture.updated], version: "blocked-rollback", removedIDs: [fixture.removed.id], into: library))
        let pendingBytes = try Data(contentsOf: journal)
        XCTAssertNil(library.savedImageURLs)
        XCTAssertFalse(library.toggle(fixture.original))
        XCTAssertFalse(library.toggleCreator(fixture.original.creator!))
        XCTAssertFalse(library.saveDraft("Must not invalidate the rollback snapshot", for: fixture.original))
        XCTAssertThrowsError(try install([fixture.updated], version: "blocked-second-update", into: library))
        XCTAssertEqual(try Data(contentsOf: journal), pendingBytes)
        XCTAssertEqual(library.version, "before-transaction")

        // Repair the transient filesystem obstruction, then emulate relaunch.
        try FileManager.default.removeItem(at: favoriteFile)
        let recovered = Library(directory: storeDirectory, catalogURL: catalogURL)
        XCTAssertEqual(try storeBytes(), before)
        XCTAssertEqual(recovered.version, "before-transaction")
        XCTAssertNotNil(recovered.savedImageURLs)
        XCTAssertTrue(recovered.toggle(fixture.original))
        XCTAssertTrue(recovered.saveDraft("Recovered storage is writable", for: fixture.original))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journal.path))
    }

    func testUnreadableTransactionJournalNeverOverwritesPersonalStores() throws {
        let fixture = try transactionFixture()
        let before = try storeBytes()
        let journal = storeDirectory.appending(path: "catalog-transaction.json")
        let broken = Data("Incomplete transaction metadata".utf8)
        try broken.write(to: journal, options: .atomic)

        let blocked = Library(directory: storeDirectory, catalogURL: catalogURL)

        XCTAssertFalse(blocked.favoritesReadable)
        XCTAssertFalse(blocked.savedCreatorsReadable)
        XCTAssertNil(blocked.savedImageURLs)
        XCTAssertFalse(blocked.toggle(fixture.original))
        XCTAssertFalse(blocked.toggleCreator(fixture.original.creator!))
        XCTAssertFalse(blocked.saveDraft("Not safe to save", for: fixture.original))
        blocked.reloadFavorites()
        blocked.reloadSavedCreators()
        XCTAssertEqual(try storeBytes(), before)
        XCTAssertEqual(try Data(contentsOf: journal), broken)
    }

    func testRemovedSnapshotCannotRecreateFavoritesOrOriginalAndTranslatedDrafts() throws {
        let removed = localizedPrompt(id: "removed-snapshot")
        let kept = localizedPrompt(id: "kept-snapshot")
        let archived = prompt(id: "absent-without-tombstone")
        let library = try makeLibrary(items: [removed, kept, archived])
        XCTAssertTrue(library.toggle(removed))
        XCTAssertTrue(library.saveDraft("Old source edit", for: removed))
        XCTAssertTrue(library.saveDraft("Old translated edit", for: removed, language: "ja"))
        try install([kept], version: "removed-snapshot-edition", removedIDs: [removed.id], into: library)
        let files = ["favorites.json", "drafts.json", "catalog.json"]
        let before = try files.map { try Data(contentsOf: storeDirectory.appending(path: $0)) }

        for current in [library, Library(directory: storeDirectory, catalogURL: catalogURL)] {
            XCTAssertFalse(current.toggle(removed))
            XCTAssertFalse(current.saveDraft("Delayed editor autosave", for: removed))
            XCTAssertFalse(current.saveDraft("Delayed Japanese autosave", for: removed, language: "ja-JP"))
            XCTAssertFalse(current.saveDraft(removed.prompt, for: removed))
            XCTAssertNotNil(current.error)
            XCTAssertFalse(current.isSaved(removed))
            XCTAssertNil(current.drafts[removed.id])
            XCTAssertNil(current.drafts[removed.id + "::ja"])
        }
        XCTAssertEqual(try files.map { try Data(contentsOf: storeDirectory.appending(path: $0)) }, before)
        XCTAssertTrue(library.toggle(archived), "Catalog absence alone must not revoke a previously available snapshot")
        XCTAssertTrue(library.saveDraft("Keep an archived personal edit", for: archived))
        XCTAssertTrue(library.saveDraft("Unrelated Japanese edit", for: kept, language: "ja"))
    }

    private func transactionFixture() throws -> (original: Prompt, updated: Prompt, removed: Prompt) {
        let originalCreator = creator(id: "x-legacy-handle", name: "Before", username: "legacy-handle")
        var updatedCreator = creator(id: "x-id-123", name: "After", username: "new-handle")
        updatedCreator.externalID = "123"
        let original = prompt(id: "stable-transaction-item", creator: originalCreator)
        let updated = prompt(id: original.id, creator: updatedCreator)
        let removed = localizedPrompt(id: "removed-transaction-item")
        let library = try makeLibrary(items: [original, removed])
        XCTAssertTrue(library.toggleCreator(originalCreator))
        XCTAssertTrue(library.toggle(original))
        XCTAssertTrue(library.toggle(removed))
        XCTAssertTrue(library.saveDraft("Keep stable source draft", for: original))
        XCTAssertTrue(library.saveDraft("Keep removed source draft", for: removed))
        XCTAssertTrue(library.saveDraft("Keep removed Japanese draft", for: removed, language: "ja"))
        try install([original, removed], version: "before-transaction", into: library)
        return (original, updated, removed)
    }

    private func storeBytes() throws -> [String: Data] {
        try Dictionary(uniqueKeysWithValues: ["creators.json", "catalog.json", "drafts.json", "favorites.json"].map {
            ($0, try Data(contentsOf: storeDirectory.appending(path: $0)))
        })

    }

    private func creator(id: String, name: String, username: String? = nil, platform: String = "x") -> Prompt.Creator {
        Prompt.Creator(id: id, platform: platform, displayName: name, username: username,
            profileURL: URL(string: "https://\(platform == "github" ? "github.com" : "x.com")/\(username ?? id.replacingOccurrences(of: ":", with: "-"))")!)
    }

    private func prompt(id: String, title: String = "周末计划", kind: PromptKind = .text, creator: Prompt.Creator? = nil, media: Prompt.Media? = nil,
                        body: String = "用两句话描述 {{topic}}。", source: Prompt.Source? = nil) -> Prompt {
        Prompt(id: id, kind: kind, title: title, summary: "安排一个轻松的周末。", prompt: body,
            example: "先说明地点和可用时间。", tags: ["Planning"], model: "Test model", toolURL: nil,
            artwork: "text-editorial", previewLabel: "Original test fixture",
            source: source ?? Prompt.Source(name: "Prompix tests", url: nil, license: "Original test fixture", method: "original"),
            media: media, cover: Prompt.Cover(text: "周末计划", eyebrow: "输入安排", tone: "sage"), creator: creator)
    }

    private func localizedPrompt(id: String) -> Prompt {
        var item = prompt(id: id)
        item.localization = Prompt.Localization(sourceLanguage: "zh-Hans", sourceFingerprint: String(repeating: "a", count: 64), translations: [
            "en": Prompt.TranslatedContent(title: "Weekend planning", summary: "Plan a relaxed weekend.",
                prompt: "Describe {{topic}} in two sentences.", example: "Start with the place and available time.",
                previewLabel: "Original test fixture", cover: Prompt.TranslatedCover(text: "Weekend planning", eyebrow: "Add your schedule")),
            "ja": Prompt.TranslatedContent(title: "週末の計画", summary: "ゆったりした週末を計画します。",
                prompt: "{{topic}} を二文で説明してください。", example: "場所と使える時間を入力します。",
                previewLabel: "オリジナルのテスト例", cover: Prompt.TranslatedCover(text: "週末の計画", eyebrow: "予定を入力")),
            "zh-Hant": Prompt.TranslatedContent(title: "週末計畫", summary: "安排一個輕鬆的週末。",
                prompt: "用兩句話描述 {{topic}}。", example: "先說明地點和可用時間。", previewLabel: "原創測試範例")
        ])
        return item
    }

    private func skill() -> Prompt.Skill {
        Prompt.Skill(name: "planning", description: "An original planning test skill.", format: "agent-skills", entrypoint: "SKILL.md",
            repository: URL(string: "https://github.com/example/skills")!, directory: "planning",
            installURL: URL(string: "https://github.com/example/skills/tree/main/planning")!, files: ["SKILL.md"])
    }

    private func makeLibrary(items: [Prompt]) throws -> Library {
        let catalog = Catalog(schemaVersion: 1, version: "fixture", prompts: items)
        try JSONEncoder().encode(catalog).write(to: catalogURL, options: .atomic)
        return Library(directory: storeDirectory, catalogURL: catalogURL)
    }

    private func install(_ items: [Prompt], version: String, removedIDs: [String] = [], into library: Library) throws {
        let catalog = Catalog(schemaVersion: 1, version: version, prompts: items, removedIDs: removedIDs)
        let data = try JSONEncoder().encode(catalog)
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let manifest = CatalogManifest(schemaVersion: 1, version: version, sha256: digest,
            catalog: URL(string: "https://api.prompix.dev/releases/\(version)/catalog.json")!)
        try library.install(data, manifest: manifest)
    }
}
