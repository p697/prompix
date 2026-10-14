import Foundation

/// A local, presentation-only projection. Copying and editing must keep using the source string.
struct PromptMarkdownDocument {
    struct Block: Identifiable {
        enum Kind: Equatable { case paragraph, heading(Int), code(String?), separator }
        let id: Int
        let kind: Kind
        var text: AttributedString
        let marker: String?
        let listDepth: Int
        let quoteDepth: Int
    }

    let blocks: [Block]
    let usedPlainTextFallback: Bool
    let metadata: String?

    init(_ originalSource: String) {
        let frontmatter = Self.splitFrontmatter(originalSource)
        metadata = frontmatter.metadata
        let source = frontmatter.body
        // Bound parser work for unusually large imported Skills without truncating their text.
        guard source.utf8.count <= 250_000, !Self.hasDefinitionLikeFields(source),
              let parsed = try? AttributedString(markdown: source, options: .init(
                allowsExtendedAttributes: false,
                interpretedSyntax: .full,
                failurePolicy: .returnPartiallyParsedIfPossible
              )), !Self.hasTable(parsed) else {
            blocks = Self.plainBlocks(source)
            usedPlainTextFallback = true
            return
        }
        var result: [Block] = []
        var shownListItems: Set<Int> = []
        var currentIdentity: Int?
        for run in parsed.runs {
            let components = run.presentationIntent?.components ?? []
            // The first intent is the leaf; the rest describe its list/quote ancestry.
            let identity = components.first?.identity ?? -1
            var content = AttributedString(parsed[run.range])
            if run.inlinePresentationIntent?.contains(.softBreak) == true {
                // Prompt line breaks often separate instructions even without Markdown's two spaces.
                content = AttributedString("\n")
            }
            if let imageURL = run.imageURL {
                if String(content.characters) == "\u{FFFC}" { content = AttributedString(imageURL.absoluteString) }
                content.imageURL = nil
                content.link = nil
            } else if let link = run.link, !Self.isSafeLink(link) {
                content.link = nil
            }
            content.presentationIntent = nil
            if currentIdentity == identity, !result.isEmpty {
                result[result.count - 1].text.append(content)
                continue
            }
            currentIdentity = identity
            var kind: Block.Kind = .paragraph
            var ordinal: Int?
            var listItemID: Int?
            var ordered = false
            var listDepth = 0
            var quoteDepth = 0
            for component in components {
                switch component.kind {
                case .header(let level): kind = .heading(level)
                case .codeBlock(let language): kind = .code(language)
                case .thematicBreak: kind = .separator
                case .listItem(let number):
                    listDepth += 1
                    if listItemID == nil { listItemID = component.identity; ordinal = number }
                case .orderedList:
                    if listDepth == 1 { ordered = true }
                case .blockQuote: quoteDepth += 1
                default: break
                }
            }
            let marker: String?
            if let listItemID, shownListItems.insert(listItemID).inserted {
                marker = ordered ? "\(ordinal ?? 1)." : "•"
            } else { marker = nil }
            result.append(Block(id: result.count, kind: kind, text: content, marker: marker,
                                listDepth: listDepth, quoteDepth: quoteDepth))
        }
        blocks = result.isEmpty && !source.isEmpty ? Self.plainBlocks(source) : result
        usedPlainTextFallback = result.isEmpty && !source.isEmpty
    }

    private static func splitFrontmatter(_ source: String) -> (metadata: String?, body: String) {
        guard source.hasPrefix("---\n") || source.hasPrefix("---\r\n") else { return (nil, source) }
        let lines = source.components(separatedBy: "\n")
        guard let end = lines.indices.dropFirst().first(where: { lines[$0] == "---" || lines[$0] == "---\r" }),
              end > 1 else { return (nil, source) }
        let header = lines[1..<end].joined(separator: "\n")
        // A closing rule alone is not enough: ordinary introductory prose can
        // also sit between rules. Require a top-level YAML-style metadata key.
        guard header.range(of: #"(?m)^[\p{L}_][\p{L}\p{N}_ -]*:[ \t]*"#, options: .regularExpression) != nil else {
            return (nil, source)
        }
        return (header, lines[(end + 1)...].joined(separator: "\n"))
    }

    static func isSafeLink(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), ["https", "http"].contains(scheme),
              let host = url.host, !host.isEmpty else { return false }
        return true
    }

    private static func hasTable(_ text: AttributedString) -> Bool {
        text.runs.contains { run in
            run.presentationIntent?.components.contains { component in
                if case .table = component.kind { return true }
                return false
            } == true
        }
    }

    private static func hasDefinitionLikeFields(_ source: String) -> Bool {
        // A prompt field such as `[ROLE]: assistant` is also a legal Markdown
        // reference definition. Foundation removes it even when it is never used.
        // Only treat absolute web destinations as reference links; keep other
        // definition-like fields visible, including their exact brackets and values.
        var prose: [Substring] = []
        var fence: (character: Character, length: Int)?
        for line in source.split(separator: "\n", omittingEmptySubsequences: false) {
            let indentation = line.prefix { $0 == " " }.count
            let trimmed = line.dropFirst(indentation)
            if indentation <= 3, let character = trimmed.first, character == "`" || character == "~" {
                let length = trimmed.prefix { $0 == character }.count
                let remainder = trimmed.dropFirst(length)
                if let active = fence {
                    if character == active.character, length >= active.length,
                       remainder.allSatisfy(\.isWhitespace) { fence = nil }
                } else if length >= 3, character == "~" || !remainder.contains("`") {
                    fence = (character, length)
                }
                if length >= 3 { prose.append(""); continue }
            }
            // Indented and fenced examples are already rendered literally.
            prose.append(fence == nil && indentation < 4 && !line.hasPrefix("\t") ? line : "")
        }
        let text = prose.joined(separator: "\n")
        let pattern = #"(?m)^(?:[ ]{0,3}>[ \t]?)*[ ]{0,3}(?:(?:[-+*]|[0-9]+[.)])[ \t]+)?\[(?:\\.|[^\]\\\r\n])+\]:[ \t]*(?:\r?\n[ \t]*)?(<[^>\r\n]*>|[^ \t\r\n]+)"#
        let matcher = try! NSRegularExpression(pattern: pattern)
        return matcher.matches(in: text, range: NSRange(text.startIndex..., in: text)).contains { match in
            guard let range = Range(match.range(at: 1), in: text) else { return false }
            var destination = String(text[range])
            if destination.hasPrefix("<"), destination.hasSuffix(">") { destination = String(destination.dropFirst().dropLast()) }
            guard let url = URL(string: destination) else { return true }
            return !isSafeLink(url)
        }
    }

    private static func plainBlocks(_ source: String) -> [Block] {
        // Keep unsupported syntax literal, but do not ask Text to lay out an
        // entire long Skill before the presentation can start. Prefer line
        // boundaries; never trim whitespace or split a grapheme (including CRLF).
        var chunks: [String] = []
        var chunk = ""
        var count = 0
        for character in source {
            chunk.append(character)
            count += 1
            if (count >= 1_024 && character.isNewline) || count >= 2_048 {
                chunks.append(chunk)
                chunk = ""
                count = 0
            }
        }
        if !chunk.isEmpty { chunks.append(chunk) }
        return chunks.enumerated().map { index, text in
            Block(id: index, kind: .paragraph, text: AttributedString(text),
                  marker: nil, listDepth: 0, quoteDepth: 0)
        }
    }
}

#if canImport(UIKit)
import SwiftUI

/// Native, selectable reading typography. Never executes HTML or fetches embedded Markdown images.
struct PromptMarkdown: View {
    private let source: String

    init(_ source: String) { self.source = source }

    var body: some View { PromptMarkdownContent(source: source).equatable() }
}

// Chrome, copy confirmation and other parent state changes recreate the small
// wrapper above without reparsing unchanged source on the animation's main thread.
private struct PromptMarkdownContent: View, Equatable {
    let source: String
    @ScaledMetric(relativeTo: .body) private var lineSpacing = 5.0

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.source == rhs.source }

    var body: some View {
        let document = PromptMarkdownDocument(source)
        return LazyVStack(alignment: .leading, spacing: document.usedPlainTextFallback ? 0 : 18) {
            if let metadata = document.metadata {
                DisclosureGroup {
                    codeText(AttributedString(metadata)).padding(.top, 10)
                } label: {
                    Text(String(localized: "元数据")).font(.subheadline).foregroundStyle(Palette.muted)
                        .frame(minHeight: 44)
                }.accessibilityIdentifier("promptMetadata")
            }
            ForEach(document.blocks) { block in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    if block.listDepth > 0 {
                        Text(block.marker ?? " ")
                            .font(.body).foregroundStyle(Palette.muted)
                            .frame(minWidth: 18, alignment: .trailing)
                            .accessibilityHidden(block.marker == nil)
                    }
                    blockContent(block)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, block.quoteDepth > 0 ? 14 : 0)
                        .overlay(alignment: .leading) {
                            if block.quoteDepth > 0 {
                                RoundedRectangle(cornerRadius: 1).fill(Palette.line).frame(width: 2)
                            }
                        }
                }
                .padding(.leading, CGFloat(min(max(block.listDepth - 1, 0), 3)) * 14)
            }
        }
        .font(.body)
        .foregroundStyle(Palette.ink)
        .tint(Palette.accent)
        .textSelection(.enabled)
        .environment(\.openURL, OpenURLAction { url in
            PromptMarkdownDocument.isSafeLink(url) ? .systemAction : .discarded
        })
    }

    @ViewBuilder private func blockContent(_ block: PromptMarkdownDocument.Block) -> some View {
        switch block.kind {
        case .separator:
            Rectangle().fill(Palette.line).frame(height: 1).padding(.vertical, 4).accessibilityHidden(true)
        case .code:
            codeText(block.text)
        case .heading(let level):
            Text(styledInline(block.text))
                .font(level == 1 ? .title2.weight(.semibold) : level == 2 ? .title3.weight(.semibold) : .headline)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 6)
                .accessibilityAddTraits(.isHeader)
        case .paragraph:
            Text(styledInline(block.text))
                .lineSpacing(lineSpacing)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func codeText(_ text: AttributedString) -> some View {
        ScrollView(.horizontal) {
            Text(text)
                .font(.system(.callout, design: .monospaced))
                .lineSpacing(4)
                .fixedSize(horizontal: true, vertical: true)
                .padding(14)
        }
        .background(Palette.soft, in: RoundedRectangle(cornerRadius: 12))
    }

    private func styledInline(_ text: AttributedString) -> AttributedString {
        var result = text
        for run in text.runs {
            if run.inlinePresentationIntent?.contains(.code) == true {
                result[run.range].font = .system(.body, design: .monospaced)
                result[run.range].backgroundColor = Palette.soft
            }
        }
        return result
    }
}
#endif
