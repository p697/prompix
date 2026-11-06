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
    /// New York only for Latin prompts. Chinese, Japanese and Korean text stays in
    /// the system face throughout, so Latin words inside it never switch to serif.
    static func prompt(size: CGFloat, for text: String) -> Font {
        usesSerif(text) ? prompt(size: size) : .system(size: size)
    }
    static func usesSerif(_ text: String) -> Bool {
        var letters = 0, cjk = 0
        for scalar in text.unicodeScalars.prefix(600) where scalar.properties.isAlphabetic {
            letters += 1
            if (0x3040...0x30FF).contains(scalar.value) || (0x3400...0x9FFF).contains(scalar.value) || (0xAC00...0xD7AF).contains(scalar.value) { cjk += 1 }
        }
        return cjk * 5 < letters
    }
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

    /// Root pages: a large title row and a pinned bar (the kind tabs). Scrolling
    /// down slides the whole header away; scrolling back up returns it.
    func rootHeader<Trailing: View, Bar: View>(title: String, titleID: String = "", @ViewBuilder trailing: () -> Trailing, @ViewBuilder bar: () -> Bar) -> some View {
        modifier(RootHeader(title: title, titleID: titleID, trailing: trailing(), bar: bar()))
    }

    @ViewBuilder func minimizesTabBarOnScroll() -> some View {
        if #available(iOS 26, *) { tabBarMinimizeBehavior(.onScrollDown) }
        else { self }
    }
}

/// The header keeps its inset while hidden, so the content never moves; only
/// the header does. Behind it, a paper veil covers the status bar and the tabs
/// and fades out just below them once work scrolls underneath.
private struct RootHeader<Trailing: View, Bar: View>: ViewModifier {
    let title: String
    let titleID: String
    let trailing: Trailing
    let bar: Bar
    @State private var collapsed = false
    @State private var covered = false
    @State private var height: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content
            .toolbar(.hidden, for: .navigationBar)
            .readingChrome($collapsed)
            .tracksCover($covered)
            .topBar { header }
    }
    private var header: some View {
        let shift = collapsed ? -height : 0
        return VStack(spacing: 4) {
            HStack {
                Text(title).font(.largeTitle.bold()).accessibilityAddTraits(.isHeader).accessibilityIdentifier(titleID)
                Spacer()
                trailing.font(.title3).buttonStyle(.plain).readingGlass()
            }.padding(.leading, 20).padding(.trailing, 16).padding(.vertical, 6)
            bar
        }.foregroundStyle(Palette.ink).padding(.bottom, 4)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
            .offset(y: shift).opacity(collapsed ? 0 : 1)
            .allowsHitTesting(!collapsed).accessibilityHidden(collapsed)
            .background(alignment: .top) {
                // Paper behind the status bar and the header, then a 32 pt fade.
                VStack(spacing: 0) {
                    Palette.paper
                    LinearGradient(colors: [Palette.paper, Palette.paper.opacity(0)], startPoint: .top, endPoint: .bottom)
                        .frame(height: 32).opacity(covered ? 1 : 0)
                }.padding(.bottom, -32).ignoresSafeArea(edges: .top)
                    .offset(y: shift)
                    .allowsHitTesting(false).accessibilityHidden(true)
            }
            .animation(reduceMotion ? nil : Motion.chrome, value: collapsed)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: covered)
    }
}

private extension View {
    /// True once any content has scrolled beneath the top inset.
    @ViewBuilder func tracksCover(_ covered: Binding<Bool>) -> some View {
        if #available(iOS 18, *) {
            onScrollGeometryChange(for: Bool.self) { $0.contentOffset.y + $0.contentInsets.top > 2 } action: { _, value in covered.wrappedValue = value }
        } else { self }
    }
    @ViewBuilder func topBar<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        if #available(iOS 26, *) {
            safeAreaBar(edge: .top, spacing: 0, content: bar).scrollEdgeEffectHidden(true, for: .top)
        } else {
            safeAreaInset(edge: .top, spacing: 0, content: bar)
        }
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
                // The work people come for leads: images, then video, text and web.
                ForEach([PromptKind.image, .video, .text, .web]) { choice($0, title: $0.title) }
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
