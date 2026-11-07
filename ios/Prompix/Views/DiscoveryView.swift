import SwiftUI

private enum MainTab: Hashable { case discover, saved, search }

struct RootView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showsOnboarding = !UserDefaults.standard.bool(forKey: "hasCompletedOnboarding")
    @State private var tab = MainTab.discover
    @State private var searchActivation = 0
    private var selection: Binding<MainTab> {
        Binding(get: { tab }, set: { value in
            tab = value
            if value == .search { searchActivation &+= 1 }
        })
    }
    var body: some View {
        ZStack {
            if showsOnboarding {
                PrompixOnboarding {
                    UserDefaults.standard.set(true, forKey: "hasCompletedOnboarding")
                    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.3)) { showsOnboarding = false }
                }
                .environment(\.recommendationSurfaceVisible, false)
                .transition(.opacity)
            } else {
                tabs.transition(.opacity)
            }
        }
        .tint(Palette.accent).background(Palette.paper)
    }
    @ViewBuilder private var tabs: some View {
        if #available(iOS 18, *) {
            TabView(selection: selection) {
                Tab(value: MainTab.discover) { DiscoverView() } label: {
                    Label { Text(String(localized: "发现")) } icon: { PrompixIcon.discover.image(size: 24) }
                }
                Tab(value: MainTab.saved) { FavoritesView() } label: {
                    Label { Text(String(localized: "收藏")) } icon: { PrompixIcon.saved.image(size: 24) }
                }
                if #available(iOS 27, *) {
                    Tab(value: MainTab.search, role: .prominent) { search } label: {
                        Label { Text(String(localized: "搜索")) } icon: { PrompixIcon.search.image(size: 24) }
                    }
                } else {
                    Tab(value: MainTab.search, role: .search) { search }
                }
            }
            .autocorrectionDisabled().textInputAutocapitalization(.never)
            .minimizesTabBarOnScroll()
        } else {
            TabView(selection: selection) {
                DiscoverView().tag(MainTab.discover)
                    .tabItem { Label { Text(String(localized: "发现")) } icon: { PrompixIcon.discover.image(size: 24) } }
                FavoritesView().tag(MainTab.saved)
                    .tabItem { Label { Text(String(localized: "收藏")) } icon: { PrompixIcon.saved.image(size: 24) } }
                search.tag(MainTab.search)
                    .tabItem { Label(String(localized: "搜索"), systemImage: "magnifyingglass") }
            }
        }
    }
    private var search: some View {
        SearchView(isSelected: tab == .search, activation: searchActivation)
    }
}

struct DiscoverView: View {
    @Environment(Library.self) private var library
    @State private var kind: PromptKind?
    @State private var topic: String?
    @State private var feedSort = "recommended"
    @Environment(\.recommendationSurfaceVisible) private var recommendationSurfaceVisible
    @State private var appliedPreferenceRevision = 0
    @State private var model: String?
    @State private var facet: String?
    @State private var modelFamily: String?
    @State private var viewportHeight: CGFloat = 0
    @State private var feedLayout = PromptGridLayout(width: 0)
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let topics = ["好玩一点", "创作灵感", "日常有用"]
    private var items: [Prompt] {
        library.prompts.filter {
            PromptQuery(kind: kind, topic: topic, model: model).matches($0) &&
                (feedSort != "recommended" || library.recommendations.allowsRecommended($0))
        }
    }
    private var feedQuery: FeedQuery {
        FeedQuery(kind: kind?.rawValue, tag: topic, model: model, sort: feedSort, facet: facet, modelFamily: modelFamily)
    }
    private var models: [String] {
        if let feed = library.feed { return feed.browse.value?.models.map(\.name) ?? [] }
        return Array(Set(library.prompts.filter { PromptQuery(kind: kind).matches($0) }.map(\.model))).sorted()
    }
    private var isFiltered: Bool { kind != nil || refined }
    private var refined: Bool { topic != nil || model != nil || facet != nil || modelFamily != nil }
    private var needsFirstVideoUpdate: Bool {
        kind == .video && library.version.hasPrefix("studio-") && !library.prompts.contains { $0.kind == .video }
    }
    var body: some View {
        NavigationStack {
            ScrollViewReader { scroll in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        Group {
                            discoveryContext
                            if let feed = library.feed {
                                FeedResults(store: feed.discovery, query: feedQuery, loadsOnAppear: false, fallback: items, layout: feedLayout, interlude: rails)
                            } else if items.isEmpty {
                                if needsFirstVideoUpdate {
                                    ContentUnavailableView {
                                        Label(String(localized: "视频内容需要联网更新"), systemImage: "play.rectangle")
                                    } description: {
                                        Text(String(localized: "首次联网更新后可浏览视频 Prompt。你也可以先查看其他类型的内容。"))
                                    } actions: {
                                        Button(library.isRefreshing ? String(localized: "正在更新…") : String(localized: "检查内容更新")) {
                                            Task { await library.refresh(force: true) }
                                        }.buttonStyle(.borderedProminent).foregroundStyle(Palette.paper).disabled(library.isRefreshing).accessibilityIdentifier("loadVideoExamples")
                                        Button(String(localized: "查看其他内容")) { kind = nil; topic = nil; model = nil }
                                            .buttonStyle(.bordered).accessibilityIdentifier("browseOtherIdeas")
                                    }
                                } else {
                                    ContentUnavailableView(String(localized: "暂无匹配内容"), systemImage: "sparkle", description: Text(String(localized: "试试其他分类，或清除筛选条件。")))
                                }
                            } else {
                                FeedInterleave(items: items, interlude: rails) { PromptGrid(items: $0).padding(.horizontal, PromptGridLayout.inset) }
                            }
                        }
                    }.id("discovery-top").padding(.bottom, 24)
                        .frame(minHeight: viewportHeight, alignment: .top)
                        .transaction { $0.animation = nil }
                }
                .accessibilityIdentifier("discoveryScroll")
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewportHeight = $0 }
                .onGeometryChange(for: PromptGridLayout.self) { proxy in
                    PromptGridLayout.measured(in: proxy, inset: PromptGridLayout.inset)
                } action: { if !$0.widths.isEmpty { feedLayout = $0 } }
                .scrollClipDisabled()
                .background(Palette.paper).foregroundStyle(Palette.ink)
                .rootHeader(title: String(localized: "发现"), titleID: "discoveryHeading") { filterMenu } bar: {
                    KindPicker(selection: $kind, onSelect: selectKind).padding(.bottom, 6)
                }
                .pageRefreshable {
                    // SwiftUI can cancel the refresh action when lazy sections
                    // move during overscroll. The user's bounded request owns its
                    // lifetime; query changes still cancel it inside the store.
                    await Task { @MainActor in
                        async let metadata: Void = library.refresh(force: true)
                        if let feed = library.feed {
                            await feed.discovery.load(feedQuery, force: true)
                        }
                        await metadata
                    }.value
                }
                .onChange(of: feedQuery) { _, query in
                    // One reset for the complete query; no intermediate kind +
                    // previous model/tag combinations or animated scroll jump.
                    var transaction = Transaction(); transaction.disablesAnimations = true
                    withTransaction(transaction) {
                        library.feed?.discovery.select(query)
                        scroll.scrollTo("discovery-top", anchor: .top)
                    }
                }
            }
            .task(id: feedQuery) { await library.feed?.discovery.load(feedQuery) }
            .task(id: "\(library.recommendations.preferenceRevision)-\(recommendationSurfaceVisible)") {
                let revision = library.recommendations.preferenceRevision
                guard recommendationSurfaceVisible, revision != appliedPreferenceRevision else { return }
                appliedPreferenceRevision = revision
                library.feed?.discovery.invalidateCachedPages()
                if feedSort == "recommended" { await library.feed?.discovery.load(feedQuery, force: true) }
            }
        }
    }
    // Creators and uses sit a screen or two into the feed, so the first screen is all work.
    private var rails: AnyView? {
        guard !isFiltered else { return nil }
        return AnyView(VStack(alignment: .leading, spacing: 14) {
            CreatorRail()
            CollectionRail(query: feedQuery)
        })
    }
    private func selectKind(_ next: PromptKind?) {
        kind = next; topic = nil; model = nil; facet = nil; modelFamily = nil
        library.feed?.discovery.select(feedQuery)
    }
    private var discoveryContext: some View {
        HStack(alignment: .center) {
            Text(feedSort == "latest" ? String(localized: "最新收录") : String(localized: "为你挑的"))
                .font(.subheadline.weight(.semibold))
            Spacer()
            sortMenu
        }.padding(.leading, 20).padding(.trailing, 16)
    }
    private var sortMenu: some View {
        Menu {
            Picker(String(localized: "排序"), selection: $feedSort) {
                Text(String(localized: "推荐")).tag("recommended")
                Text(String(localized: "最新收录")).tag("latest")
            }
        } label: {
            HStack(spacing: 4) {
                Text(feedSort == "latest" ? String(localized: "最新") : String(localized: "推荐")).font(Typography.meta(size: 12)).tracking(1.2)
                PrompixIcon.chevronDown.image(size: 12)
            }.foregroundStyle(Palette.muted).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
        }.accessibilityLabel(String(localized: "排序")).accessibilityIdentifier("discoverySort")
    }
    private var filterMenu: some View {
        Menu {
            if let browse = library.feed?.browse.value, let uses = browse.facets?.useCase, !uses.isEmpty {
                servedFilters(uses: uses, families: browse.modelFamilies ?? [])
            } else { catalogFilters }
            if refined {
                Button(String(localized: "清除筛选"), role: .destructive) { selectKind(kind) }
                    .accessibilityIdentifier("clearFilters")
            }
        } label: {
            PrompixIcon.filter.image.frame(width: 44, height: 44)
                .overlay(alignment: .topTrailing) {
                    if refined { Circle().fill(Palette.accent).frame(width: 7, height: 7).padding(9) }
                }
        }.accessibilityLabel(String(localized: "筛选")).accessibilityValue(refined ? String(localized: "已筛选") : "")
            .accessibilityIdentifier("discoveryFilters")
    }
    /// 2.0 filters from the service's own counts: use and model family.
    @ViewBuilder private func servedFilters(uses: [FeedBrowse.Count], families: [FeedBrowse.Count]) -> some View {
        Menu(facet.flatMap(FacetCatalog.name) ?? String(localized: "全部用途")) {
            choice(String(localized: "全部用途"), selected: facet == nil) { facet = nil }
            ForEach(uses.filter { $0.count > 0 }.sorted { $0.count > $1.count }) { use in
                if let name = FacetCatalog.name(use.id) { choice(name, selected: facet == use.id) { facet = use.id } }
            }
        }.accessibilityIdentifier("filterUse")
        Menu(modelFamily.flatMap { FacetCatalog.modelFamilies[$0] } ?? String(localized: "模型")) {
            choice(String(localized: "全部模型"), selected: modelFamily == nil) { modelFamily = nil }
            ForEach(families.filter { $0.count > 0 && FacetCatalog.modelFamilies[$0.id] != nil }.sorted { $0.count > $1.count }) { family in
                choice(FacetCatalog.modelFamilies[family.id]!, selected: modelFamily == family.id) { modelFamily = family.id }
            }
        }.accessibilityIdentifier("filterModelFamily")
    }
    private func choice(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) { if selected { Label(title, systemImage: "checkmark") } else { Text(title) } }
    }
    /// The bundled catalog's simpler use and model filters, offline or on an older service.
    @ViewBuilder private var catalogFilters: some View {
            Menu(String(localized: "全部用途")) {
                Button(String(localized: "全部用途")) { topic = nil }
                ForEach(topics, id: \.self) { value in
                    Button { topic = value } label: {
                        if topic == value { Label(NSLocalizedString(value, comment: "Topic"), systemImage: "checkmark") }
                        else { Text(NSLocalizedString(value, comment: "Topic")) }
                    }
                }
            }
            Menu(library.feed?.browse.value.map { $0.modelCount > $0.models.count } == true ? String(localized: "常用模型") : String(localized: "模型")) {
                Button(String(localized: "全部模型")) { model = nil }
                ForEach(models, id: \.self) { value in
                    Button { model = value } label: {
                        if model == value { Label(Prompt.localizedModel(value), systemImage: "checkmark") } else { Text(Prompt.localizedModel(value)) }
                    }
                }
            }
    }

}

struct PromptGrid: View {
    let items: [Prompt]
    var origin: PromptDetailOrigin = .catalog
    var body: some View {
        PreviewMasonryGrid(items: items, preview: ContentPreview.init) { PromptCard(item: $0, origin: origin) }
    }
}

struct PreviewMasonryGrid<Item: Identifiable, Cell: View>: View {
    let items: [Item]
    let preview: (Item) -> ContentPreview
    @ViewBuilder let cell: (Item) -> Cell
    var suppliedLayout: PromptGridLayout? = nil
    @Environment(\.cardShowsTitle) private var titled
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    @State private var measuredLayout = PromptGridLayout(width: 0)
    private var layout: PromptGridLayout { suppliedLayout.flatMap { $0.widths.isEmpty ? nil : $0 } ?? measuredLayout }
    @State private var viewport = GridViewport()
    @State private var prefetchOwner = UUID()
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        // Separate masonry columns read column-first. A linear native stack
        // preserves the editorial sequence when navigating with VoiceOver.
        Group {
            if typeSize.isAccessibilitySize || voiceOverEnabled {
                LazyVStack(spacing: 24) { ForEach(items) { cell($0) } }
            } else {
                let columns = balancedColumns
                HStack(alignment: .top, spacing: 0) {
                    ForEach(0..<layout.columns, id: \.self) { index in
                        column(columns[index], width: columnWidths[index]).frame(width: layout.widths.isEmpty ? nil : layout.widths[index])
                        if index < layout.columns - 1 { Color.clear.frame(width: layout.gaps[index], height: 1) }
                    }
                }.frame(minWidth: 0, maxWidth: .infinity)
                    .onGeometryChange(for: PromptGridLayout.self) { proxy in
                        PromptGridLayout.measured(in: proxy)
                    } action: { if !$0.widths.isEmpty { measuredLayout = $0 } }
            }
        }
        .onGeometryChange(for: GridViewport.self) { proxy in
            GridViewport(bounds: proxy.bounds(of: .scrollView(axis: .vertical)), width: proxy.size.width)
        } action: { viewport = $0 }
        .onChange(of: prefetchURLs, initial: true) { _, urls in ImageStore.shared.prefetch(urls, owner: prefetchOwner) }
        .onAppear { ImageStore.shared.prefetch(prefetchURLs, owner: prefetchOwner) }
        .onDisappear { ImageStore.shared.prefetch([], owner: prefetchOwner) }
    }
    private var prefetchURLs: [URL] {
        guard scenePhase == .active, viewport.height > 0 else { return [] }
        let linear = typeSize.isAccessibilitySize || voiceOverEnabled
        let widths = linear ? [max(1, viewport.width)] : (layout.widths.isEmpty ? [180, 180] : layout.widths)
        var bottoms = Array(repeating: CGFloat.zero, count: widths.count)
        var candidates: [(CGFloat, URL)] = []
        for item in items {
            let column = bottoms.indices.min { bottoms[$0] < bottoms[$1] }!
            let value = preview(item)
            let top = bottoms[column]
            let height = PromptCardGeometry.height(for: value, width: widths[column], titled: titled)
            bottoms[column] += height + (linear ? 24 : PromptGridLayout.gap)
            if !value.usesTextArtwork, viewport.includes(top: top, height: height), let url = value.media?.imageURL { candidates.append((top, url)) }
            if bottoms.allSatisfy({ $0 > viewport.end }) { break }
        }
        var seen = Set<URL>()
        return Array(candidates.sorted { $0.0 < $1.0 }.map(\.1).filter { seen.insert($0).inserted }.prefix(20))
    }
    private var columnWidths: [CGFloat] {
        layout.widths.isEmpty ? Array(repeating: CGFloat(180), count: layout.columns) : layout.widths
    }
    private var balancedColumns: [[Int]] {
        PromptMasonry.columns(itemCount: items.count, widths: columnWidths, spacing: PromptGridLayout.gap) { index, width in
            PromptCardGeometry.height(for: preview(items[index]), width: width, titled: titled)
        }
    }
    /// Every card's height is known before it is drawn, so a column is a plain
    /// stack of exact frames rather than a lazy stack of estimates: the grid's
    /// height never changes while scrolling and nothing above the reader moves.
    /// Only cards within a screen of the viewport are built.
    private func column(_ indices: [Int], width: CGFloat) -> some View {
        var top: CGFloat = 0
        let slots = indices.map { index -> GridSlot<Item.ID> in
            let height = PromptCardGeometry.height(for: preview(items[index]), width: width, titled: titled)
            defer { top += height + PromptGridLayout.gap }
            return GridSlot(id: items[index].id, index: index, top: top, height: height)
        }
        return VStack(spacing: PromptGridLayout.gap) {
            ForEach(slots, id: \.id) { slot in
                ZStack(alignment: .top) {
                    if builds(slot) { cell(items[slot.index]) }
                }.frame(maxWidth: .infinity).frame(height: slot.height, alignment: .top)
            }
        }.frame(maxWidth: .infinity)
    }
    private func builds<ID>(_ slot: GridSlot<ID>) -> Bool {
        // Before the first measurement, build the opening screen.
        guard viewport.height > 0 else { return slot.top < 1200 }
        return slot.top + slot.height >= viewport.top - viewport.height && slot.top <= viewport.top + viewport.height * 2
    }
}

private struct GridSlot<ID: Hashable> {
    let id: ID
    let index: Int
    let top: CGFloat
    let height: CGFloat
}

struct PromptGridLayout: Equatable {
    /// The feed reads as one contact sheet: narrow gutters, works edge to edge.
    static let gap: CGFloat = 6
    static let inset: CGFloat = 16
    let columns: Int
    let widths: [CGFloat]
    let gaps: [CGFloat]
    static func measured(in proxy: GeometryProxy, inset: CGFloat = 0) -> Self {
        var division: CGRect?
        if #available(iOS 27.1, *) {
            division = proxy.reservedRegions(kind: .division).map(\.frame)
                .first { $0.height > $0.width && $0.minX > inset && $0.maxX < proxy.size.width - inset }
                .map { $0.offsetBy(dx: -inset, dy: 0) }
        }
        return Self(width: max(0, proxy.size.width - 2 * inset), division: division)
    }
    init(width: CGFloat, division: CGRect? = nil) {
        // Count depends on this grid's width, including in a narrow detail pane.
        // Even columns keep a card from straddling a vertical division region.
        let usableDivision = division.flatMap { region in
            region.minX >= 148 && width - region.maxX >= 148 ? region : nil
        }
        let roomForFour = usableDivision.map { min($0.minX, width - $0.maxX) >= 302 } ?? true
        let count = width >= 760 && roomForFour ? 4 : 2
        columns = count
        guard width > 0 else { widths = []; gaps = [Self.gap]; return }
        let half = count / 2
        if let division = usableDivision {
            let leading = max(0, (division.minX - 8 - CGFloat(half - 1) * Self.gap) / CGFloat(half))
            let trailing = max(0, (width - division.maxX - 8 - CGFloat(half - 1) * Self.gap) / CGFloat(half))
            widths = Array(repeating: leading, count: half) + Array(repeating: trailing, count: half)
            gaps = (0..<(count - 1)).map { $0 == half - 1 ? division.width + 16 : Self.gap }
        } else {
            widths = Array(repeating: max(0, (width - CGFloat(count - 1) * Self.gap) / CGFloat(count)), count: count)
            gaps = Array(repeating: Self.gap, count: count - 1)
        }
    }
}

enum PromptMasonry {
    /// Stable greedy placement: append each next item to the currently shortest
    /// column. Equal-height columns retain leading-to-trailing reading order.
    static func columns(itemCount: Int, widths: [CGFloat], spacing: CGFloat,
                        height: (Int, CGFloat) -> CGFloat) -> [[Int]] {
        guard !widths.isEmpty else { return [] }
        var result = Array(repeating: [Int](), count: widths.count)
        var bottoms = Array(repeating: CGFloat.zero, count: widths.count)
        for index in 0..<itemCount {
            let column = bottoms.indices.min { bottoms[$0] < bottoms[$1] }!
            result[column].append(index)
            bottoms[column] += height(index, widths[column]) + spacing
        }
        return result
    }
}

enum PromptCardGeometry {
    static let cornerRadius: CGFloat = 12
    static func aspectRatio(for item: Prompt) -> CGFloat { aspectRatio(for: ContentPreview(item)) }
    static func aspectRatio(for item: ContentPreview) -> CGFloat {
        // Text cards hold up to four lines of their words, so their shape follows the text.
        if item.usesTextArtwork { return textCardRatio(item) }
        // Retain common portrait and widescreen shapes. Only extreme ratios crop.
        if let ratio = item.media?.aspectRatio { return max(0.65, min(1.8, ratio)) }
        return switch item.kind { case .text: 0.95; case .image: item.artwork == "lake" ? 1.02 : 0.76; case .video: 0.94; case .web: 0.87 }
    }
    /// Cards carry only the work, so a card is exactly its preview; search results
    /// add one line of title beneath visual works.
    static let titleSpacing: CGFloat = 6
    /// The mono lead and the line under a text card's title. The line is the
    /// work's own summary, left out when it only repeats the title.
    static func textNote(_ item: ContentPreview) -> (lead: String, summary: String) {
        let summary = item.displaySummary.trimmingCharacters(in: .whitespacesAndNewlines)
        return (item.detailMeta.lead, summary == item.displayTitle ? "" : summary)
    }
    /// Estimated at a nominal 180 pt column with 14 pt insets: the opening mark,
    /// up to three 18 pt title lines, three 12.5 pt summary lines and the model.
    static func textCardRatio(_ item: ContentPreview) -> CGFloat {
        func lines(_ text: String, perLine: Double, limit: Double) -> Double {
            let units = text.unicodeScalars.reduce(0.0) { sum, scalar in sum + (scalar.value > 0x2E80 ? 1 : 0.55) }
            return text.isEmpty ? 0 : min(limit, max(1, (units / perLine).rounded(.up)))
        }
        let note = textNote(item)
        let title = lines(item.displayTitle, perLine: 8.4, limit: 3), summary = lines(note.summary, perLine: 11.8, limit: 3)
        let height = 12 + 24 + 4 + title * 25.5 + (summary > 0 ? 8 + summary * 18.5 : 0) + (note.lead.isEmpty ? 0 : 24) + 16
        return 180 / height
    }
    static func height(for item: ContentPreview, width: CGFloat, titled: Bool = false) -> CGFloat {
        width / aspectRatio(for: item) + (titled && !item.usesTextArtwork ? titleSpacing + ceil(UIFont.preferredFont(forTextStyle: .subheadline).lineHeight) : 0)
    }
}

struct PromptCard: View {
    let item: Prompt
    var origin: PromptDetailOrigin = .catalog
    @Environment(Library.self) private var library
    @Environment(\.colorScheme) private var colorScheme
    @State private var detailPresented = false
    @State private var savedFeedback = false
    @State private var copiedFeedback = false
    @Namespace private var transition
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { detailPresented = true } label: {
                PromptCardFace(preview: ContentPreview(item)).promptTransitionSource(id: item.id, in: transition)
            }.buttonStyle(.cardPress).accessibilityLabel(item.displayTitle).accessibilityIdentifier("prompt-\(item.id)")
                .contextMenu {
                    Button {
                        UIPasteboard.general.string = item.displayContent.prompt
                        copiedFeedback.toggle()
                    } label: { Label { Text(String(localized: "复制 Prompt")) } icon: { PrompixIcon.copy.image } }
                    Button {
                        if library.toggle(item) { savedFeedback.toggle() }
                    } label: { Label(library.isSaved(item) ? String(localized: "取消收藏") : String(localized: "收藏 Prompt"), systemImage: library.isSaved(item) ? "bookmark.slash" : "bookmark") }
                } preview: { WorkPeek(preview: ContentPreview(item), title: item.displayTitle, text: item.displayContent.prompt) }
                .sensoryFeedback(.success, trigger: copiedFeedback)
                .sensoryFeedback(.selection, trigger: savedFeedback)
            if typeSize.isAccessibilitySize || voiceOverEnabled {
                HStack(spacing: 4) {
                if let creator = item.creator {
                    NavigationLink { CreatorDetail(creator: creator) } label: {
                        HStack(spacing: 5) {
                            CreatorAvatar(creator: creator, size: 18).accessibilityHidden(true)
                            Text(creator.displayName).font(.caption).lineLimit(1)
                        }.frame(minHeight: 44).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel(creator.displayName)
                } else if titleIsInArtwork {
                    Text(item.source.author ?? item.source.name).font(.caption).lineLimit(1)
                } else {
                    Image(systemName: item.displaySymbol).font(.system(size: 10)).accessibilityHidden(true)
                    Text(item.displayKind).font(.footnote)
                }
                    Spacer(minLength: 0)
                }.foregroundStyle(Palette.muted).padding(.leading, 2)
            }
        }
        .fullScreenCover(isPresented: $detailPresented) {
            PromptReadingPresentation(item: item, origin: origin)
                // Pin the presenting appearance through UIKit's zoom snapshots.
                .preferredColorScheme(colorScheme)
                .promptTransitionDestination(id: item.id, in: transition)
        }
    }
    private var titleIsInArtwork: Bool { item.kind == .text }
    private var ratio: CGFloat { PromptCardGeometry.aspectRatio(for: item) }

}

/// Reading covers the tab hierarchy without changing its visibility. The
/// original tab bar is already in place beneath an interactive dismissal.
private struct PromptReadingPresentation: View {
    let item: Prompt
    let origin: PromptDetailOrigin
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            PromptDetail(item: item, origin: origin)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { dismiss() } label: {
                            PrompixIcon.back.image.frame(minWidth: 44, minHeight: 44)
                        }.accessibilityLabel(String(localized: "返回列表"))
                            .accessibilityIdentifier("closePromptDetail")
                    }
                }
        }.tint(Palette.accent)
    }
}

struct FavoritesView: View {
    @Environment(Library.self) private var library
    @State private var scope = SavedScope.decks
    @State private var settingsPresented = false
    @State private var namingDeck = false
    var body: some View {
        NavigationStack {
            ScrollView {
                Group {
                    switch scope {
                    case .creators: SavedCreators(query: "")
                    case .drafts: draftedContent
                    case .decks: if library.favorites.isEmpty && library.favoritesReadable && library.decks.decks.isEmpty { SavedEmpty() } else { DeckGrid { namingDeck = true } }
                    }
                }.padding(.top, 8).padding(.bottom, 24)
            }
            .background(Palette.paper).foregroundStyle(Palette.ink)
            .rootHeader(title: String(localized: "收藏")) {
                // Settings keeps its corner; the deck button appears beside it without moving it.
                HStack(spacing: 8) {
                    if scope == .decks {
                        Button { namingDeck = true } label: { PrompixIcon.plus.image.frame(width: 44, height: 44) }
                            .disabled(!library.decks.readable).accessibilityLabel(String(localized: "新建卡组")).accessibilityIdentifier("newDeck")
                    }
                    Button { settingsPresented = true } label: { PrompixIcon.person.image.frame(width: 44, height: 44) }
                        .accessibilityLabel(String(localized: "设置")).accessibilityIdentifier("savedSettings")
                }
            } bar: {
                Picker(String(localized: "收藏"), selection: $scope) {
                    Text(String(localized: "卡组")).tag(SavedScope.decks)
                    Text(String(localized: "创作者")).tag(SavedScope.creators)
                    Text(String(localized: "我的版本")).tag(SavedScope.drafts)
                }.pickerStyle(.segmented).padding(.horizontal, 20).padding(.bottom, 8)
                    .accessibilityIdentifier("savedScope")
            }
            .sheet(isPresented: $settingsPresented) { SettingsView().promptSheet() }
            .deckNamePrompt(isPresented: $namingDeck) { library.decks.create(named: $0) }
        }
    }
    @ViewBuilder private var draftedContent: some View {
        let drafted = library.draftedIDs, kept = library.versionedWorks
        let keptIDs = Set(kept.map(\.id))
        // Drafts saved before versions kept no copy of their work; find those in the catalog or saved works.
        let earlier = (library.favorites + library.prompts).filter { drafted.contains($0.id) && !keptIDs.contains($0.id) }
        var seen = Set<String>()
        let items = (kept + earlier).filter { seen.insert($0.id).inserted }
        if items.isEmpty {
            QuietEmpty(title: String(localized: "还没有自己的版本"), message: String(localized: "在详情页点铅笔，就能基于任意 Prompt 写自己的版本。"))
        } else { PromptGrid(items: items, origin: .favorite).padding(.horizontal, PromptGridLayout.inset).environment(\.cardShowsTitle, true) }
    }
}

/// Nothing saved yet: six empty frames waiting to develop.
private struct SavedEmpty: View {
    var body: some View {
        VStack(spacing: 22) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 3), spacing: 8) {
                ForEach(1...6, id: \.self) { index in
                    RoundedRectangle(cornerRadius: 5).fill(Palette.surface)
                        .overlay { RoundedRectangle(cornerRadius: 5).strokeBorder(Palette.line, lineWidth: 0.5) }
                        .overlay(alignment: .bottomLeading) {
                            Text(String(format: "%02d", index)).font(Typography.meta(size: 9)).tracking(1).foregroundStyle(Palette.muted).padding(6)
                        }.frame(height: 96)
                }
            }.padding(12).background(Palette.soft.opacity(0.5), in: RoundedRectangle(cornerRadius: 16))
                .frame(maxWidth: 290).accessibilityHidden(true)
            VStack(spacing: 8) {
                Text(String(localized: "还没有收藏")).font(.title3.weight(.semibold))
                Text(String(localized: "长按任何作品，或者点详情页右上角的书签，收藏的作品会一格一格显影在这里。"))
                    .font(.subheadline).foregroundStyle(Palette.muted).multilineTextAlignment(.center).lineSpacing(4)
            }
        }.padding(.horizontal, 56).padding(.top, 40).frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine).accessibilityIdentifier("savedEmpty")
    }
}

private enum SavedScope { case decks, creators, drafts }

/// Every saved work first, then the decks you made, then room for one more.
private struct DeckGrid: View {
    let newDeck: () -> Void
    @Environment(Library.self) private var library
    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 20) {
            NavigationLink { DeckDetail(deckID: nil) } label: {
                DeckTile(name: String(localized: "全部收藏"), items: library.favorites)
            }.buttonStyle(.cardPress).accessibilityIdentifier("deck-all")
            ForEach(library.decks.decks) { deck in
                NavigationLink { DeckDetail(deckID: deck.id) } label: {
                    DeckTile(name: deck.name, items: DeckDetail.items(deck.itemIDs, in: library))
                }.buttonStyle(.cardPress).accessibilityIdentifier("deck-\(deck.id)")
            }
            if library.decks.readable {
                Button(action: newDeck) {
                    VStack(alignment: .leading, spacing: 8) {
                        RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Palette.line, lineWidth: 1)
                            .aspectRatio(DeckTile.coverRatio, contentMode: .fit)
                            .overlay { PrompixIcon.plus.image(size: 24).foregroundStyle(Palette.muted) }
                        Text(String(localized: "新建卡组")).font(.subheadline).foregroundStyle(Palette.muted)
                    }.contentShape(Rectangle())
                }.buttonStyle(.cardPress).accessibilityLabel(String(localized: "新建卡组")).accessibilityIdentifier("newDeckTile")
            }
        }.padding(.horizontal, PromptGridLayout.inset)
    }
}

private struct DeckTile: View {
    static let coverRatio: CGFloat = 1.2
    let name: String
    let items: [Prompt]
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Color.clear.aspectRatio(Self.coverRatio, contentMode: .fit).overlay { cover }
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            HStack(alignment: .firstTextBaseline) {
                Text(name).font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer(minLength: 4)
                Text(items.count.formatted()).font(Typography.meta(size: 11)).foregroundStyle(Palette.muted)
            }
        }.foregroundStyle(Palette.ink).contentShape(Rectangle())
            .accessibilityElement(children: .ignore).accessibilityLabel(name).accessibilityValue(String(localized: "\(items.count) 张"))
    }
    /// A contact sheet of the latest works that never leaves a blank cell:
    /// one fills the cover, two sit side by side, three put one beside a pair,
    /// four or more make a 2×2 grid.
    @ViewBuilder private var cover: some View {
        let shown = Array(items.prefix(4))
        switch shown.count {
        case 0: Palette.surface
        case 1: cell(shown[0])
        case 2: HStack(spacing: 2) { cell(shown[0]); cell(shown[1]) }
        case 3: HStack(spacing: 2) { cell(shown[0]); VStack(spacing: 2) { cell(shown[1]); cell(shown[2]) } }
        default:
            VStack(spacing: 2) {
                HStack(spacing: 2) { cell(shown[0]); cell(shown[1]) }
                HStack(spacing: 2) { cell(shown[2]); cell(shown[3]) }
            }
        }
    }
    private func cell(_ item: Prompt) -> some View {
        Artwork(item: item, compact: true, fillsFrame: true).frame(maxWidth: .infinity, maxHeight: .infinity).clipped()
    }
}

/// One deck as a contact sheet. `nil` shows every saved work.
private struct DeckDetail: View {
    let deckID: String?
    @Environment(Library.self) private var library
    @Environment(\.dismiss) private var dismiss
    @State private var renaming = false
    @State private var confirmsDelete = false
    static func items(_ ids: [String], in library: Library) -> [Prompt] {
        let saved = Dictionary(library.favorites.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return ids.compactMap { saved[$0] }
    }
    private var deck: Deck? { deckID.flatMap { id in library.decks.decks.first { $0.id == id } } }
    private var items: [Prompt] { deck.map { Self.items($0.itemIDs, in: library) } ?? library.favorites }
    @State private var kind: PromptKind?
    @State private var images = ImageStore.shared
    private var kinds: [(PromptKind, Int)] {
        [PromptKind.image, .video, .text].compactMap { value in
            let count = items.filter { $0.kind == value }.count
            return count > 0 ? (value, count) : nil
        }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(String(localized: "卡组 ▸ \(items.count) 张")).font(.footnote).monospacedDigit().foregroundStyle(Palette.muted)
                    Text(deck?.name ?? String(localized: "全部收藏")).font(.system(size: 30, weight: .bold)).accessibilityAddTraits(.isHeader)
                }.padding(.horizontal, 20)
                if kinds.count > 1 {
                    ChipRow(values: [nil] + kinds.map { Optional($0.0) }, selection: $kind) { value in
                        guard let value else { return String(localized: "全部") }
                        return "\(value.title) \(kinds.first { $0.0 == value }?.1 ?? 0)"
                    }
                }
                if deckID == nil, !images.offlineFailures.isEmpty {
                    Button { Task { if let urls = library.savedImageURLs { await images.keepOffline(urls) } } } label: {
                        Label(String(localized: "部分收藏预览尚未下载，轻点重试"), systemImage: "arrow.down.circle")
                            .font(.footnote).foregroundStyle(Palette.muted)
                    }.padding(.horizontal, 20)
                }
                if items.isEmpty {
                    QuietEmpty(title: String(localized: "卡组里还没有作品"), message: String(localized: "在详情页点书签，选这个卡组即可加入。"))
                }
                // A deck reads as a contact sheet: three equal squares per row.
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 3), spacing: 4) {
                    ForEach(items.filter { kind == nil || $0.kind == kind }) { item in PromptCard(item: item, origin: .favorite) }
                }.environment(\.cardAspectRatio, 1).padding(.horizontal, PromptGridLayout.inset)
            }.padding(.bottom, 24)
        }
        .background(Palette.paper).foregroundStyle(Palette.ink)
        .toolbar {
            if let deck {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { renaming = true } label: { Label(String(localized: "重命名"), systemImage: "pencil") }
                        Button(role: .destructive) { confirmsDelete = true } label: { Label(String(localized: "删除卡组"), systemImage: "trash") }
                    } label: { PrompixIcon.more.image.frame(minWidth: 44, minHeight: 44) }
                        .accessibilityLabel(deck.name).accessibilityIdentifier("deckActions")
                }
            }
        }
        .deckNamePrompt(isPresented: $renaming, initial: deck?.name ?? "") { name in
            guard let deckID else { return nil }
            return library.decks.rename(deckID, to: name) ? deck : nil
        }
        .confirmationDialog(String(localized: "删除卡组"), isPresented: $confirmsDelete) {
            Button(String(localized: "删除卡组"), role: .destructive) {
                if let deckID, library.decks.delete(deckID) { dismiss() }
            }
        } message: { Text(String(localized: "卡组里的作品仍会留在全部收藏。")) }
    }
}

/// "收藏到": every saved work is always in 全部收藏; decks are optional extras.
struct DeckPicker: View {
    let item: Prompt
    @Environment(Library.self) private var library
    @Environment(\.dismiss) private var dismiss
    @State private var naming = false
    var body: some View {
        NavigationStack {
            List {
                Label(String(localized: "全部收藏"), systemImage: "checkmark.circle.fill")
                    .foregroundStyle(Palette.muted).accessibilityAddTraits(.isSelected)
                ForEach(library.decks.decks) { deck in
                    let member = deck.itemIDs.contains(item.id)
                    Button { library.decks.set(item.id, in: deck.id, member: !member) } label: {
                        HStack {
                            Image(systemName: member ? "checkmark.circle.fill" : "circle").foregroundStyle(member ? Palette.accent : Palette.muted)
                            Text(deck.name).foregroundStyle(Palette.ink)
                            Spacer()
                            Text(deck.itemIDs.count.formatted()).font(Typography.meta(size: 12)).foregroundStyle(Palette.muted)
                        }.frame(minHeight: 44).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityAddTraits(member ? .isSelected : []).accessibilityIdentifier("pickDeck-\(deck.id)")
                }
                Button { naming = true } label: { Label(String(localized: "新建卡组"), systemImage: "plus") }
                    .disabled(!library.decks.readable).accessibilityIdentifier("pickerNewDeck")
                Section {
                    Button(String(localized: "取消收藏"), role: .destructive) { if library.toggle(item) { dismiss() } }
                        .accessibilityIdentifier("pickerUnsave")
                }
            }
            .scrollContentBackground(.hidden).background(Palette.paper)
            .navigationTitle(String(localized: "收藏到")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { dismiss() }.accessibilityIdentifier("pickerDone") } }
            .deckNamePrompt(isPresented: $naming) { name in
                guard let deck = library.decks.create(named: name) else { return nil }
                library.decks.set(item.id, in: deck.id, member: true)
                return deck
            }
        }
        .presentationDetents([.medium, .large]).tint(Palette.accent)
    }
}

private struct DeckNamePrompt: ViewModifier {
    @Binding var isPresented: Bool
    let initial: String
    let commit: (String) -> Deck?
    @State private var name = ""
    func body(content: Content) -> some View {
        content.alert(initial.isEmpty ? String(localized: "新建卡组") : String(localized: "重命名"), isPresented: $isPresented) {
            TextField(String(localized: "卡组名称"), text: $name).accessibilityIdentifier("deckName")
            Button(String(localized: "取消"), role: .cancel) { }
            Button(initial.isEmpty ? String(localized: "创建") : String(localized: "完成")) { _ = commit(name) }
                .disabled(DeckStore.cleanName(name) == nil)
        }
        .onChange(of: isPresented) { _, shown in if shown { name = initial } }
    }
}

extension View {
    func deckNamePrompt(isPresented: Binding<Bool>, initial: String = "", commit: @escaping (String) -> Deck?) -> some View {
        modifier(DeckNamePrompt(isPresented: isPresented, initial: initial, commit: commit))
    }
}
