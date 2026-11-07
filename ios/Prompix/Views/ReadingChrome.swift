import SwiftUI

/// Accumulates deliberate travel, ignores bounce and programmatic layout changes.
struct ReadingScrollState {
    private var previous: CGFloat?
    private var travel: CGFloat = 0
    private(set) var collapsed = false

    init(collapsed: Bool = false) { self.collapsed = collapsed }

    mutating func update(offset: CGFloat, maximum: CGFloat, isScrolling: Bool, isInteracting: Bool = true) -> Bool {
        let position = min(max(0, offset), max(0, maximum))
        defer { previous = position }
        guard let previous else { return collapsed }
        if position < 12 { collapsed = false; travel = 0; return false }
        guard isScrolling else { travel = 0; return collapsed }
        let delta = position - previous
        // A decelerating scroll can reverse during elastic settling, including
        // when safe-area geometry overestimates its maximum. Only a finger
        // moving back through content should reveal the controls.
        if delta < 0 && !isInteracting { travel = 0; return collapsed }
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
    @State private var isInteracting = false
    init(collapsed: Binding<Bool>) {
        _collapsed = collapsed
        _tracker = State(initialValue: ReadingScrollState(collapsed: collapsed.wrappedValue))
    }
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content
                .onScrollPhaseChange { _, phase in
                    isScrolling = phase == .interacting || phase == .decelerating
                    isInteracting = phase == .interacting
                }
                .onScrollGeometryChange(for: ScrollSample.self) { geometry in
                    ScrollSample(offset: geometry.contentOffset.y + geometry.contentInsets.top,
                                 maximum: geometry.contentSize.height + geometry.contentInsets.top + geometry.contentInsets.bottom - geometry.containerSize.height)
                } action: { _, sample in
                    let next = tracker.update(offset: sample.offset, maximum: sample.maximum, isScrolling: isScrolling, isInteracting: isInteracting)
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
    private var tint: Color { Palette.glassAccent(for: colorScheme) }
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

/// The same geometry is mounted for a card preview and its complete content.
/// Loading never inserts a new bottom bar or changes the reader's viewport.
struct ReadingActionBar: View {
    var ready = true
    var collapsed = false
    var copied = false
    var edit: () -> Void = {}
    var copy: () -> Void = {}
    @Namespace private var transition
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme
    private var title: String { copied ? String(localized: "已复制") : String(localized: "复制 Prompt") }
    var body: some View {
        Group {
            if #available(iOS 26, *) { GlassEffectContainer(spacing: 12) { buttons } }
            else { buttons }
        }
        .padding(.horizontal, 20).padding(.vertical, 8)
        .frame(maxWidth: 600).frame(maxWidth: .infinity)
        // The reading fades into paper beneath the buttons rather than running behind them.
        .background {
            LinearGradient(stops: [.init(color: Palette.paper.opacity(0), location: 0), .init(color: Palette.paper.opacity(0.92), location: 0.55), .init(color: Palette.paper, location: 1)],
                           startPoint: .top, endPoint: .bottom)
                .padding(.top, -40).ignoresSafeArea(edges: .bottom).allowsHitTesting(false)
        }
        .animation(reduceMotion ? nil : Motion.chrome, value: collapsed)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(collapsed ? "readingActionsCompact" : "readingActionsExpanded")
    }
    private var buttons: some View {
        HStack(spacing: 10) {
            Button(action: edit) {
                PrompixIcon.edit.image.frame(width: 50, height: 50)
            }.buttonStyle(.plain).readingGlass().actionGlassIdentity("edit", in: transition)
                .accessibilityLabel(String(localized: "写我的版本")).accessibilityIdentifier("editPromptAction")
            Button(action: copy) {
                HStack(spacing: 8) {
                    (copied ? PrompixIcon.check : PrompixIcon.copy).image
                    if !collapsed { Text(title).lineLimit(1).minimumScaleFactor(0.8) }
                }.font(.body.weight(.semibold)).frame(minWidth: 50, maxWidth: collapsed ? 50 : .infinity, minHeight: 50)
                    .foregroundStyle(Palette.onGlassAccent(for: colorScheme))
                    .contentTransition(.opacity)
            }.buttonStyle(.plain)
                .readingGlass(prominent: true).actionGlassIdentity("copy", in: transition)
                .accessibilityLabel(title).accessibilityIdentifier("copyPrompt")
                .sensoryFeedback(.success, trigger: copied)
        }
        .disabled(!ready)
        .accessibilityHint(ready ? "" : String(localized: "正在加载内容…"))
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }
}
