import SwiftUI

enum Palette {
    static let paper = Color(uiColor: .systemBackground)
    static let soft = Color(uiColor: .secondarySystemBackground)
    static let ink = Color.primary
    static let muted = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(white: 0.72, alpha: 1) : UIColor(white: 0.36, alpha: 1)
    })
    static let accent = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(red: 0.69, green: 0.75, blue: 0.59, alpha: 1) : UIColor(red: 0.35, green: 0.40, blue: 0.28, alpha: 1)
    })
}

struct KindPicker: View {
    @Binding var selection: PromptKind?
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 26) {
                choice(nil, title: String(localized: "全部"))
                ForEach(PromptKind.allCases) { choice($0, title: $0.title) }
            }.padding(.horizontal, 20)
        }
        .accessibilityIdentifier("kindPicker")
    }
    private func choice(_ kind: PromptKind?, title: String) -> some View {
        Button { selection = kind } label: {
            VStack(spacing: 10) {
                Text(title).font(.subheadline.weight(selection == kind ? .semibold : .regular))
                    .foregroundStyle(selection == kind ? Color.primary : Palette.muted)
                Capsule().fill(selection == kind ? Color.primary : .clear).frame(width: 18, height: 2)
            }.frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
        }.buttonStyle(.plain)
            .accessibilityAddTraits(selection == kind ? .isSelected : [])
            .accessibilityIdentifier("kind-\(kind?.rawValue ?? "all")")
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
            .foregroundStyle(Color(uiColor: .systemBackground))
            .background(Color(uiColor: .label), in: RoundedRectangle(cornerRadius: 16))
            .opacity(isEnabled ? 1 : 0.45)
            .accessibilityLabel(title)
    }
}
