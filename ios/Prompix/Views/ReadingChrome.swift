import SwiftUI

/// Feathered reading protection, with no hard edge between chrome and artwork.
/// The scroll view keeps its original safe-area layout but draws behind this veil.
struct ReadingTopFade: View {
    var collapsed = false
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var body: some View {
        Group {
            if reduceTransparency { Rectangle().fill(Palette.paper) }
            else {
                Rectangle().fill(.regularMaterial).overlay(Palette.paper.opacity(0.12))
                    .opacity(collapsed ? 0.72 : 1)
            }
        }
        .mask(alignment: .bottom) {
            VStack(spacing: 0) {
                Rectangle()
                LinearGradient(stops: [
                    .init(color: .black, location: 0),
                    .init(color: .black.opacity(0.85), location: 0.25),
                    .init(color: .black.opacity(0.35), location: 0.65),
                    .init(color: .clear, location: 1)
                ], startPoint: .top, endPoint: .bottom).frame(height: 48)
            }
        }
        .allowsHitTesting(false).accessibilityHidden(true)
    }
}

/// Accumulates deliberate travel, ignores bounce and programmatic layout changes.
struct ReadingScrollState {
    private var previous: CGFloat?
    private var travel: CGFloat = 0
    private(set) var collapsed = false

    mutating func update(offset: CGFloat, maximum: CGFloat, isScrolling: Bool) -> Bool {
        let position = min(max(0, offset), max(0, maximum))
        defer { previous = position }
        guard let previous else { return collapsed }
        if position < 12 { collapsed = false; travel = 0; return false }
        guard isScrolling else { travel = 0; return collapsed }
        let delta = position - previous
        if (delta > 0 && travel < 0) || (delta < 0 && travel > 0) { travel = 0 }
        travel += delta
        if position > 120 && travel > 32 { collapsed = true; travel = 0 }
        if travel < -22 { collapsed = false; travel = 0 }
        return collapsed
    }
}

private struct ReadingChrome: ViewModifier {
    @Binding var collapsed: Bool
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @State private var tracker = ReadingScrollState()
    @State private var isScrolling = false
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content
                .onScrollPhaseChange { _, phase in isScrolling = phase == .interacting || phase == .decelerating }
                .onScrollGeometryChange(for: ScrollSample.self) { geometry in
                    ScrollSample(offset: geometry.contentOffset.y + geometry.contentInsets.top,
                                 maximum: geometry.contentSize.height + geometry.contentInsets.top + geometry.contentInsets.bottom - geometry.containerSize.height)
                } action: { _, sample in
                    let next = tracker.update(offset: sample.offset, maximum: sample.maximum, isScrolling: isScrolling)
                    collapsed = voiceOver ? false : next
                }
                .onChange(of: voiceOver) { _, enabled in if enabled { collapsed = false } }
        } else { content }
    }
    private struct ScrollSample: Equatable { let offset: CGFloat; let maximum: CGFloat }
}

extension View {
    func readingChrome(_ collapsed: Binding<Bool>) -> some View { modifier(ReadingChrome(collapsed: collapsed)) }
    func readingGlass(prominent: Bool = false) -> some View {
        modifier(ReadingGlass(prominent: prominent))
    }
}

private struct ActionGlassIdentity: ViewModifier {
    let id: String
    let namespace: Namespace.ID
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 26, *) { content.glassEffectID(id, in: namespace) }
        else { content }
    }
}
extension View {
    func actionGlassIdentity(_ id: String, in namespace: Namespace.ID) -> some View {
        modifier(ActionGlassIdentity(id: id, namespace: namespace))
    }
}

private struct ReadingGlass: ViewModifier {
    let prominent: Bool
    @Environment(\.colorScheme) private var colorScheme
    // Material snapshots can supply temporary UIKit traits during interactive zoom.
    // Resolve the tint from the page appearance before handing it to Liquid Glass.
    private var tint: Color {
        colorScheme == .dark ? Color(red: 173 / 255, green: 190 / 255, blue: 255 / 255)
            : Color(red: 64 / 255, green: 89 / 255, blue: 191 / 255)
    }
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.glassEffect(prominent ? .regular.tint(tint).interactive() : .regular.interactive(), in: Capsule())
        } else if prominent {
            content.background(tint, in: Capsule())
        } else {
            content.background(.regularMaterial, in: Capsule())
        }
    }
}
