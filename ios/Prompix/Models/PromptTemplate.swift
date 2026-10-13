import Foundation

/// Conservative, local-only detection. Unrecognized syntax remains editable as ordinary text.
struct PromptTemplate {
    struct Field: Identifiable, Equatable {
        let id: String
        let label: String
        let defaultValue: String
        let context: String
    }
    private struct Occurrence {
        let range: NSRange
        let id: String
    }
    let source: String
    let fields: [Field]
    private let occurrences: [Occurrence]

    init(_ source: String, enabled: Bool = true) {
        self.source = source
        guard enabled, source.utf16.count <= 50_000 else { fields = []; occurrences = []; return }
        let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
        if let data = source.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data), json is [String: Any] || json is [Any] {
            fields = []; occurrences = []; return
        }
        guard !trimmed.lowercased().hasPrefix("<!doctype"), !trimmed.lowercased().hasPrefix("<html") else {
            fields = []; occurrences = []; return
        }
        let fullRange = NSRange(source.startIndex..., in: source)
        let protected = try! NSRegularExpression(pattern: #"```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|(?m)^---\r?\n[\s\S]*?\r?\n---"#)
        let protectedRanges = protected.matches(in: source, range: fullRange).map(\.range)
        let pattern = #"\$\{([\p{L}_][\p{L}\p{N}_ -]{0,63})(?::([^{}\n]{0,80}))?\}|\{\{([\p{L}_][\p{L}\p{N}_ -]{0,63})\}\}|(?<![{$])\{([\p{L}_][\p{L}\p{N}_-]{0,63})\}(?!\})|\[([A-Z][A-Z0-9 _+/-]{0,63}|[\p{script=Han}]{1,24})\](?!\s*(?:\(|\[|:))"#
        let matcher = try! NSRegularExpression(pattern: pattern)
        let text = source as NSString
        // Section labels can also be referenced later in prose; exclude all occurrences.
        let headingMatcher = try! NSRegularExpression(pattern: #"(?m)^\s*(?:#{1,6}\s*)?(\[[^\]\n]+\])(?:[ \t]+|$)"#)
        let headingTokens = Set(headingMatcher.matches(in: source, range: fullRange).map { text.substring(with: $0.range(at: 1)) })
        var found: [Field] = [], positions: [Occurrence] = []
        for match in matcher.matches(in: source, range: fullRange) {
            guard !protectedRanges.contains(where: { NSIntersectionRange($0, match.range).length > 0 }) else { continue }
            var preceding = match.range.location, slashes = 0
            while preceding > 0 && text.character(at: preceding - 1) == 92 { slashes += 1; preceding -= 1 }
            guard slashes.isMultiple(of: 2), match.range.location == 0 || text.character(at: match.range.location - 1) != 33 else { continue }
            let token = text.substring(with: match.range)
            let lineRange = text.lineRange(for: match.range)
            let line = text.substring(with: lineRange).trimmingCharacters(in: .whitespacesAndNewlines)
            if token.hasPrefix("[") {
                let prefix = text.substring(with: NSRange(location: lineRange.location, length: match.range.location - lineRange.location)).trimmingCharacters(in: .whitespaces)
                let suffix = text.substring(with: NSRange(location: NSMaxRange(match.range), length: NSMaxRange(lineRange) - NSMaxRange(match.range))).trimmingCharacters(in: .whitespacesAndNewlines)
                // Bracketed headings, sentence-leading labels and parenthetical option names are not inputs.
                if headingTokens.contains(token) || prefix.isEmpty || prefix.allSatisfy({ $0 == "#" }) { continue }
                if let previous = prefix.last, "。.!！？?".contains(previous) { continue }
                if let next = suffix.first, ")）".contains(next) { continue }
            }
            let labelRange = [1, 3, 4, 5].map { match.range(at: $0) }.first { $0.location != NSNotFound }!
            let label = text.substring(with: labelRange).trimmingCharacters(in: .whitespaces)
            let defaultRange = match.range(at: 2)
            if !found.contains(where: { $0.id == token }) {
                found.append(Field(id: token, label: label, defaultValue: defaultRange.location == NSNotFound ? "" : text.substring(with: defaultRange), context: String(line.prefix(180))))
            }
            positions.append(Occurrence(range: match.range, id: token))
        }
        // Avoid a huge generated form; the full native editor remains available.
        if found.count > 32 { fields = []; occurrences = [] }
        else { fields = found; occurrences = positions }
    }

    func filling(_ values: [String: String]) -> String {
        let result = NSMutableString(string: source)
        // Use original ranges once. User-entered placeholders are literal input, never recursively expanded.
        for occurrence in occurrences.reversed() {
            guard let value = values[occurrence.id], !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            result.replaceCharacters(in: occurrence.range, with: value)
        }
        return result as String
    }
}
