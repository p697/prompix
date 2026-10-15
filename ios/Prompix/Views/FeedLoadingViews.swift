import SwiftUI

/// Static, noninteractive placeholders follow the content's layout. They do not
/// invent items or counts, animate indefinitely, or replace already visible work.
struct FeedLoadingGrid: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            FeedLoadingTile(ratio: 0.85)
            if !typeSize.isAccessibilitySize && !voiceOverEnabled { FeedLoadingTile(ratio: 1.15) }
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
        VStack(alignment: .leading, spacing: 12) {
            RoundedRectangle(cornerRadius: 4)
                .fill(Palette.soft.gradient).aspectRatio(ratio, contentMode: .fit)
            Capsule().fill(Palette.line.opacity(0.6)).frame(height: 8).padding(.trailing, 28)
            Capsule().fill(Palette.line.opacity(0.35)).frame(height: 8).padding(.trailing, 72)
        }.accessibilityHidden(true)
    }
}

struct CreatorLoadingRows: View {
    var count = 4
    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<count, id: \.self) { index in
                HStack(spacing: 14) {
                    Circle().fill(Palette.soft.gradient).frame(width: 50, height: 50)
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
