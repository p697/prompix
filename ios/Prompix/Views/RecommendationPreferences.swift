import SwiftUI

enum RecommendationCopy {
    static func text(_ key: String) -> String { NSLocalizedString(key, tableName: "Recommendations", comment: "Recommendation preference") }
}

struct InterestSelection: View {
    @Environment(Library.self) private var library
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(RecommendationCopy.text("interests.subtitle"))
                .font(.subheadline).foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: typeSize.isAccessibilitySize ? 1 : 2), spacing: 10) {
                ForEach(InterestCatalog.topics) { topic in
                    let selected = library.recommendations.interests.contains(topic.id)
                    Button {
                        var values = library.recommendations.interests
                        if selected { values.remove(topic.id) } else { values.insert(topic.id) }
                        library.recommendations.setInterests(values)
                    } label: {
                        HStack(spacing: 9) {
                            Image(systemName: topic.symbol).frame(width: 22).foregroundStyle(Palette.accent)
                            Text(topic.title).font(.subheadline.weight(selected ? .semibold : .regular))
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(selected ? Palette.accent : Palette.muted)
                        }.padding(12).frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
                            .background(selected ? Palette.accent.opacity(0.09) : Palette.soft.opacity(0.6), in: RoundedRectangle(cornerRadius: 16))
                            .overlay { RoundedRectangle(cornerRadius: 16).strokeBorder(selected ? Palette.accent.opacity(0.45) : .clear, lineWidth: 1) }
                    }.buttonStyle(.plain).foregroundStyle(Palette.ink)
                        .accessibilityLabel(topic.title)
                        .accessibilityAddTraits(selected ? .isSelected : [])
                        .accessibilityIdentifier("interest-\(topic.id)")
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                Toggle(RecommendationCopy.text("comfort.title"), isOn: Binding(get: { library.recommendations.reduceSuggestive }, set: { library.recommendations.setReduceSuggestive($0) }))
                    .accessibilityIdentifier("reduceSuggestiveRecommendations")
                Text(RecommendationCopy.text("comfort.description")).font(.footnote).foregroundStyle(Palette.muted)
            }
            Text(RecommendationCopy.text("interests.private"))
                .font(.footnote).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            if library.recommendations.storageFailed {
                Text(RecommendationCopy.text("preferences.failed")).font(.footnote).foregroundStyle(Palette.muted)
            }
        }
    }
}

struct RecommendationPreferences: View {
    @Environment(Library.self) private var library
    @State private var confirmsReset = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                InterestSelection()
                VStack(alignment: .leading, spacing: 8) {
                    Toggle(RecommendationCopy.text("learning.title"), isOn: Binding(get: { library.recommendations.learningEnabled }, set: { library.recommendations.setLearning($0) }))
                        .accessibilityIdentifier("recommendationLearning")
                    Text(RecommendationCopy.text("learning.description")).font(.footnote).foregroundStyle(Palette.muted)
                }
                Button(RecommendationCopy.text("reset.title"), role: .destructive) { confirmsReset = true }
                    .frame(minHeight: 44).accessibilityIdentifier("resetRecommendations")
            }.padding(20).frame(maxWidth: 600).frame(maxWidth: .infinity)
        }.background(Palette.paper).foregroundStyle(Palette.ink).tint(Palette.accent)
            .navigationTitle(RecommendationCopy.text("interests.title"))
            .navigationBarTitleDisplayMode(.inline)
            .confirmationDialog(RecommendationCopy.text("reset.description"), isPresented: $confirmsReset, titleVisibility: .visible) {
                Button(RecommendationCopy.text("reset.confirm"), role: .destructive) { library.recommendations.reset() }
                Button(String(localized: "取消"), role: .cancel) { }
            }
    }
}

private struct RecommendationSurfaceKey: EnvironmentKey { static let defaultValue = true }
extension EnvironmentValues {
    var recommendationSurfaceVisible: Bool {
        get { self[RecommendationSurfaceKey.self] }
        set { self[RecommendationSurfaceKey.self] = newValue }
    }
}
private struct RecommendationExposure: ViewModifier {
    let card: FeedCard
    let enabled: Bool
    @Environment(\.recommendationSurfaceVisible) private var surfaceVisible
    @Environment(Library.self) private var library
    @Environment(\.scenePhase) private var phase
    @State private var visible = false
    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content.onScrollVisibilityChange(threshold: 0.5) { visible = $0 }
                .task(id: visible && enabled && surfaceVisible && phase == .active) {
                    guard visible, enabled, surfaceVisible, phase == .active else { return }
                    do { try await Task.sleep(for: .milliseconds(800)) } catch { return }
                    guard !Task.isCancelled else { return }
                    library.recommendations.record(.impression, card: card)
                }
        } else {
            // Do not mistake eager/lazy cell construction for a viewed item.
            // Older systems still learn from explicit detail/save/use actions.
            content
        }
    }
}
extension View {
    func recommendationExposure(_ card: FeedCard, enabled: Bool = true) -> some View { modifier(RecommendationExposure(card: card, enabled: enabled)) }
}
