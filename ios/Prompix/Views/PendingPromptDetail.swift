import SwiftUI

/// A real card preview, never a partial Prompt that could be copied or saved.
struct PendingPromptDetail: View {
    let card: FeedCard
    let failure: (any Error)?
    let retryAt: Date?
    let position: DetailReadingPosition
    let retry: () -> Void
    @State private var actionsCollapsed = false
    @State private var mediaPaneVisible = false
    private var preview: ContentPreview { ContentPreview(card) }

    var body: some View {
        Group {
            if #available(iOS 27.1, *), preview.hasDetailMedia {
                ArrangementView {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            if !mediaPaneVisible { media }
                            reading
                        }.padding(.bottom, 28).frame(maxWidth: 700).frame(maxWidth: .infinity)
                    }.ignoresSafeArea(edges: mediaPaneVisible ? [] : .top).hidesTopEdgeEffect()
                        .preservingReadingPosition(position).readingChrome($actionsCollapsed).readingBottomEdge().accessibilityIdentifier("detailReadingPane")
                } secondary: {
                    ScrollView { media.padding(.bottom, 24).frame(maxWidth: 600).frame(maxWidth: .infinity) }.ignoresSafeArea(edges: .top)
                        .preservingReadingPosition(position, media: true).reportsPaneVisibility($mediaPaneVisible).accessibilityIdentifier("detailMediaPane")
                }.arrangementViewStyle(.split.axes(.horizontal))
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        media
                        reading
                    }.padding(.bottom, 28).frame(maxWidth: 700).frame(maxWidth: .infinity)
                }.ignoresSafeArea(edges: preview.hasDetailMedia ? .top : []).hidesTopEdgeEffect().preservingReadingPosition(position).readingChrome($actionsCollapsed).readingBottomEdge().accessibilityIdentifier("detailReadingPane")
            }
        }.foregroundStyle(Palette.ink)
            .overlay(alignment: .top) {
                if preview.hasDetailMedia { GrainDissolve(edge: .top).ignoresSafeArea(edges: .top).allowsHitTesting(false).accessibilityHidden(true) }
            }
            .onChange(of: actionsCollapsed) { _, value in position.actionsCollapsed = value }
            .promptActionBar {
                ReadingActionBar(ready: false, collapsed: actionsCollapsed)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {} label: { Label { Text(String(localized: "分享")) } icon: { PrompixIcon.share.image }.frame(minWidth: 44, minHeight: 44) }
                        .disabled(true).accessibilityIdentifier("sharePrompt")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {} label: { Label { Text(String(localized: "收藏 Prompt")) } icon: { PrompixIcon.saved.image }.frame(minWidth: 44, minHeight: 44) }
                        .disabled(true).accessibilityIdentifier("detailFavorite")
                }
            }
    }
    @ViewBuilder private var media: some View {
        if preview.hasDetailMedia {
            DetailHero(preview: preview, title: card.title).accessibilityIdentifier("detailPreviewArtwork")
        }
    }
    private var reading: some View {
        VStack(alignment: .leading, spacing: 24) {
            PromptDetailHeading(preview: ContentPreview(card), title: card.title)
            if #available(iOS 27.1, *), preview.hasDetailMedia, mediaPaneVisible {
                HStack(spacing: 14) {
                    Artwork(preview: preview).frame(width: 76, height: 86).clipped()
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    RoundedRectangle(cornerRadius: 4).fill(Palette.soft).frame(width: 100, height: 16)
                    Spacer(minLength: 0)
                }.padding(10).background(Palette.surface, in: RoundedRectangle(cornerRadius: 14))
                    .accessibilityHidden(true)
            }
            if failure != nil {
                ContentRecoveryRow(message: String(localized: "内容暂时无法加载"), retryAt: retryAt, retryID: "retryDetail", action: retry).frame(maxWidth: .infinity, alignment: .leading).accessibilityElement(children: .contain).accessibilityIdentifier("feedDetailFailure")
            } else {
                PromptBodySkeleton()
            }
        }.padding(.horizontal, 22).padding(.top, 12)
    }
}

/// The model leads, because it decides what the prompt will make; then the title.
struct PromptDetailHeading: View {
    let preview: ContentPreview
    let title: String
    var body: some View {
        let meta = preview.detailMeta
        VStack(alignment: .leading, spacing: 10) {
            if !meta.lead.isEmpty || !meta.rest.isEmpty {
                (Text(meta.lead).foregroundStyle(Palette.ink).fontWeight(.semibold) + Text(meta.rest).foregroundStyle(Palette.muted))
                    .font(Typography.meta(size: 11)).tracking(1.4)
                    .accessibilityIdentifier("detailMeta")
            }
            Text(title).font(.system(size: 24, weight: .semibold)).lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("detailTitle")
        }
    }
}

/// The work edge to edge, fading into the page. Tall work is shown up to 2:3,
/// cropped from the bottom so faces stay whole, and the title still starts on
/// the first screen; the full frame opens on tap. Several images page sideways
/// in place, with a counter, and every page is cropped the same way.
struct DetailHero: View {
    let preview: ContentPreview
    var title = ""
    var open: ((Int) -> Void)? = nil
    @State private var page = 0
    private var urls: [URL] { preview.media?.galleryURLs ?? [] }
    /// The work's own frame, so a portrait keeps its face; only pictures
    /// taller than 2:3 lose some of their bottom, which fades out anyway.
    private var ratio: Double {
        max(2.0 / 3, min(1.8, preview.media?.aspectRatio ?? 0.8))
    }
    var body: some View {
        Color.clear.aspectRatio(ratio, contentMode: .fit)
            .overlay { pages }
            .clipped()
            .overlay(alignment: .bottom) {
                // Paper runs 2 pt past the hero's edge: its height is rarely a whole pixel,
                // and while the detail zooms open the picture's last row showed as a grey line.
                VStack(spacing: 0) {
                    GrainDissolve()
                    Palette.paper.frame(height: 2)
                }.padding(.bottom, -2).allowsHitTesting(false).accessibilityHidden(true)
            }
            .overlay(alignment: .bottomTrailing) {
                if urls.count > 1 {
                    Text(verbatim: "\(page + 1) / \(urls.count)").font(Typography.meta(size: 11)).tracking(1).monospacedDigit()
                        .padding(.horizontal, 10).frame(height: 26).readingGlass()
                        .padding(.trailing, 16).padding(.bottom, 44)
                        .allowsHitTesting(false).accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { open?(page) }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(title)
            .accessibilityValue(urls.count > 1 ? "\(page + 1) / \(urls.count)" : "")
            .accessibilityAddTraits(open == nil ? .isImage : [.isImage, .isButton])
            .accessibilityAction { open?(page) }
            .accessibilityActions {
                if urls.count > 1 {
                    if page < urls.count - 1 { Button(String(localized: "下一张")) { page += 1 } }
                    if page > 0 { Button(String(localized: "上一张")) { page -= 1 } }
                }
            }
    }
    @ViewBuilder private var pages: some View {
        if urls.count > 1 {
            TabView(selection: $page) {
                ForEach(urls.indices, id: \.self) { index in
                    Group {
                        if index == 0 { Artwork(preview: preview, fillsFrame: true, showsVideoBadge: false, anchorsTop: true) }
                        // A fixed frame, as Artwork uses: a flexible one grows to the
                        // filled image and the page centres it, cropping off the head.
                        else { GeometryReader { proxy in
                            RemoteImage(url: urls[index], contentMode: .fill)
                                .frame(width: proxy.size.width, height: proxy.size.height, alignment: .top).clipped()
                        } }
                    }.tag(index)
                }
            }.tabViewStyle(.page(indexDisplayMode: .never))
        } else {
            Artwork(preview: preview, fillsFrame: true, showsVideoBadge: false, anchorsTop: true)
        }
    }
}

/// The work dissolves into the page as film grain, the way a print fades at its
/// edge in the darkroom, instead of a smooth fade or shadow laid over it. At the
/// bottom it settles to plain paper; at the top it keeps the status bar readable.
struct GrainDissolve: View {
    enum Edge { case top, bottom }
    static let bottomHeight: CGFloat = 60
    var edge: Edge = .bottom
    var body: some View {
        let height = edge == .bottom ? Self.bottomHeight : (EdgeVeil.statusBarHeight + 30).rounded()
        Palette.paper
            .mask { Image(uiImage: Self.mask(edge, points: Int(height))).resizable().interpolation(.none) }
            .frame(height: height)
    }
    @MainActor private static var masks: [String: UIImage] = [:]
    /// One grain per pixel at 3x across the widest phone, made once per edge and height.
    @MainActor private static func mask(_ edge: Edge, points: Int) -> UIImage {
        let key = "\(edge)-\(points)"
        if let mask = masks[key] { return mask }
        let width = 1290, height = max(points, 1) * 3
        var alpha = [UInt8](repeating: 0, count: width * height)
        var seed: UInt32 = 0x9E3779B9
        for y in 0..<height {
            // Distance into the work from its edge: 0 at the paper, 1 where the picture is whole.
            let row = Double(y) / Double(max(height - 1, 1))
            let t = edge == .bottom ? 1 - row : row
            let eased = (1 - t * t * (3 - 2 * t)) * (edge == .bottom ? 1 : 0.9)
            // Grain is densest mid-way and fades out at both ends, so neither end shows a line.
            let spread = 0.9 * (1 - abs(2 * eased - 1) * 0.6) * min(1, t / 0.15, (1 - t) / 0.3)
            for x in 0..<width {
                seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5
                let grain = Double(seed & 0xFFFF) / 65535 - 0.5
                alpha[y * width + x] = UInt8(max(0, min(1, eased + grain * spread)) * 255)
            }
        }
        let context = CGContext(data: &alpha, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
                                space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.alphaOnly.rawValue)
        let mask = context?.makeImage().map { UIImage(cgImage: $0, scale: 3, orientation: .up) } ?? UIImage()
        masks[key] = mask
        return mask
    }
}

extension ContentPreview {
    /// Film-edge meta: kind, model and, for visual work, its frame ratio.
    var metaLine: String {
        [displayKind, Prompt.namesModel(model) ? Prompt.localizedModel(model) : "", generation?.outputAspect ?? media?.aspectRatio.flatMap(Self.ratioLabel) ?? "", durationLabel ?? ""]
            .filter { !$0.isEmpty }.joined(separator: " ▸ ").uppercased()
    }
    /// The detail's line: model ▸ frame ▸ length. Words have no frame, and an
    /// unknown model is left out rather than replaced by the kind.
    var detailMeta: (lead: String, rest: String) {
        let lead = Prompt.namesModel(model) ? Prompt.localizedModel(model).uppercased() : ""
        let frame = kind == .text ? "" : generation?.outputAspect ?? media?.aspectRatio.flatMap(Self.ratioLabel) ?? ""
        let rest = [frame, durationLabel ?? ""].filter { !$0.isEmpty }
        return (lead, rest.enumerated().map { ($0.offset == 0 && lead.isEmpty ? "" : " ▸ ") + $0.element }.joined())
    }
    /// The nearest common frame ratio, or nothing for an unusual shape.
    static func ratioLabel(_ ratio: Double) -> String? {
        let common: [(String, Double)] = [("1:1", 1), ("4:5", 0.8), ("3:4", 0.75), ("2:3", 2.0 / 3), ("9:16", 9.0 / 16),
                                          ("5:4", 1.25), ("4:3", 4.0 / 3), ("3:2", 1.5), ("16:9", 16.0 / 9), ("21:9", 21.0 / 9)]
        guard ratio > 0, let nearest = common.min(by: { abs($0.1 - ratio) < abs($1.1 - ratio) }),
              abs(nearest.1 - ratio) / nearest.1 < 0.03 else { return nil }
        return nearest.0
    }
    var hasDetailMedia: Bool {
        kind == .video || media?.image != nil || media?.imageURL != nil
    }
}

private struct PromptBodySkeleton: View {
    @ScaledMetric(relativeTo: .body) private var lineHeight = 12.0
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            ForEach(0..<2) { _ in
                VStack(alignment: .leading, spacing: 14) {
                    ForEach([1.0, 0.93, 0.98, 0.62], id: \.self) { fraction in
                        GeometryReader { geometry in
                            LoadingSurface().clipShape(RoundedRectangle(cornerRadius: 3))
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
    var actionsCollapsed = false
}

extension View {
    /// A collapsed arrangement does not lay out its secondary pane; narrow
    /// screens then keep the full preview above the reading content.
    func reportsPaneVisibility(_ visible: Binding<Bool>) -> some View {
        onGeometryChange(for: Bool.self) { $0.size.width > 1 && $0.size.height > 1 } action: { visible.wrappedValue = $0 }
            .onDisappear { visible.wrappedValue = false }
    }
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
