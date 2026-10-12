import Foundation

struct PromptDestination: Identifiable, Equatable {
    let id: String
    let name: String
    let url: URL

    static func choices(for item: Prompt) -> [Self] {
        guard !item.isSkill else { return [] }
        var choices: [Self] = []
        if let url = item.toolURL ?? modelDestination(for: item), isSafeURL(url) {
            let known: [String: (String, String)] = [
                "chatgpt.com": ("chatgpt", "ChatGPT"), "claude.ai": ("claude", "Claude"),
                "gemini.google.com": ("gemini", "Gemini"), "grok.com": ("grok", "Grok"),
                "dreamina.capcut.com": ("dreamina", "Dreamina"), "labs.google": ("flow", "Google Flow"),
                "app.runwayml.com": ("runway", "Runway"),
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
    // Official entry points, not private deep links or a promise of automatic submission.
    private static func modelDestination(for item: Prompt) -> URL? {
        let model = item.model.lowercased()
        let address: String?
        switch item.kind {
        case .image:
            if model.contains("nano banana") { address = "https://gemini.google.com/app" }
            else if model.contains("gpt image") { address = "https://chatgpt.com/" }
            else if model.contains("midjourney") { address = "https://www.midjourney.com/" }
            else { address = nil }
        case .video:
            if model.contains("seedance") { address = "https://dreamina.capcut.com/" }
            else if model.range(of: "\\bveo\\b", options: .regularExpression) != nil { address = "https://labs.google/fx/tools/flow" }
            else if model.contains("runway") { address = "https://app.runwayml.com/" }
            else { address = nil }
        case .text, .web: address = nil
        }
        return address.flatMap(URL.init(string:))
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
