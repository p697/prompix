import XCTest
@testable import Prompix

final class PromptTemplateTests: XCTestCase {
    func testRepeatedFieldsDefaultsUnicodeAndLiteralReplacement() {
        let template = PromptTemplate("🧭 ${city} / ${city} / ${level:beginner} / {{主题}} / {subject} / [COMPANY NAME + WEBSITE]")
        XCTAssertEqual(template.fields.map(\.label), ["city", "level", "主题", "subject", "COMPANY NAME + WEBSITE"])
        XCTAssertEqual(template.fields[1].defaultValue, "beginner")
        let result = template.filling(["${city}": "京都\n🌿", "${level:beginner}": "进阶", "{{主题}}": "{subject}", "{subject}": "猫", "[COMPANY NAME + WEBSITE]": "Acme + https://example.com/?a=1&b=2"])
        XCTAssertEqual(result, "🧭 京都\n🌿 / 京都\n🌿 / 进阶 / {subject} / 猫 / Acme + https://example.com/?a=1&b=2")
    }
    func testBlankValuesPreserveExactOriginalTokensAndSpacing() {
        let template = PromptTemplate("  关于[主题]\n${city}\n{subject}  ")
        XCTAssertEqual(template.filling(["[主题]": "\n ", "${city}": "", "{subject}": "  cats  "]), "  关于[主题]\n${city}\n  cats    ")
        XCTAssertEqual(template.filling([:]), template.source)
    }
    func testCodeMarkdownLinksEscapesAndStructuredDocumentsStayUntouched() {
        let source = #"""
        `[INLINE]` [LINK](https://example.com) ![IMAGE] [REF][target]
        [REF]: https://example.com
        \[ESCAPED] \${escaped} \{escaped}
        ```js
        const x = `${code}`;
        [CODE]
        ```
        ~~~
        {{fenced}}
        ~~~
        Describe [TOPIC] ${city}
        """#
        XCTAssertEqual(PromptTemplate(source).fields.map(\.id), ["[TOPIC]", "${city}"])
        for text in [#"{"theme":"{color}"}"#, #"["{color}"]"#, "<!DOCTYPE html><div>{value}</div>", "<html>{value}</html>"] {
            XCTAssertTrue(PromptTemplate(text).fields.isEmpty)
        }
        XCTAssertTrue(PromptTemplate("${name}", enabled: false).fields.isEmpty)
        XCTAssertTrue(PromptTemplate("```\n${unclosed}").fields.isEmpty)
    }
    func testRejectsExpressionsArraysAndUnboundedForms() {
        XCTAssertEqual(PromptTemplate("${a.b} { let value = 1; } [1, 2] [normal words] [主题]").fields.map(\.label), ["主题"])
        XCTAssertTrue(PromptTemplate((0..<33).map { "${field\($0)}" }.joined(separator: " ")).fields.isEmpty)
        XCTAssertTrue(PromptTemplate(String(repeating: "a", count: 50_001) + "${city}").fields.isEmpty)
    }
    func testBracketHeadingsAndProseBracesAreNotInputFields() {
        let template = PromptTemplate("[风格]\nA description\n### [结构规范]\nUse {like this}. Draw [主题] in [色彩].")
        XCTAssertEqual(template.fields.map(\.id), ["[主题]", "[色彩]"])
        XCTAssertTrue(template.fields.allSatisfy { $0.context.contains("Draw") })
    }
    func testSectionReferencesAndTranslatedOptionNamesRemainLiteral() {
        let source = "[风格] Cinematic。 [时长] 15 秒。 [场景] A lake.\n[事件要求]\nFollow [事件要求]. CHARCOAL（炭黑 [默认]），GRAY（烟灰 [面纱]）。\nCreate a scene with [主题]."
        let template = PromptTemplate(source)
        XCTAssertEqual(template.fields.map(\.id), ["[主题]"])
        XCTAssertEqual(template.filling(["[风格]": "Wrong", "[事件要求]": "Wrong"]), source)
    }
    @MainActor func testPreparedDraftPersistsOnlyInSelectedLanguage() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let library = Library(directory: directory)
        let item = try XCTUnwrap(library.prompts.first)
        let original = library.draft(for: item)
        let prepared = PromptTemplate("Write about ${topic}.").filling(["${topic}": "海边书店 🌿"])
        XCTAssertTrue(library.saveDraft(prepared, for: item, language: "zh-Hans"))
        let reloaded = Library(directory: directory)
        XCTAssertEqual(reloaded.draft(for: item, language: "zh-Hans"), prepared)
        XCTAssertEqual(reloaded.draft(for: item), original)
    }
}
