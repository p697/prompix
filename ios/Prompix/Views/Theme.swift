import SwiftUI

enum Palette {
    static let paper = Color(uiColor: .systemBackground)
    static let soft = Color(uiColor: .secondarySystemBackground)
    static let ink = Color.primary
    static let muted = Color.secondary
    static let accent = Color(red: 0.39, green: 0.44, blue: 0.32)
}

struct Eyebrow: View {
    let text: String
    var body: some View { Text(text).font(.system(.caption2, design: .monospaced)).tracking(2).foregroundStyle(.secondary) }
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
                    .foregroundStyle(selection == kind ? Color.primary : .secondary)
                Capsule().fill(selection == kind ? Color.primary : .clear).frame(width: 18, height: 2)
            }.frame(minWidth: 44, minHeight: 44)
        }.buttonStyle(.plain)
            .accessibilityAddTraits(selection == kind ? .isSelected : [])
            .accessibilityIdentifier("kind-\(kind?.rawValue ?? "all")")
    }
}
