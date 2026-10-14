import Foundation

/// Shared visual projection for full offline records and lightweight feed cards.
/// It contains no copy/save payload and cannot be mistaken for a complete Prompt.
struct ContentPreview: Identifiable {
    let id: String
    let kind: PromptKind
    let isSkill: Bool
    let artwork: String
    let displayTitle: String
    let displaySummary: String
    let excerpt: String
    let creator: Prompt.Creator?
    let attribution: String
    let media: Prompt.Media?
    let cover: Prompt.Cover?
    var displayKind: String { isSkill ? "Skill" : kind.title }
    var displaySymbol: String { isSkill ? "square.stack.3d.up" : kind.symbol }

    init(_ item: Prompt) {
        id = item.id; kind = item.kind; isSkill = item.isSkill; artwork = item.artwork
        displayTitle = item.displayTitle; displaySummary = item.displaySummary
        excerpt = String((item.isSkill ? item.displaySummary : item.displayContent.prompt).prefix(800))
        creator = item.creator; attribution = item.source.author ?? item.source.name; media = item.media
        cover = item.cover.map { value in
            Prompt.Cover(text: item.displayContent.cover?.text ?? value.text,
                         eyebrow: item.displayContent.cover?.eyebrow ?? value.eyebrow, tone: value.tone)
        }
    }
    init(_ card: FeedCard) {
        id = card.id; kind = card.kind; isSkill = card.contentType == "skill"; artwork = card.artwork
        displayTitle = card.title; displaySummary = card.summary; excerpt = String(card.summary.prefix(800))
        creator = card.creator; attribution = card.creator?.displayName ?? card.model; media = card.media; cover = card.cover
    }
}
