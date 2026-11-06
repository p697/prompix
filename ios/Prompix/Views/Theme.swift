import SwiftUI

enum Palette {
    private static func rgb(_ value: UInt) -> Color {
        Color(red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255,
              blue: Double(value & 255) / 255)
    }
    private static func adaptive(_ light: UInt, _ dark: UInt) -> Color {
        Color(uiColor: UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((value >> 16) & 255) / 255,
                           green: CGFloat((value >> 8) & 255) / 255,
                           blue: CGFloat(value & 255) / 255, alpha: 1)
        })
    }

    // Darkroom in dark mode, photographic paper in light mode. The interface is
    // black, grey and white only; artwork supplies every other color.
    static let paper = adaptive(0xF4F3EF, 0x0B0B0C)
    static let surface = adaptive(0xFBFAF7, 0x18181A)
    static let soft = adaptive(0xE8E7E2, 0x1E1E20)
    static let ink = adaptive(0x141415, 0xF5F5F2)
    static let muted = adaptive(0x6B6B67, 0x9A9A97)
    static let accent = ink
    static let line = adaptive(0xDAD9D3, 0x2A2A2C)

    // Liquid Glass tints are resolved from the page appearance, because material
    // snapshots can carry temporary UIKit traits during an interactive zoom.
    static func glassAccent(for scheme: ColorScheme) -> Color { rgb(scheme == .dark ? 0xF5F5F2 : 0x141415) }
    static func onGlassAccent(for scheme: ColorScheme) -> Color { rgb(scheme == .dark ? 0x0B0B0C : 0xF4F3EF) }
}

enum Motion {
    /// Chrome that yields to scrolling: the reading actions and root headers.
    static let chrome = Animation.spring(response: 0.38, dampingFraction: 0.86)
    static let press = Animation.spring(response: 0.22, dampingFraction: 0.78)
}

/// Cards answer the finger at once and spring back on release. System glass,
/// menus and pickers keep their own native feedback.
struct CardPressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .opacity(configuration.isPressed && reduceMotion ? 0.8 : 1)
            .animation(reduceMotion ? nil : Motion.press, value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == CardPressStyle {
    static var cardPress: CardPressStyle { CardPressStyle() }
}

enum Typography {
    static func editorial(_ style: Font.TextStyle) -> Font {
        .system(style, design: .default, weight: .regular)
    }
    /// Prompt text reads like print: New York.
    static func prompt(size: CGFloat) -> Font { .system(size: size, weight: .regular, design: .serif) }
    /// Parameters such as kind, model and ratio read like film-edge printing: SF Mono.
    static func meta(size: CGFloat) -> Font { .system(size: size, weight: .regular, design: .monospaced) }
}

extension View {
    // Reading and editing sheets use the system's full-height presentation.
    // Native corners, dismissal gestures and keyboard avoidance stay in charge.
    func promptSheet() -> some View {
        presentationDetents([.large])
            .presentationDragIndicator(.visible)
            .presentationBackground(Palette.paper)
    }

    func paperScreen() -> some View { modifier(PaperScreen()) }

    @ViewBuilder func plainTopEdge() -> some View {
        if #available(iOS 26, *) { scrollEdgeEffectHidden(true, for: .top) }
        else { self }
    }

    /// Root headers sit in the scroll view's top bar, so the system edge effect
    /// rather than a drawn material separates them from the content beneath.
    /// The hard style keeps header text legible over artwork.
    @ViewBuilder func rootHeaderBar<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        if #available(iOS 26, *) {
            safeAreaBar(edge: .top, spacing: 0, content: bar).scrollEdgeEffectStyle(.hard, for: .top)
        } else {
            safeAreaInset(edge: .top, spacing: 0) { bar().background(Palette.paper.ignoresSafeArea(edges: .top)) }
        }
    }

    @ViewBuilder func minimizesTabBarOnScroll() -> some View {
        if #available(iOS 26, *) { tabBarMinimizeBehavior(.onScrollDown) }
        else { self }
    }
}

private struct PaperScreen: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    func body(content: Content) -> some View {
        content.background(Palette.paper)
            .foregroundStyle(Palette.ink)
            .toolbarBackground(Palette.paper, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(colorScheme, for: .navigationBar)
    }
}

struct KindPicker: View {
    @Binding var selection: PromptKind?
    @Binding var skillsOnly: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var selectionLine
    @State private var picks = 0
    private var onSelect: ((PromptKind?, Bool) -> Void)?
    init(selection: Binding<PromptKind?>, skillsOnly: Binding<Bool> = .constant(false), onSelect: ((PromptKind?, Bool) -> Void)? = nil) {
        _selection = selection
        _skillsOnly = skillsOnly
        self.onSelect = onSelect
    }
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                choice(nil, title: String(localized: "全部"))
                ForEach(PromptKind.allCases) { choice($0, title: $0.title) }
                Button { select(nil, skills: true) } label: {
                    choiceLabel("Skills", selected: skillsOnly)
                }.buttonStyle(.plain).accessibilityAddTraits(skillsOnly ? .isSelected : [])
                    .accessibilityIdentifier("kind-skill")
            }.padding(.horizontal, 16)
        }
        .accessibilityIdentifier("kindPicker")
        .sensoryFeedback(.selection, trigger: picks)
        .animation(reduceMotion ? nil : .snappy(duration: 0.24), value: selection)
        .animation(reduceMotion ? nil : .snappy(duration: 0.24), value: skillsOnly)
    }
    private func select(_ kind: PromptKind?, skills: Bool) {
        guard selection != kind || skillsOnly != skills else { return }
        picks &+= 1
        if let onSelect { onSelect(kind, skills) }
        else { selection = kind; skillsOnly = skills }
    }
    private func choice(_ kind: PromptKind?, title: String) -> some View {
        let selected = selection == kind && !skillsOnly
        return Button { select(kind, skills: false) } label: {
            choiceLabel(title, selected: selected)
        }.buttonStyle(.plain)
            .accessibilityAddTraits(selected ? .isSelected : [])
            .accessibilityIdentifier("kind-\(kind?.rawValue ?? "all")")
    }
    // The selected kind is a solid capsule; the others are plain text.
    private func choiceLabel(_ title: String, selected: Bool) -> some View {
        Text(title).font(.subheadline.weight(selected ? .semibold : .regular))
            .foregroundStyle(selected ? Palette.paper : Palette.muted)
            .padding(.horizontal, 14).frame(minHeight: 34)
            .background {
                if selected {
                    Capsule().fill(Palette.accent).matchedGeometryEffect(id: "kind-selection", in: selectionLine)
                }
            }
            .frame(minWidth: 44, minHeight: 48).contentShape(Rectangle())
    }
}

struct PrimaryActionLabel: View {
    let title: String
    let compactTitle: String
    let symbol: String
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.isEnabled) private var isEnabled
    var body: some View {
        Label(typeSize.isAccessibilitySize ? compactTitle : title, systemImage: symbol)
            .font(.subheadline.weight(.semibold)).multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, minHeight: 24).padding(.horizontal, 14).padding(.vertical, 13)
            .foregroundStyle(Palette.paper)
            .background(Palette.accent, in: Capsule())
            .opacity(isEnabled ? 1 : 0.45)
            .accessibilityLabel(title)
    }
}

// Native zoom keeps the card connected to its detail and supplies the system's
// interactive dismissal. Older systems and Reduce Motion use the normal presentation.
private struct PromptTransition: ViewModifier {
    let id: String
    let namespace: Namespace.ID
    let source: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 18, *), !reduceMotion {
            if source { content.matchedTransitionSource(id: id, in: namespace) }
            else { content.navigationTransition(.zoom(sourceID: id, in: namespace)) }
        } else { content }
    }
}

extension View {
    func promptTransitionSource(id: String, in namespace: Namespace.ID) -> some View {
        modifier(PromptTransition(id: id, namespace: namespace, source: true))
    }
    func promptTransitionDestination(id: String, in namespace: Namespace.ID) -> some View {
        modifier(PromptTransition(id: id, namespace: namespace, source: false))
    }
}

// Custom sheet actions reserve space and participate in modern scroll-edge effects.
extension View {
    @ViewBuilder func promptActionBar<Bar: View>(@ViewBuilder content: () -> Bar) -> some View {
        if #available(iOS 26, *) {
            safeAreaBar(edge: .bottom, spacing: 0, content: content)
        } else {
            safeAreaInset(edge: .bottom, spacing: 0, content: content)
        }
    }

    // Reading text softens beneath floating actions instead of colliding with them.
    @ViewBuilder func readingBottomEdge() -> some View {
        if #available(iOS 26, *) { scrollEdgeEffectStyle(.soft, for: .bottom) }
        else { self }
    }
}
