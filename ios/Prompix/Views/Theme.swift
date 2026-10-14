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

    static let paper = adaptive(0xFCFCF9, 0x1A1E18)
    static let surface = adaptive(0xFFFFFF, 0x292E25)
    static let soft = adaptive(0xECEEE4, 0x30362B)
    static let ink = adaptive(0x252A22, 0xF1F2E9)
    static let muted = adaptive(0x62685B, 0xB8BFAC)
    static let accent = adaptive(0x435332, 0xD1E190)
    static let highlight = adaptive(0xD6E579, 0xC8D974)
    static let highlightInk = Color(red: 0.15, green: 0.18, blue: 0.11)
    static let noteSage = adaptive(0xEEF0E4, 0x2B3427)
    static let noteRose = adaptive(0xF3EAE5, 0x382D29)
    static let noteLavender = adaptive(0xECEBF2, 0x302F3B)
    static let line = adaptive(0xDCE0D2, 0x434A3B)
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
                Capsule().fill(selected ? Palette.accent : .clear).frame(height: 2)
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
