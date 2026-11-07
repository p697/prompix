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
    /// Text cards are artwork too: quiet tints, one per work, steady across launches.
    static let noteTints = [adaptive(0xE7E5DA, 0x24251F), adaptive(0xEFE3D6, 0x2A241F), adaptive(0xE2E5EA, 0x1F2228),
                            adaptive(0xEEE0DF, 0x2A2122), adaptive(0xE9E4D3, 0x27251E)]
    static func noteTint(for id: String) -> Color {
        let hash = id.utf8.reduce(UInt64(14695981039346656037)) { ($0 ^ UInt64($1)) &* 1099511628211 }
        return noteTints[Int(hash % UInt64(noteTints.count))]
    }

    // Liquid Glass tints are resolved from the page appearance, because material
    // snapshots can carry temporary UIKit traits during an interactive zoom.
    static func glassAccent(for scheme: ColorScheme) -> Color { rgb(scheme == .dark ? 0xF5F5F2 : 0x141415) }
    static func onGlassAccent(for scheme: ColorScheme) -> Color { rgb(scheme == .dark ? 0x0B0B0C : 0xF4F3EF) }
}

/// A row of quiet choices with one filled capsule: kinds on a deck, a creator, results.
struct ChipRow<Value: Hashable>: View {
    let values: [Value]
    @Binding var selection: Value
    let title: (Value) -> String
    var identifier: (Value) -> String = { _ in "" }
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                ForEach(values, id: \.self) { value in
                    let selected = value == selection
                    Button { selection = value } label: {
                        Text(title(value)).font(.subheadline.weight(selected ? .semibold : .regular))
                            .foregroundStyle(selected ? Palette.paper : Palette.muted)
                            .padding(.horizontal, 12).frame(height: 32)
                            .background(selected ? Palette.ink : .clear, in: Capsule())
                            .frame(minHeight: 44).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
                        .accessibilityIdentifier(identifier(value))
                }
            }.padding(.horizontal, 16)
        }
    }
}

/// Every section heading in the app: 15 pt semibold, with an optional quiet link.
struct SectionHeader<Destination: View>: View {
    let title: String
    var linkID = ""
    @ViewBuilder var destination: () -> Destination
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink).accessibilityAddTraits(.isHeader)
            Spacer(minLength: 12)
            if Destination.self != EmptyView.self {
                NavigationLink(destination: destination) {
                    Text(String(localized: "查看全部")).font(.footnote).foregroundStyle(Palette.muted).frame(minHeight: 44)
                }.accessibilityIdentifier(linkID)
            }
        }.frame(minHeight: 44)
    }
}
extension SectionHeader where Destination == EmptyView {
    init(title: String) { self.init(title: title) { EmptyView() } }
}

/// An empty place says one plain sentence and, at most, one more; no illustration.
struct QuietEmpty: View {
    let title: String
    var message: String? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.title3.weight(.semibold)).foregroundStyle(Palette.ink)
            if let message { Text(message).font(.subheadline).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true) }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.vertical, 28)
            .accessibilityElement(children: .combine)
    }
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
    /// A text card's title is set like a quotation: New York for Latin, Songti
    /// for Chinese once the system has it, Hiragino Mincho for Japanese.
    @MainActor static func noteTitle(_ text: String, size: CGFloat) -> Font {
        if usesSerif(text) { return .system(size: size, weight: .semibold, design: .serif) }
        let scalars = text.unicodeScalars
        if scalars.contains(where: { (0xAC00...0xD7AF).contains($0.value) }) { return .system(size: size, weight: .semibold) }
        if scalars.contains(where: { (0x3040...0x30FF).contains($0.value) }) { return .custom("HiraMinProN-W6", fixedSize: size) }
        return NoteFonts.shared.songtiReady ? .custom(NoteFonts.songti, fixedSize: size) : .system(size: size, weight: .semibold)
    }
    /// Parameters such as kind, model and ratio read like film-edge printing: SF Mono.
    static func meta(size: CGFloat) -> Font { .system(size: size, weight: .regular, design: .monospaced) }
}

/// Songti SC is one of Apple's downloadable system fonts: nothing ships in the
/// app, and text cards use the system face until it is on the device.
@MainActor @Observable final class NoteFonts {
    static let shared = NoteFonts()
    static let songti = "STSongti-SC-Bold"
    private(set) var songtiReady = UIFont(name: songti, size: 12) != nil
    private var requested = false
    func prepare() {
        guard !songtiReady, !requested else { return }
        requested = true
        Self.download(Self.songti) { Task { @MainActor in NoteFonts.shared.songtiReady = UIFont(name: NoteFonts.songti, size: 12) != nil } }
    }
    /// Core Text reports progress on its own queue, so the handler is not main-actor code.
    nonisolated private static func download(_ name: String, finished: @escaping @Sendable () -> Void) {
        let descriptor = CTFontDescriptorCreateWithNameAndSize(name as CFString, 0)
        CTFontDescriptorMatchFontDescriptorsWithProgressHandler([descriptor] as CFArray, nil) { state, _ in
            if state == .didFinish { finished() }
            return true
        }
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
/// the header does. Shown over work, it sits on paper that fades out below it;
/// hidden, only a soft edge stays behind the status bar.
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
                ZStack(alignment: .top) {
                    EdgeVeil(hold: height, fade: 12).offset(y: shift).opacity(covered && !collapsed ? 1 : 0)
                    EdgeVeil().opacity(collapsed ? 1 : 0)
                }
            }
            .animation(reduceMotion ? nil : Motion.chrome, value: collapsed)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: covered)
    }
}

/// The top edge over moving work, after Cosmos: a light wash of paper and
/// blur behind the status bar only, gone `fade` points below it. With `hold`,
/// paper stays solid that much further down, behind a bar's own controls.
struct EdgeVeil: View {
    var hold: CGFloat = 0
    var fade: CGFloat = 10
    var body: some View {
        let top = Self.statusBarHeight + hold
        let height = top + fade
        let solid = hold > 0 ? top / height : 0.45
        ZStack {
            Rectangle().fill(.ultraThinMaterial)
                .mask(LinearGradient(stops: [.init(color: .black.opacity(hold > 0 ? 1 : 0.7), location: 0), .init(color: .black.opacity(hold > 0 ? 1 : 0.4), location: solid), .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom))
            LinearGradient(stops: [.init(color: Palette.paper.opacity(hold > 0 ? 0.94 : 0.8), location: 0),
                                   .init(color: Palette.paper.opacity(hold > 0 ? 0.94 : 0.5), location: solid),
                                   .init(color: Palette.paper.opacity(0), location: 1)], startPoint: .top, endPoint: .bottom)
        }.frame(height: height).frame(maxWidth: .infinity)
            .ignoresSafeArea(edges: .top).allowsHitTesting(false).accessibilityHidden(true)
    }
    /// Read from the window: a view that ignores the safe area reports none.
    @MainActor static var statusBarHeight: CGFloat {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.lazy.compactMap(\.keyWindow).first?.safeAreaInsets.top ?? scenes.first?.windows.first?.safeAreaInsets.top ?? 0
    }
}

extension View {
    /// Hides the system's blur under the top bar, for screens that draw their own edge.
    @ViewBuilder func hidesTopEdgeEffect() -> some View {
        if #available(iOS 26, *) { scrollEdgeEffectHidden(true, for: .top) } else { self }
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
    private var onSelect: ((PromptKind?) -> Void)?
    init(selection: Binding<PromptKind?>, onSelect: ((PromptKind?) -> Void)? = nil) {
        _selection = selection
        self.onSelect = onSelect
    }
    var body: some View {
        // The work people come for leads: images, then video and text.
        ChoiceBar(choices: [ChoiceBar.Choice(id: nil, title: String(localized: "全部"), identifier: "kind-all")]
                  + [PromptKind.image, .video, .text].map { ChoiceBar.Choice(id: $0, title: $0.title, identifier: "kind-\($0.rawValue)") },
                  selection: selection, identifier: "kindPicker") { kind in
            if let onSelect { onSelect(kind) } else { selection = kind }
        }
    }
}

/// A scrolling row of choices: the selected one is a solid capsule, the others plain text.
struct ChoiceBar<ID: Hashable>: View {
    struct Choice: Identifiable {
        let id: ID?
        let title: String
        let identifier: String
    }
    let choices: [Choice]
    let selection: ID?
    let identifier: String
    var more: (() -> Void)? = nil
    let select: (ID?) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var selectionLine
    @State private var picks = 0
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(choices) { choice in
                        let selected = selection == choice.id
                        Button {
                            guard !selected else { return }
                            picks &+= 1
                            select(choice.id)
                        } label: {
                            label(choice.title, selected: selected)
                        }.buttonStyle(.plain)
                            .accessibilityAddTraits(selected ? .isSelected : [])
                            .accessibilityIdentifier(choice.identifier)
                            .id(choice.identifier)
                    }
                    if let more {
                        Button(action: more) {
                            HStack(spacing: 4) {
                                Text(String(localized: "更多")).font(.subheadline)
                                PrompixIcon.chevronDown.image(size: 12)
                            }.foregroundStyle(Palette.muted)
                                .padding(.horizontal, 14).frame(minWidth: 44, minHeight: 48).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("moreChoices")
                    }
                }.padding(.horizontal, 16)
            }
            .accessibilityIdentifier(identifier)
            // A choice made elsewhere, such as from the full list, scrolls into view.
            .onChange(of: selection) { _, value in
                guard let choice = choices.first(where: { $0.id == value }) else { return }
                withAnimation(reduceMotion ? nil : .snappy(duration: 0.3)) { proxy.scrollTo(choice.identifier, anchor: .center) }
            }
        }
        .sensoryFeedback(.selection, trigger: picks)
        .animation(reduceMotion ? nil : .snappy(duration: 0.24), value: selection)
    }
    private func label(_ title: String, selected: Bool) -> some View {
        Text(title).font(.subheadline.weight(selected ? .semibold : .regular))
            .foregroundStyle(selected ? Palette.paper : Palette.muted)
            .padding(.horizontal, 14).frame(minHeight: 34)
            .background {
                if selected {
                    Capsule().fill(Palette.accent).matchedGeometryEffect(id: "choice-selection", in: selectionLine)
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
