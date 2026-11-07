import SwiftUI

/// Noninteractive placeholders retain the content layout and known work.
/// The sheet fills the screen in the grid's own columns, gaps and corners, with
/// the shapes the library holds most: portrait, square, 4:5 and tall video.
struct FeedLoadingGrid: View {
    var count = 12
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    @State private var width: CGFloat = 0
    private static let ratios: [CGFloat] = [0.75, 1, 0.667, 0.8, 0.5625, 0.8, 1, 0.75, 0.667, 0.8, 0.75, 1]
    var body: some View {
        let single = typeSize.isAccessibilitySize || voiceOverEnabled
        let columns = single ? 1 : PromptGridLayout(width: width).columns
        HStack(alignment: .top, spacing: PromptGridLayout.gap) {
            ForEach(Array(Self.placement(count: single ? min(count, 3) : count, columns: columns).enumerated()), id: \.offset) { _, column in
                VStack(spacing: PromptGridLayout.gap) {
                    ForEach(column, id: \.self) { FeedLoadingTile(ratio: Self.ratios[$0 % Self.ratios.count]) }
                }
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(String(localized: "正在加载内容…"))
        .accessibilityIdentifier("feedLoading")
        .allowsHitTesting(false)
    }
    /// The same shortest-column placement as the real grid, on equal widths.
    private static func placement(count: Int, columns: Int) -> [[Int]] {
        PromptMasonry.columns(itemCount: count, widths: Array(repeating: 1, count: max(1, columns)), spacing: 0) { index, _ in
            1 / ratios[index % ratios.count]
        }
    }
}

struct FeedLoadingTile: View {
    var ratio: CGFloat = 1
    var body: some View {
        LoadingSurface().aspectRatio(ratio, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: PromptCardGeometry.cornerRadius, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// A bar where one line of text will be: the line keeps its real height, so
/// the words take the bar's place without moving anything.
struct LoadingLine: View {
    let font: Font
    let width: CGFloat
    var height: CGFloat = 9
    var alignment: Alignment = .leading
    var body: some View {
        Text(verbatim: "Ag").font(font).hidden()
            .frame(maxWidth: alignment == .leading ? nil : .infinity, alignment: alignment)
            .overlay(alignment: alignment) {
                LoadingSurface().frame(width: width, height: height).clipShape(Capsule())
            }
            .accessibilityHidden(true)
    }
}

/// Fills the screen with rows in `CreatorRow`'s geometry, work preview and separators.
struct CreatorLoadingRows: View {
    var count = 8
    private static let widths: [CGFloat] = [148, 116, 132, 104, 140, 96, 124, 110]
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(0..<count, id: \.self) { index in
                HStack(spacing: 14) {
                    LoadingSurface().frame(width: 50, height: 50).clipShape(Circle())
                    VStack(alignment: .leading, spacing: 5) {
                        LoadingLine(font: .body, width: Self.widths[index % Self.widths.count], height: 11)
                        LoadingLine(font: .footnote, width: 88, height: 8)
                        LoadingLine(font: .footnote, width: 56, height: 8)
                    }
                    Spacer(minLength: 0)
                    LoadingSurface().frame(width: 82, height: 70).clipShape(RoundedRectangle(cornerRadius: 10))
                }.frame(minHeight: 64).padding(.vertical, 14)
                if index < count - 1 { Rectangle().fill(Palette.line).frame(height: 0.5).padding(.leading, 64) }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(String(localized: "正在加载内容…"))
        .accessibilityIdentifier("creatorLoading")
        .allowsHitTesting(false)
    }
}
