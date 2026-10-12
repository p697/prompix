import Foundation

struct PromptDestination: Identifiable, Equatable {
    let id: String
    let name: String
    let url: URL

    static func choices(for item: Prompt) -> [Self] {
        guard !item.isSkill else { return [] }
        var choices: [Self] = []
        if let url = item.toolURL, isSafeURL(url) {
            let known: [String: (String, String)] = [
                "chatgpt.com": ("chatgpt", "ChatGPT"), "claude.ai": ("claude", "Claude"),
                "gemini.google.com": ("gemini", "Gemini"), "grok.com": ("grok", "Grok"),
                "www.midjourney.com": ("midjourney", "Midjourney"), "v0.app": ("v0", "v0"),
                "v0.dev": ("v0", "v0"), "lovable.dev": ("lovable", "Lovable"),
            ]
            let identity = known[url.host ?? ""]
            choices.append(.init(id: identity?.0 ?? "source:\(url.host ?? "")", name: identity?.1 ?? item.displayModel, url: url))
        }
        // Alternatives reflect supported tasks, not a promise of identical model output.
        let common: [(String, String, String)]
        switch item.kind {
        case .text, .web:
            common = [("chatgpt", "ChatGPT", "https://chatgpt.com/"), ("claude", "Claude", "https://claude.ai/new"), ("gemini", "Gemini", "https://gemini.google.com/app")]
        case .image:
            common = [("chatgpt", "ChatGPT", "https://chatgpt.com/"), ("gemini", "Gemini", "https://gemini.google.com/app")]
        case .video:
            common = []
        }
        for (id, name, address) in common {
            let url = URL(string: address)!
            if !choices.contains(where: { $0.url.host == url.host }) { choices.append(.init(id: id, name: name, url: url)) }
        }
        return choices
    }
    static func isSafeURL(_ url: URL) -> Bool {
        url.scheme == "https" && url.host != nil && url.user == nil && url.password == nil && url.port == nil
    }

    /// Instructions for an interactive desktop installation, never executed by Prompix.
    /// Pin the exact directory reviewed in the catalog; do not silently install HEAD.
    static func installationCommand(for item: Prompt) -> String? {
        guard let skill = item.skill, item.isSkill,
              let revision = item.source.revision, revision.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil,
              ["https://github.com/anthropics/skills", "https://github.com/openai/skills"].contains(skill.repository.absoluteString),
              skill.name.range(of: "^[a-z0-9][a-z0-9-]{0,63}$", options: .regularExpression) != nil,
              skill.directory.range(of: "^[a-zA-Z0-9._/-]+$", options: .regularExpression) != nil,
              !skill.directory.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { return nil }
        let expected = "\(skill.repository.absoluteString)/tree/\(revision)/\(skill.directory)"
        guard skill.installURL.absoluteString == expected else { return nil }
        return "DISABLE_TELEMETRY=1 npx skills add '\(expected)' --skill '\(skill.name)'"
    }
}
