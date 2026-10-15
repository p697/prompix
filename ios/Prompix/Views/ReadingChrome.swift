import SwiftUI

/// Feathered reading protection, with no hard edge between chrome and artwork.
/// The scroll view keeps its original safe-area layout but draws behind this veil.
struct ReadingTopFade: View {
    var collapsed = false
    static let featherHeight: CGFloat = 24
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
                ], startPoint: .top, endPoint: .bottom).frame(height: Self.featherHeight)
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

    init(collapsed: Bool = false) { self.collapsed = collapsed }

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
    init(collapsed: Binding<Bool>) {
        _collapsed = collapsed
        _tracker = State(initialValue: ReadingScrollState(collapsed: collapsed.wrappedValue))
    }
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
        colorScheme == .dark ? Color(red: 210 / 255, green: 224 / 255, blue: 218 / 255)
            : Color(red: 47 / 255, green: 61 / 255, blue: 55 / 255)
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

/// The same geometry is mounted for a card preview and its complete content.
/// Loading never inserts a new bottom bar or changes the reader's viewport.
struct ReadingActionBar: View {
    let isSkill: Bool
    var ready = true
    var collapsed = false
    var copied = false
    var edit: () -> Void = {}
    var copy: () -> Void = {}
    var use: () -> Void = {}
    @Namespace private var transition
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        Group {
            if #available(iOS 26, *) { GlassEffectContainer(spacing: 12) { buttons } }
            else { buttons }
        }
        .padding(.horizontal, 20).padding(.vertical, 8)
        .frame(maxWidth: 600).frame(maxWidth: .infinity)
        .animation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.86), value: collapsed)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(collapsed ? "readingActionsCompact" : "readingActionsExpanded")
    }
    private var buttons: some View {
        HStack(spacing: 10) {
            Button(action: edit) {
                Image(systemName: "square.and.pencil").font(.body).frame(width: 50, height: 50)
            }.buttonStyle(.plain).readingGlass().actionGlassIdentity("edit", in: transition)
                .accessibilityLabel(String(localized: "编辑后使用")).accessibilityIdentifier("editPromptAction")
            Button(action: copy) {
                Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.body).frame(width: 50, height: 50)
            }.buttonStyle(.plain).readingGlass().actionGlassIdentity("copy", in: transition)
                .accessibilityLabel(copied ? String(localized: "已复制") : String(localized: "复制 Prompt"))
                .accessibilityIdentifier("copyPrompt").sensoryFeedback(.success, trigger: copied)
            Button(action: use) {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.up.right")
                    if !collapsed {
                        Text(typeSize.isAccessibilitySize ? String(localized: "使用") : isSkill ? String(localized: "使用这个 Skill") : String(localized: "使用 Prompt"))
                            .lineLimit(1).minimumScaleFactor(0.8)
                    }
                }.font(.body.weight(.semibold)).frame(minWidth: 50, maxWidth: collapsed ? 50 : .infinity, minHeight: 50)
                    .foregroundStyle(colorScheme == .dark ? Color(red: 0.10, green: 0.13, blue: 0.12) : .white)
            }.buttonStyle(.plain).readingGlass(prominent: true).actionGlassIdentity("use", in: transition)
                .accessibilityLabel(isSkill ? String(localized: "使用这个 Skill") : String(localized: "使用 Prompt"))
                .accessibilityIdentifier("usePrompt")
        }
        .disabled(!ready)
        .accessibilityHint(ready ? "" : String(localized: "正在加载内容…"))
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }
}
