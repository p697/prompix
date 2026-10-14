import SwiftUI

/// A real card preview, never a partial Prompt that could be copied or saved.
struct PendingPromptDetail: View {
    let card: FeedCard
    let failure: (any Error)?
    let retryAt: Date?
    let position: DetailReadingPosition
    let retry: () -> Void
    private var preview: ContentPreview { ContentPreview(card) }

    var body: some View {
        Group {
            if #available(iOS 27.1, *), preview.hasDetailMedia {
                ArrangementView {
                    ScrollView { reading.padding(.bottom, 28).frame(maxWidth: 700).frame(maxWidth: .infinity) }
                        .preservingReadingPosition(position).accessibilityIdentifier("detailReadingPane")
                } secondary: {
                    ScrollView { media.padding(.bottom, 24).frame(maxWidth: 600).frame(maxWidth: .infinity) }
                        .preservingReadingPosition(position, media: true).accessibilityIdentifier("detailMediaPane")
                }.arrangementViewStyle(.split.axes(.horizontal))
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 25) {
                        media
                        reading
                    }.padding(.bottom, 28).frame(maxWidth: 700).frame(maxWidth: .infinity)
                }.preservingReadingPosition(position).accessibilityIdentifier("detailReadingPane")
            }
        }.foregroundStyle(Palette.ink)
    }
    @ViewBuilder private var media: some View {
        if preview.hasDetailMedia {
            PromptDetailArtwork(preview: preview).padding(.horizontal, 12).padding(.top, 8).accessibilityIdentifier("detailPreviewArtwork")
        }
    }
    private var reading: some View {
        VStack(alignment: .leading, spacing: 24) {
            PromptDetailHeading(title: card.title, summary: card.summary, creator: card.creator)
            if #available(iOS 27.1, *), preview.hasDetailMedia {
                HStack(spacing: 14) {
                    Artwork(preview: preview).frame(width: 76, height: 86).clipped()
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    RoundedRectangle(cornerRadius: 4).fill(Palette.soft).frame(width: 100, height: 16)
                    Spacer(minLength: 0)
                }.padding(10).background(Palette.surface, in: RoundedRectangle(cornerRadius: 14))
                    .accessibilityHidden(true)
            }
            if failure != nil {
                VStack(alignment: .leading, spacing: 12) {
                    Text(String(localized: "内容暂时无法加载")).font(.subheadline).foregroundStyle(Palette.muted)
                    FeedRetryButton(retryAt: retryAt, action: retry).accessibilityIdentifier("retryDetail")
                }.frame(maxWidth: .infinity, alignment: .leading).accessibilityElement(children: .contain).accessibilityIdentifier("feedDetailFailure")
            } else {
                PromptBodySkeleton()
            }
        }.padding(.horizontal, 22).padding(.top, 12)
    }
}

struct PromptDetailHeading: View {
    let title: String
    let summary: String
    let creator: Prompt.Creator?
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(Typography.editorial(.title)).lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("detailTitle")
            if !summary.isEmpty { Text(summary).font(.body).lineSpacing(4).foregroundStyle(Palette.muted) }
            if let creator { CreatorByline(creator: creator) }
        }
    }
}

struct PromptDetailArtwork: View {
    let preview: ContentPreview
    var body: some View {
        Artwork(preview: preview)
            .aspectRatio(preview.media?.aspectRatio.map { max(0.65, min(1.8, $0)) } ?? (preview.kind == .image ? 0.95 : 1.15), contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

extension ContentPreview {
    var hasDetailMedia: Bool {
        WebsiteExamples.files[id] != nil || kind == .video || media?.image != nil || media?.imageURL != nil
    }
}

private struct PromptBodySkeleton: View {
    @ScaledMetric(relativeTo: .body) private var lineHeight = 12.0
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Capsule().fill(Palette.soft).frame(width: 112, height: 16).frame(height: 44)
            ForEach(0..<2) { _ in
                VStack(alignment: .leading, spacing: 14) {
                    ForEach([1.0, 0.93, 0.98, 0.62], id: \.self) { fraction in
                        GeometryReader { geometry in
                            RoundedRectangle(cornerRadius: 3).fill(Palette.soft)
                                .frame(width: geometry.size.width * fraction)
                        }.frame(height: lineHeight)
                    }
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(String(localized: "正在加载内容…"))
            .accessibilityIdentifier("promptBodySkeleton")
    }
}

/// Preserve the reader's position when the card preview becomes a full detail.
/// This is scoped to one presentation and does not retain browsing history.
final class DetailReadingPosition {
    var reading: CGFloat = 0
    var media: CGFloat = 0
}

extension View {
    @ViewBuilder func preservingReadingPosition(_ position: DetailReadingPosition?, media: Bool = false) -> some View {
        if #available(iOS 18, *), let position {
            modifier(RestoreReadingPosition(saved: position, media: media))
        } else { self }
    }
}

@available(iOS 18, *) private struct RestoreReadingPosition: ViewModifier {
    let saved: DetailReadingPosition
    let media: Bool
    @State private var position: ScrollPosition
    init(saved: DetailReadingPosition, media: Bool) {
        self.saved = saved; self.media = media
        _position = State(initialValue: ScrollPosition(y: media ? saved.media : saved.reading))
    }
    func body(content: Content) -> some View {
        content.scrollPosition($position)
            .onScrollGeometryChange(for: CGFloat.self) { max(0, $0.contentOffset.y + $0.contentInsets.top) } action: { _, value in
                if media { saved.media = value } else { saved.reading = value }
            }
    }
}
