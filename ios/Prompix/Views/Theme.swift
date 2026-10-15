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

    static let paper = adaptive(0xFAFBFE, 0x12151D)
    static let surface = adaptive(0xFFFFFF, 0x202531)
    static let soft = adaptive(0xEDF0F7, 0x272E3C)
    static let ink = adaptive(0x1B2130, 0xEDF0FA)
    static let muted = adaptive(0x626B7B, 0xA9B3C7)
    static let accent = adaptive(0x4059BF, 0xADBEFF)
    static let highlight = adaptive(0xDAE4FF, 0xA9BCFF)
    static let highlightInk = Color(red: 0.12, green: 0.19, blue: 0.40)
    static let noteMint = adaptive(0xEAF2F1, 0x223433)
    static let noteRose = adaptive(0xF5EDF3, 0x352937)
    static let noteLavender = adaptive(0xEFEDFA, 0x2B2B40)
    static let line = adaptive(0xDCE2EF, 0x3D475C)

    // These decorative colors never carry text or encode a state by themselves.
    static let spectrumBlue = Color(red: 0.32, green: 0.47, blue: 0.94)
    static let spectrumIris = Color(red: 0.57, green: 0.49, blue: 0.87)
    static let spectrumRose = Color(red: 0.87, green: 0.67, blue: 0.80)
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
    init(selection: Binding<PromptKind?>, skillsOnly: Binding<Bool> = .constant(false)) {
        _selection = selection
        _skillsOnly = skillsOnly
    }
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 18) {
                choice(nil, title: String(localized: "全部"))
                ForEach(PromptKind.allCases) { choice($0, title: $0.title) }
                Button { selection = nil; skillsOnly = true } label: {
                    choiceLabel("Skills", selected: skillsOnly)
                }.buttonStyle(.plain).accessibilityAddTraits(skillsOnly ? .isSelected : [])
                    .accessibilityIdentifier("kind-skill")
            }.padding(.horizontal, 16)
        }
        .accessibilityIdentifier("kindPicker")
        .animation(reduceMotion ? nil : .snappy(duration: 0.24), value: selection)
        .animation(reduceMotion ? nil : .snappy(duration: 0.24), value: skillsOnly)
    }
    private func choice(_ kind: PromptKind?, title: String) -> some View {
        let selected = selection == kind && !skillsOnly
        return Button { selection = kind; skillsOnly = false } label: {
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
