import SwiftUI

/// Quantized geometry avoids publishing every scroll pixel to the image pipeline.
struct GridViewport: Equatable {
    var top: CGFloat = 0
    var height: CGFloat = 0
    var width: CGFloat = 0
    init() {}
    init(bounds: CGRect?, width: CGFloat) {
        guard let bounds, bounds.height > 0 else { return }
        top = floor(bounds.minY / 160) * 160
        height = bounds.height.rounded(.up)
        self.width = width.rounded()
    }
    var end: CGFloat { top + height * 3 }
    func includes(top itemTop: CGFloat, height itemHeight: CGFloat) -> Bool {
        itemTop + itemHeight >= max(0, top - height * 0.25) && itemTop <= end
    }
}

/// Observes the whole result surface, not a lazily mounted footer. Crossing
/// one viewport from the end requests once; errors remain an explicit retry.
private struct FeedLookahead: ViewModifier {
    let cursor: String?
    let enabled: Bool
    let generation: Int
    let load: () -> Void
    @State private var requestedCursor: String?
    @State private var sample = PageApproach()
    func body(content: Content) -> some View {
        content.onGeometryChange(for: PageApproach.self) { proxy in
            PageApproach(contentHeight: proxy.size.height, viewport: proxy.bounds(of: .scrollView(axis: .vertical)), cursor: cursor, generation: generation)
        } action: { next in
            if sample.generation != next.generation { requestedCursor = nil }
            sample = next
            requestIfApproaching(next)
        }
        .onChange(of: enabled) { _, value in
            if value { requestIfApproaching(sample) }
        }
        .onChange(of: cursor) { _, value in if value == nil { requestedCursor = nil } }
    }
    private func requestIfApproaching(_ value: PageApproach) {
        guard enabled, value.approaching, let cursor, value.cursor == cursor, value.generation == generation, cursor != requestedCursor else { return }
        requestedCursor = cursor
        load()
    }
}
struct PageApproach: Equatable {
    var approaching = false
    var contentHeight: CGFloat = 0
    var cursor: String?
    var generation = 0
    init() {}
    init(contentHeight: CGFloat, viewport: CGRect?, cursor: String? = nil, generation: Int = 0) {
        self.cursor = cursor
        self.generation = generation
        self.contentHeight = contentHeight.rounded()
        guard let viewport, viewport.height > 0, contentHeight > 0 else { return }
        approaching = viewport.maxY > 0 && contentHeight - viewport.maxY <= viewport.height
    }
}
extension View {
    func feedLookahead(cursor: String?, generation: Int, enabled: Bool, load: @escaping () -> Void) -> some View {
        modifier(FeedLookahead(cursor: cursor, enabled: enabled, generation: generation, load: load))
    }
}
