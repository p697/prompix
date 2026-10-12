import XCTest
@testable import Prompix

final class PromptHandoffTests: XCTestCase {
    private func item(kind: PromptKind = .text, url: String? = "https://chatgpt.com/", revision: String? = nil, model: String = "ChatGPT") -> Prompt {
        .init(id: "test", kind: kind, title: "Test", summary: "Original test", prompt: "Write an original story.", example: "Choose a subject.", tags: ["Test"], model: model, toolURL: url.flatMap(URL.init(string:)), artwork: "text-editorial", previewLabel: "Test", source: .init(name: "Test", url: nil, license: "CC0-1.0", method: "Original", revision: revision), media: nil)
    }
    func testToolChoicesPreserveRecommendedURLAndDoNotDuplicateItsHost() {
        let prompt = item(url: "https://chatgpt.com/?model=example")
        let choices = PromptDestination.choices(for: prompt)
        XCTAssertEqual(choices.count, 3)
        XCTAssertEqual(choices.first?.id, "chatgpt")
        XCTAssertEqual(choices.first?.name, "ChatGPT")
        XCTAssertEqual(choices.first?.url, prompt.toolURL)
        XCTAssertEqual(Set(choices.map(\.url.host)).count, 3)
        XCTAssertTrue(choices.allSatisfy { !($0.url.query ?? "").contains("Write") })
    }
    func testVideoDoesNotInventAnUnsupportedChatToolAndUnsafeLinksAreOmitted() {
        XCTAssertTrue(PromptDestination.choices(for: item(kind: .video, url: nil)).isEmpty)
        for url in ["javascript:alert(1)", "https://name:password@example.com/", "https://example.com:8443/"] {
            XCTAssertTrue(PromptDestination.choices(for: item(kind: .video, url: url)).isEmpty)
        }
        XCTAssertEqual(PromptDestination.choices(for: item(kind: .video, url: "https://example.com/video")).count, 1)
    }
    func testDesktopVideoWorkflowOffersCopyInsteadOfAnUnusableMobileDestination() {
        let prompt = item(kind: .video, url: "https://www.remotion.dev/", model: "Remotion")
        XCTAssertTrue(PromptDestination.requiresDesktop(for: prompt))
        XCTAssertTrue(PromptDestination.choices(for: prompt).isEmpty)
        let mobile = item(kind: .video, model: "Seedance 2.5")
        XCTAssertFalse(PromptDestination.requiresDesktop(for: mobile))
        XCTAssertFalse(PromptDestination.choices(for: mobile).isEmpty)
    }

    func testSkillCommandPinsCompleteReviewedDirectoryAndNeverAutoConfirms() {
        let revision = String(repeating: "a", count: 40)
        var prompt = item(revision: revision)
        prompt.contentType = "skill"
        prompt.skill = .init(name: "sample", description: "Original fixture", format: "agent-skills", entrypoint: "SKILL.md", repository: URL(string: "https://github.com/openai/skills")!, directory: "skills/.curated/sample", installURL: URL(string: "https://github.com/openai/skills/tree/\(revision)/skills/.curated/sample")!)
        let command = PromptDestination.installationCommand(for: prompt)
        XCTAssertNotNil(command)
        XCTAssertTrue(command!.contains(revision))
        XCTAssertTrue(command!.contains("--skill 'sample'"))
        XCTAssertFalse(command!.contains(" -y"))
        XCTAssertTrue(PromptDestination.choices(for: prompt).isEmpty)
        var unpinned = item(revision: "main")
        unpinned.contentType = "skill"; unpinned.skill = prompt.skill
        XCTAssertNil(PromptDestination.installationCommand(for: unpinned))
    }
    func testUnverifiedSkillCannotGenerateExecutableInstallText() {
        var prompt = item(revision: String(repeating: "b", count: 40))
        prompt.contentType = "skill"
        prompt.skill = .init(name: "sample'; echo injected", description: "Fixture", format: "agent-skills", entrypoint: "SKILL.md", repository: URL(string: "https://github.com/openai/skills")!, directory: "skills/../other", installURL: URL(string: "https://example.com/skill")!)
        XCTAssertNil(PromptDestination.installationCommand(for: prompt))
    }
    func testModelSpecificVideoEntryAndOriginalPostSurviveCatalogDecoding() throws {
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(item(kind: .video, url: nil))) as? [String: Any])
        json["model"] = "Seedance 2.5"
        var source = try XCTUnwrap(json["source"] as? [String: Any])
        source["post"] = ["id": "123", "authorID": "456", "text": "Original source text", "createdAt": "2026-10-12T00:00:00.000Z", "checkedAt": "2026-10-12T01:00:00Z"]
        json["source"] = source
        let prompt = try JSONDecoder().decode(Prompt.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(prompt.source.post?.text, "Original source text")
        XCTAssertNotNil(prompt.source.post?.date)
        XCTAssertEqual(PromptDestination.choices(for: prompt).first?.id, "dreamina")
        XCTAssertEqual(PromptDestination.choices(for: prompt).first?.url.host, "dreamina.capcut.com")
    }

}
