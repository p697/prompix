import SwiftUI

/// Noninteractive placeholders retain the content layout and known work.
/// A single light pass settles into a quiet surface; it never indicates progress.
struct FeedLoadingGrid: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 14) {
                FeedLoadingTile(ratio: 0.85)
                if !typeSize.isAccessibilitySize && !voiceOverEnabled { FeedLoadingTile(ratio: 1.15) }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(String(localized: "正在加载内容…"))
        .accessibilityIdentifier("feedLoading")
        .allowsHitTesting(false)
    }
}

struct FeedLoadingTile: View {
    var ratio: CGFloat = 1
    var body: some View {
        VStack(alignment: .leading, spacing: PromptCardGeometry.titleSpacing) {
            LoadingSurface().aspectRatio(ratio, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 4))
            Text("Content title").font(.footnote).lineLimit(2, reservesSpace: true)
                .redacted(reason: .placeholder).padding(.horizontal, 2)
        }.accessibilityHidden(true)
    }
}

struct CreatorLoadingRows: View {
    var count = 4
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ContentActivityLabel().padding(.vertical, 6)
            ForEach(0..<count, id: \.self) { index in
                HStack(spacing: 14) {
                    LoadingSurface().frame(width: 50, height: 50).clipShape(Circle())
                    VStack(alignment: .leading, spacing: 12) {
                        Capsule().fill(Palette.line.opacity(0.6)).frame(width: index.isMultiple(of: 2) ? 148 : 116, height: 10)
                        Capsule().fill(Palette.line.opacity(0.35)).frame(width: 88, height: 8)
                    }
                    Spacer(minLength: 0)
                }.frame(minHeight: 64).padding(.vertical, 14)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(String(localized: "正在加载内容…"))
        .accessibilityIdentifier("creatorLoading")
        .allowsHitTesting(false)
    }
}
