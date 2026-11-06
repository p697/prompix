import Foundation

/// The verified `npx skills add` command for a Skill from a known public
/// repository at a pinned revision; nil for anything that cannot be checked.
enum SkillInstall {
    static func command(for item: Prompt) -> String? {
        guard let skill = item.skill, item.isSkill,
              let revision = item.source.revision, revision.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil,
              ["https://github.com/anthropics/skills", "https://github.com/openai/skills",
               "https://github.com/expo/skills", "https://github.com/supabase/agent-skills",
               "https://github.com/coreyhaines31/marketingskills"].contains(skill.repository.absoluteString),
              skill.name.range(of: "^[a-z0-9][a-z0-9-]{0,63}$", options: .regularExpression) != nil,
              skill.directory.range(of: "^[a-zA-Z0-9._/-]+$", options: .regularExpression) != nil,
              !skill.directory.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { return nil }
        let publicRoots = ["https://github.com/anthropics/skills": "skills", "https://github.com/openai/skills": "skills/.curated",
                           "https://github.com/expo/skills": "plugins/expo/skills", "https://github.com/supabase/agent-skills": "skills",
                           "https://github.com/coreyhaines31/marketingskills": "skills"]
        guard let root = publicRoots[skill.repository.absoluteString], skill.directory.hasPrefix(root + "/"),
              !skill.directory.dropFirst(root.count + 1).contains("/") else { return nil }
        let expected = "\(skill.repository.absoluteString)/tree/\(revision)/\(skill.directory)"
        guard skill.installURL.absoluteString == expected else { return nil }
        return "DISABLE_TELEMETRY=1 npx skills add '\(expected)' --skill '\(skill.name)'"
    }
}
