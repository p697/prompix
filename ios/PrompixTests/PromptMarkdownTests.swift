import XCTest
@testable import Prompix

final class PromptMarkdownTests: XCTestCase {
    func testLeadingSkillMetadataIsSeparatedWithoutChangingBodyFormatting() {
        let header = "name: research-helper\ndescription: |\n  Read sources carefully.\n  Keep citations.\nlicense: MIT"
        let source = "---\n\(header)\n---\n\n# Research\n\nUse **sources**."
        let document = PromptMarkdownDocument(source)
        XCTAssertEqual(document.metadata, header)
        XCTAssertEqual(document.blocks.map(\.kind), [.heading(1), .paragraph])
        XCTAssertEqual(document.blocks.map { String($0.text.characters) }, ["Research", "Use sources."])
        XCTAssertFalse(document.usedPlainTextFallback)
        XCTAssertEqual(PromptMarkdownDocument("---\nname: only-metadata\n---").metadata, "name: only-metadata")
        XCTAssertTrue(PromptMarkdownDocument("---\nname: only-metadata\n---").blocks.isEmpty)
    }

    func testMetadataRequiresLeadingExactClosedRulesAndYAMLKey() {
        for source in ["---\nAn introduction\n---\n\nBody", "---\nname: unclosed\n\nBody", "\n---\nname: not-leading\n---", "---\nname: wrong-close\n----\n\nBody"] {
            XCTAssertNil(PromptMarkdownDocument(source).metadata, source)
        }
        let windows = PromptMarkdownDocument("---\r\nname: windows\r\n---\r\n\r\n# Body")
        XCTAssertEqual(windows.metadata, "name: windows\r")
        XCTAssertEqual(windows.blocks.map { String($0.text.characters) }, ["Body"])
    }

    func testHeadingsParagraphsAndInlineFormatting() throws {
        let document = PromptMarkdownDocument("# A **clear** goal\n\nUse *care* and `exact tokens`.\nKeep this line.")
        XCTAssertEqual(document.blocks.count, 2)
        XCTAssertEqual(document.blocks[0].kind, .heading(1))
        XCTAssertEqual(String(document.blocks[0].text.characters), "A clear goal")
        XCTAssertEqual(String(document.blocks[1].text.characters), "Use care and exact tokens.\nKeep this line.")
        XCTAssertTrue(document.blocks[0].text.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        XCTAssertTrue(document.blocks[1].text.runs.contains { $0.inlinePresentationIntent?.contains(.emphasized) == true })
        XCTAssertTrue(document.blocks[1].text.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
        XCTAssertFalse(document.usedPlainTextFallback)
    }

    func testPlainTextUnicodePlaceholdersAndHTMLRemainReadable() {
        let source = "描述[主题]，在 ${city}。\n{{style}}\n<instructions>\nBe precise.\n</instructions>\n🙂"
        let document = PromptMarkdownDocument(source)
        XCTAssertEqual(String(document.blocks[0].text.characters), source)
        XCTAssertTrue(document.blocks[0].text.runs.allSatisfy { $0.link == nil && $0.imageURL == nil })
    }

    func testDefinitionLikePromptFieldsPreserveEveryInstruction() {
        for source in [
            "[角色]: 编辑\n[输出]: JSON\n\n请执行任务。",
            "[ROLE]: assistant\n[TASK]: summarize\n\nNow [ROLE]",
            "[ROLE]:\n assistant\n\nContinue.",
            "[ROLE]: <assistant>\n\nContinue.",
            "> [ROLE]: assistant\n>\n> Continue.",
            "- [ROLE]: assistant\n\n  Continue.",
            "[OUTPUT]: ./result.json\n\nUse this path.",
            "[action]: shortcuts://run-shortcut\n\n[action]"
        ] {
            let document = PromptMarkdownDocument(source)
            XCTAssertTrue(document.usedPlainTextFallback, source)
            XCTAssertEqual(String(document.blocks[0].text.characters), source)
            XCTAssertTrue(document.blocks[0].text.runs.allSatisfy { $0.link == nil })
        }
    }

    func testWebReferenceLinksStillRenderAndFencedFieldsStayLiteral() {
        let links = PromptMarkdownDocument("[docs]: <https://example.com/docs> \"Guide\"\n\nRead [docs].")
        XCTAssertFalse(links.usedPlainTextFallback)
        XCTAssertEqual(String(links.blocks[0].text.characters), "Read docs.")
        XCTAssertEqual(links.blocks[0].text.runs.compactMap(\.link), [URL(string: "https://example.com/docs")!])

        for source in [
            "# Example\n\n```text\n[ROLE]: assistant\n```\n\nAfter",
            "# Example\n\n~~~text\n[ROLE]: assistant\n~~~\n\nAfter",
            "# Example\n\n````text\n```\n[ROLE]: assistant\n```\n````\n\nAfter",
            "# Example\n\n    [ROLE]: assistant\n\nAfter"
        ] {
            let document = PromptMarkdownDocument(source)
            XCTAssertFalse(document.usedPlainTextFallback, source)
            XCTAssertTrue(document.blocks.contains { String($0.text.characters).contains("[ROLE]: assistant") })
        }
        let afterFence = "```text\nExample\n```\n\n[ROLE]: assistant\n\nContinue."
        XCTAssertEqual(String(PromptMarkdownDocument(afterFence).blocks[0].text.characters), afterFence)
    }

    func testNestedListsKeepMarkersDepthAndContinuationParagraphs() {
        let document = PromptMarkdownDocument("3. First\n\n   Continued.\n   - Child\n     1. Nested number\n4. Second")
        XCTAssertEqual(document.blocks.map(\.marker), ["3.", nil, "•", "1.", "4."])
        XCTAssertEqual(document.blocks.map(\.listDepth), [1, 1, 2, 3, 1])
        XCTAssertEqual(document.blocks.map { String($0.text.characters) }, ["First", "Continued.", "Child", "Nested number", "Second"])
    }

    func testQuoteAndRuleKeepStructure() {
        let document = PromptMarkdownDocument("> A quote\n>\n> Second paragraph\n\n---\n\nAfter")
        XCTAssertEqual(document.blocks.map(\.quoteDepth), [1, 1, 0, 0])
        XCTAssertEqual(document.blocks[2].kind, .separator)
    }

    func testFencedCodePreservesWhitespaceAndDoesNotInterpretContents() {
        let code = "  let name = \"[TOPIC]\"\n\tprint(name)\n\n**literal**\n"
        let document = PromptMarkdownDocument("```swift\n\(code)```\n\nNext")
        XCTAssertEqual(document.blocks[0].kind, .code("swift"))
        XCTAssertEqual(String(document.blocks[0].text.characters), code)
        XCTAssertTrue(document.blocks[0].text.runs.allSatisfy { $0.inlinePresentationIntent == nil })
        XCTAssertEqual(String(document.blocks[1].text.characters), "Next")
    }

    func testMalformedMarkdownAndUnclosedFenceDoNotDropText() {
        XCTAssertEqual(String(PromptMarkdownDocument("**unfinished [TOPIC]").blocks[0].text.characters), "**unfinished [TOPIC]")
        let document = PromptMarkdownDocument("```\n  unclosed\n  [TOPIC]")
        XCTAssertEqual(document.blocks[0].kind, .code(nil))
        XCTAssertEqual(String(document.blocks[0].text.characters), "  unclosed\n  [TOPIC]\n")
    }

    func testUnsafeLinksArePlainTextAndSafeLinksRemainTappable() {
        let source = "[web](https://example.com/a) [bad](javascript:alert%281%29) [file](file:///tmp/test) [app](shortcuts://run-shortcut) [relative](/local)"
        let document = PromptMarkdownDocument(source)
        XCTAssertEqual(String(document.blocks[0].text.characters), "web bad file app relative")
        let links = document.blocks[0].text.runs.compactMap(\.link)
        XCTAssertEqual(links, [URL(string: "https://example.com/a")!])
        XCTAssertFalse(PromptMarkdownDocument.isSafeLink(URL(string: "https:/missing-host")!))
        XCTAssertTrue(PromptMarkdownDocument.isSafeLink(URL(string: "HTTPS://example.com")!))
    }

    func testImagesKeepAltTextWithoutImageAttributesOrNetworkLoading() {
        let document = PromptMarkdownDocument("![A useful diagram](https://example.com/image.jpg)\n\n![](https://example.com/empty-alt.png)")
        XCTAssertEqual(String(document.blocks[0].text.characters), "A useful diagram")
        XCTAssertEqual(String(document.blocks[1].text.characters), "https://example.com/empty-alt.png")
        XCTAssertTrue(document.blocks.flatMap { Array($0.text.runs) }.allSatisfy { $0.imageURL == nil && $0.link == nil })
    }

    func testUnsupportedTableHasExactReadableSourceFallback() {
        let source = "# Compare\n\n| A | B |\n| - | - |\n| X | Y |"
        let document = PromptMarkdownDocument(source)
        XCTAssertTrue(document.usedPlainTextFallback)
        XCTAssertEqual(String(document.blocks[0].text.characters), source)
    }

    func testLargeSkillAndEmptySourceStayComplete() {
        XCTAssertTrue(PromptMarkdownDocument("").blocks.isEmpty)
        let source = String(repeating: "## Section\n\nUse [TOPIC].\n\n", count: 12_000)
        let document = PromptMarkdownDocument(source)
        XCTAssertTrue(document.usedPlainTextFallback)
        XCTAssertEqual(String(document.blocks[0].text.characters), source)
        let skill = String(repeating: "## Section\n\nUse [TOPIC].\n\n", count: 300)
        let parsed = PromptMarkdownDocument(skill)
        XCTAssertFalse(parsed.usedPlainTextFallback)
        XCTAssertEqual(parsed.blocks.count, 600)
        XCTAssertEqual(Set(parsed.blocks.map(\.id)).count, parsed.blocks.count)
    }
}
