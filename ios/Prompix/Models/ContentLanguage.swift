import Foundation

enum ContentLanguage {
    static let supported = ["en", "zh-Hans", "zh-Hant", "ja", "ko", "es", "pt-BR", "fr", "de"]
    static var preferred: String { canonical(Bundle.main.preferredLocalizations.first ?? "en") }

    static func canonical(_ identifier: String) -> String {
        matching(identifier) ?? "en"
    }
    static func matching(_ identifier: String) -> String? {
        let code = identifier.replacingOccurrences(of: "_", with: "-").lowercased()
        let components = code.split(separator: "-").map(String.init)
        guard let language = components.first else { return nil }
        if language == "zh" {
            if components.contains("hans") { return "zh-Hans" }
            if components.contains("hant") { return "zh-Hant" }
            return components.contains(where: { ["tw", "hk", "mo"].contains($0) }) ? "zh-Hant" : "zh-Hans"
        }
        if language == "pt" { return "pt-BR" }
        return supported.contains(language) ? language : nil
    }

    static func name(_ code: String) -> String {
        switch code {
        case "zh-Hans": "简体中文"
        case "zh-Hant": "繁體中文"
        case "ja": "日本語"
        case "ko": "한국어"
        case "es": "Español"
        case "pt-BR": "Português (Brasil)"
        case "fr": "Français"
        case "de": "Deutsch"
        default: "English"
        }
    }
}

extension Prompt {
    /// A missing translation falls back to the intact source, never an unrelated locale.
    func content(in language: String?) -> TranslatedContent {
        if let language, let resolved = ContentLanguage.matching(language), let content = localization?.translations[resolved] { return content }
        return TranslatedContent(title: title, summary: summary, prompt: prompt, example: example, previewLabel: previewLabel,
                                 cover: cover.map { TranslatedCover(text: $0.text, eyebrow: $0.eyebrow) })
    }
    var displayContent: TranslatedContent { content(in: ContentLanguage.preferred) }
    var displayTitle: String { displayContent.title }
    var displaySummary: String { displayContent.summary }
    var availableLanguages: [String] { ContentLanguage.supported.filter { localization?.translations[$0] != nil } }
    var preferredTranslation: String? { availableLanguages.contains(ContentLanguage.preferred) ? ContentLanguage.preferred : nil }
}
