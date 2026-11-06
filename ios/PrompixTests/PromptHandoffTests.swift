import XCTest
@testable import Prompix

final class SkillInstallTests: XCTestCase {
    private func item(kind: PromptKind = .text, url: String? = "https://chatgpt.com/", revision: String? = nil, model: String = "ChatGPT") -> Prompt {
        .init(id: "test", kind: kind, title: "Test", summary: "Original test", prompt: "Write an original story.", example: "Choose a subject.", tags: ["Test"], model: model, toolURL: url.flatMap(URL.init(string:)), artwork: "text-editorial", previewLabel: "Test", source: .init(name: "Test", url: nil, license: "CC0-1.0", method: "Original", revision: revision), media: nil)
    }
    func testSkillCommandPinsCompleteReviewedDirectoryAndNeverAutoConfirms() {
        let revision = String(repeating: "a", count: 40)
        var prompt = item(revision: revision)
        prompt.contentType = "skill"
        prompt.skill = .init(name: "sample", description: "Original fixture", format: "agent-skills", entrypoint: "SKILL.md", repository: URL(string: "https://github.com/openai/skills")!, directory: "skills/.curated/sample", installURL: URL(string: "https://github.com/openai/skills/tree/\(revision)/skills/.curated/sample")!)
        let command = SkillInstall.command(for: prompt)
        XCTAssertNotNil(command)
        XCTAssertTrue(command!.contains(revision))
        XCTAssertTrue(command!.contains("--skill 'sample'"))
        XCTAssertFalse(command!.contains(" -y"))
        var unpinned = item(revision: "main")
        unpinned.contentType = "skill"; unpinned.skill = prompt.skill
        XCTAssertNil(SkillInstall.command(for: unpinned))
    }
    func testPublisherSkillsCopyTheirExactReviewedPackage() {
        let revision = String(repeating: "c", count: 40)
        for (repository, directory, name) in [
            ("https://github.com/expo/skills", "plugins/expo/skills/expo-native-ui", "expo-native-ui"),
            ("https://github.com/supabase/agent-skills", "skills/supabase-postgres-best-practices", "supabase-postgres-best-practices"),
            ("https://github.com/coreyhaines31/marketingskills", "skills/copywriting", "copywriting")
        ] {
            var prompt = item(revision: revision)
            prompt.contentType = "skill"
            let url = "\(repository)/tree/\(revision)/\(directory)"
            prompt.skill = .init(name: name, description: "Original test metadata", format: "agent-skills", entrypoint: "SKILL.md", repository: URL(string: repository)!, directory: directory, installURL: URL(string: url)!)
            XCTAssertEqual(SkillInstall.command(for: prompt), "DISABLE_TELEMETRY=1 npx skills add '\(url)' --skill '\(name)'")
            prompt.skill = .init(name: name, description: "Original test metadata", format: "agent-skills", entrypoint: "SKILL.md", repository: URL(string: repository)!, directory: directory, installURL: URL(string: "\(repository)/tree/main/\(directory)")!)
            XCTAssertNil(SkillInstall.command(for: prompt))
        }
    }

    func testUnverifiedSkillCannotGenerateExecutableInstallText() {
        var prompt = item(revision: String(repeating: "b", count: 40))
        prompt.contentType = "skill"
        prompt.skill = .init(name: "sample'; echo injected", description: "Fixture", format: "agent-skills", entrypoint: "SKILL.md", repository: URL(string: "https://github.com/openai/skills")!, directory: "skills/../other", installURL: URL(string: "https://example.com/skill")!)
        XCTAssertNil(SkillInstall.command(for: prompt))
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
    }

}
