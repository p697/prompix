import SwiftUI

enum Palette {
    private static func adaptive(_ light: UInt, _ dark: UInt) -> Color {
        Color(uiColor: UIColor { traits in
            let rgb = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((rgb >> 16) & 255) / 255,
                           green: CGFloat((rgb >> 8) & 255) / 255,
                           blue: CGFloat(rgb & 255) / 255, alpha: 1)
        })
    }

    // Neutral reading surfaces; the user's FIELD reference supplies the spectrum.
    static let paper = adaptive(0xF9F9FC, 0x17161F)
    static let surface = adaptive(0xFFFFFF, 0x24222F)
    static let soft = adaptive(0xEEEDF7, 0x302C40)
    static let ink = adaptive(0x272433, 0xF1EFFA)
    static let muted = adaptive(0x6C687C, 0xB8B2CA)
    static let accent = adaptive(0x4B3FD3, 0xC4BCFF)
    static let highlight = adaptive(0xE4DFFD, 0xA79BE9)
    static let highlightInk = Color(red: 0.20, green: 0.15, blue: 0.42)
    static let noteMint = adaptive(0xE8EEFC, 0x252E46)
    static let noteRose = adaptive(0xF5E8F4, 0x3A2941)
    static let noteLavender = adaptive(0xEDE9FC, 0x312B49)
    static let line = adaptive(0xDEDBEA, 0x484157)

    // Decorative pigments never encode a state or carry body text by themselves.
    static let spectrumBlue = Color(red: 0.282, green: 0.337, blue: 0.937)
    static let spectrumIris = Color(red: 0.541, green: 0.471, blue: 0.898)
    static let spectrumRose = Color(red: 0.804, green: 0.549, blue: 0.894)
    static let spectrumIce = Color(red: 0.702, green: 0.816, blue: 0.984)
    static let spectrumPetal = Color(red: 0.933, green: 0.769, blue: 0.906)

    // The icon's icy top, violet body and blue base stay continuous across all seven pages.
    static func onboardingGlass(at fraction: Double) -> LinearGradient {
        let t = min(1, max(0, fraction))
        func blend(_ start: (Double, Double, Double), _ end: (Double, Double, Double)) -> Color {
            Color(red: start.0 + (end.0 - start.0) * t,
                  green: start.1 + (end.1 - start.1) * t,
                  blue: start.2 + (end.2 - start.2) * t)
        }
        return LinearGradient(stops: [
            .init(color: blend((0.88, 0.95, 0.98), (0.91, 0.92, 0.97)), location: 0),
            .init(color: blend((0.68, 0.81, 0.97), (0.88, 0.70, 0.83)), location: 0.35),
            .init(color: blend((0.49, 0.65, 0.96), (0.65, 0.58, 0.87)), location: 0.75),
            .init(color: blend((0.36, 0.52, 0.93), (0.34, 0.39, 0.71)), location: 1)
        ], startPoint: .topLeading, endPoint: .bottomTrailing)
    }

}

enum Typography {
    static func editorial(_ style: Font.TextStyle) -> Font {
        .system(style, design: .default, weight: .regular)
    }
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
    private var onSelect: ((PromptKind?, Bool) -> Void)?
    init(selection: Binding<PromptKind?>, skillsOnly: Binding<Bool> = .constant(false), onSelect: ((PromptKind?, Bool) -> Void)? = nil) {
        _selection = selection
        _skillsOnly = skillsOnly
        self.onSelect = onSelect
    }
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 18) {
                choice(nil, title: String(localized: "全部"))
                ForEach(PromptKind.allCases) { choice($0, title: $0.title) }
                Button { select(nil, skills: true) } label: {
                    choiceLabel("Skills", selected: skillsOnly)
                }.buttonStyle(.plain).accessibilityAddTraits(skillsOnly ? .isSelected : [])
                    .accessibilityIdentifier("kind-skill")
            }.padding(.horizontal, 16)
        }
        .accessibilityIdentifier("kindPicker")
        .animation(reduceMotion ? nil : .snappy(duration: 0.24), value: selection)
        .animation(reduceMotion ? nil : .snappy(duration: 0.24), value: skillsOnly)
    }
    private func select(_ kind: PromptKind?, skills: Bool) {
        guard selection != kind || skillsOnly != skills else { return }
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
    private func choiceLabel(_ title: String, selected: Bool) -> some View {
        Text(title).font(.subheadline.weight(selected ? .semibold : .regular))
            .foregroundStyle(selected ? Palette.accent : Palette.muted)
            .padding(.horizontal, 2).frame(minWidth: 44, minHeight: 48)
            .overlay(alignment: .bottom) {
                if selected {
                    Capsule().fill(Palette.accent).frame(height: 2)
                        .matchedGeometryEffect(id: "kind-selection", in: selectionLine)
                }
            }.contentShape(Rectangle())
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
}
