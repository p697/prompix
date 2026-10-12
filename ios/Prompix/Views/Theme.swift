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

    static let paper = adaptive(0xF5F4EE, 0x1E221C)
    static let surface = adaptive(0xFFFFFF, 0x292E25)
    static let soft = adaptive(0xECEEE4, 0x30362B)
    static let ink = adaptive(0x252A22, 0xF1F2E9)
    static let muted = adaptive(0x62685B, 0xB8BFAC)
    static let accent = adaptive(0x435332, 0xD1E190)
    static let highlight = adaptive(0xD6E579, 0xC8D974)
    static let highlightInk = Color(red: 0.15, green: 0.18, blue: 0.11)
    static let line = adaptive(0xDCE0D2, 0x434A3B)
}

enum Typography {
    static func editorial(_ style: Font.TextStyle) -> Font {
        .system(style, design: .serif, weight: .regular)
    }
}

extension View {
    func paperScreen() -> some View {
        background(Palette.paper)
            .foregroundStyle(Palette.ink)
            .toolbarBackground(Palette.paper, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
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
            HStack(spacing: 4) {
                choice(nil, title: String(localized: "全部"))
                ForEach(PromptKind.allCases) { choice($0, title: $0.title) }
                Button { selection = nil; skillsOnly = true } label: {
                    choiceLabel("Skills", selected: skillsOnly)
                }.buttonStyle(.plain).accessibilityAddTraits(skillsOnly ? .isSelected : [])
                    .accessibilityIdentifier("kind-skill")
            }.padding(.horizontal, 20)
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
        Text(title).font(.subheadline.weight(selected ? .medium : .regular))
            .foregroundStyle(selected ? Palette.highlightInk : Palette.muted)
            .padding(.horizontal, 13).padding(.vertical, 8)
            .background(selected ? Palette.highlight : .clear, in: Capsule())
            .frame(minHeight: 44).contentShape(Rectangle())
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
            .foregroundStyle(Palette.highlightInk)
            .background(Palette.highlight, in: Capsule())
            .opacity(isEnabled ? 1 : 0.45)
            .accessibilityLabel(title)
    }
}
