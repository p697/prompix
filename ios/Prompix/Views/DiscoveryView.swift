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
                    Label { Text(String(localized: "发现")) } icon: { TabSymbol.image("safari") }
                }
                Tab(value: MainTab.saved) { FavoritesView() } label: {
                    Label { Text(String(localized: "收藏")) } icon: { TabSymbol.image("heart") }
                }
                if #available(iOS 27, *) {
                    Tab(String(localized: "搜索"), systemImage: "magnifyingglass", value: MainTab.search, role: .prominent) { search }
                } else {
                    Tab(value: MainTab.search, role: .search) { search }
                }
            }
            .autocorrectionDisabled().textInputAutocapitalization(.never)
            .minimizesTabBarOnScroll()
        } else {
            TabView(selection: selection) {
                DiscoverView().tag(MainTab.discover)
                    .tabItem { Label { Text(String(localized: "发现")) } icon: { TabSymbol.image("safari") } }
                FavoritesView().tag(MainTab.saved)
                    .tabItem { Label { Text(String(localized: "收藏")) } icon: { TabSymbol.image("heart") } }
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
    @State private var skillsOnly = false
    @State private var topic: String?
    @State private var feedSort = "recommended"
    @Environment(\.recommendationSurfaceVisible) private var recommendationSurfaceVisible
    @State private var appliedPreferenceRevision = 0
    @State private var model: String?
    @State private var facet: String?
    @State private var modelFamily: String?
    @State private var inputs: String?
    @State private var chromeCollapsed = false
    @State private var headerHeight: CGFloat = 112
    @State private var viewportHeight: CGFloat = 0
    @State private var feedLayout = PromptGridLayout(width: 0)
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let topics = ["好玩一点", "创作灵感", "日常有用"]
    private var items: [Prompt] {
        library.prompts.filter {
            PromptQuery(kind: kind, topic: topic, model: model, skillsOnly: skillsOnly).matches($0) &&
                (feedSort != "recommended" || library.recommendations.allowsRecommended($0))
        }
    }
    private var feedQuery: FeedQuery {
        FeedQuery(kind: skillsOnly ? "skill" : kind?.rawValue, tag: topic, model: model, sort: feedSort, facet: facet, inputs: inputs, modelFamily: modelFamily)
    }
    private var models: [String] {
        if let feed = library.feed { return feed.browse.value?.models.map(\.name) ?? [] }
        return Array(Set(library.prompts.filter { PromptQuery(kind: kind, skillsOnly: skillsOnly).matches($0) }.map(\.model))).sorted()
    }
    private var isFiltered: Bool { kind != nil || skillsOnly || refined }
    private var refined: Bool { topic != nil || model != nil || facet != nil || modelFamily != nil || inputs != nil }
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
                            if skillsOnly {
                                Text(String(localized: "可在支持 Agent Skills 的工具中使用，包含完整说明与源文件；具体依赖请查看详情。"))
                                    .font(.subheadline).foregroundStyle(Palette.muted).padding(.horizontal, 20)
                            }
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
                                        Button(String(localized: "查看其他内容")) { kind = nil; skillsOnly = false; topic = nil; model = nil }
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
                // The bar's height leaves when it collapses; this margin takes its
                // place so the scroll view's total inset, and the reader, never move.
                .contentMargins(.top, chromeCollapsed ? headerHeight : 0, for: .scrollContent)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewportHeight = $0 }
                .onGeometryChange(for: PromptGridLayout.self) { proxy in
                    PromptGridLayout.measured(in: proxy, inset: PromptGridLayout.inset)
                } action: { if !$0.widths.isEmpty { feedLayout = $0 } }
                .scrollClipDisabled()
                .background(Palette.paper).foregroundStyle(Palette.ink)
                .readingChrome($chromeCollapsed)
                .rootHeaderBar { discoveryChrome }
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
                        chromeCollapsed = false
                        scroll.scrollTo("discovery-top", anchor: .top)
                    }
                }
            }
            .toolbar(.hidden, for: .navigationBar)
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
    private func selectKind(_ next: PromptKind?, _ skills: Bool) {
        kind = next; skillsOnly = skills; topic = nil; model = nil; facet = nil; modelFamily = nil; inputs = nil
        library.feed?.discovery.select(feedQuery)
    }
    // The bar itself shrinks, so the edge effect retreats to the status bar
    // instead of veiling cards beneath an empty header.
    private var discoveryChrome: some View {
        discoveryHeader.fixedSize(horizontal: false, vertical: true)
            .animation(reduceMotion ? nil : Motion.chrome) {
                $0.offset(y: chromeCollapsed ? -headerHeight : 0).opacity(chromeCollapsed ? 0 : 1)
            }
            .frame(height: chromeCollapsed ? 0 : nil, alignment: .top)
            .allowsHitTesting(!chromeCollapsed)
            .accessibilityHidden(chromeCollapsed)
    }
    private var discoveryHeader: some View {
        VStack(spacing: 4) {
            RootPageHeader(title: String(localized: "发现"), titleID: "discoveryHeading") { filterMenu }
            KindPicker(selection: $kind, skillsOnly: $skillsOnly, onSelect: selectKind)
        }.foregroundStyle(Palette.ink).padding(.bottom, 4)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { headerHeight = $0 }
            .accessibilityElement(children: .contain).accessibilityIdentifier("discoveryHeader")
    }
    private var discoveryContext: some View {
        HStack(alignment: .center) {
            Text(skillsOnly ? String(localized: "Agent Skills") : isFiltered ? String(localized: "筛选结果") : feedSort == "latest" ? String(localized: "最新收录") : String(localized: "为你挑的"))
                .font(.subheadline.weight(.semibold))
            Spacer()
            if isFiltered {
                Button(String(localized: "清除筛选")) { selectKind(nil, false) }
                    .font(.footnote).foregroundStyle(Palette.muted).frame(minHeight: 44)
            }
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
                Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
            }.foregroundStyle(Palette.muted).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
        }.accessibilityLabel(String(localized: "排序")).accessibilityIdentifier("discoverySort")
    }
    private var filterMenu: some View {
        Menu {
            if let browse = library.feed?.browse.value, let uses = browse.facets?.useCase, !uses.isEmpty {
                servedFilters(uses: uses, families: browse.modelFamilies ?? [])
            } else { catalogFilters }
        } label: {
            Image(systemName: "line.3.horizontal.decrease").frame(width: 44, height: 44)
                .overlay(alignment: .topTrailing) {
                    if refined { Circle().fill(Palette.accent).frame(width: 7, height: 7).padding(9) }
                }
        }.accessibilityLabel(String(localized: "筛选")).accessibilityValue(refined ? String(localized: "已筛选") : "")
            .accessibilityIdentifier("discoveryFilters")
    }
    /// 2.0 filters from the service's own counts: use, model family and reference needs.
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
        Menu(String(localized: "参考图")) {
            choice(String(localized: "不限"), selected: inputs == nil) { inputs = nil }
            choice(String(localized: "不需要上传"), selected: inputs == "none") { inputs = "none" }
            choice(String(localized: "可以用我的照片"), selected: inputs == "optional") { inputs = "optional" }
            choice(String(localized: "需要上传"), selected: inputs == "required") { inputs = "required" }
        }.accessibilityIdentifier("filterInputs")
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
                        column(columns[index]).frame(width: layout.widths.isEmpty ? nil : layout.widths[index])
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
    private var balancedColumns: [[Int]] {
        let widths = layout.widths.isEmpty ? Array(repeating: CGFloat(180), count: layout.columns) : layout.widths
        return PromptMasonry.columns(itemCount: items.count, widths: widths, spacing: PromptGridLayout.gap) { index, width in
            PromptCardGeometry.height(for: preview(items[index]), width: width, titled: titled)
        }
    }
    private func column(_ indices: [Int]) -> some View {
        LazyVStack(spacing: PromptGridLayout.gap) {
            ForEach(indices.map { items[$0] }) { item in
                cell(item)
            }
        }.frame(maxWidth: .infinity)
    }
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
        // Text cards are a short quote, a little wider than tall.
        if item.usesTextArtwork { return 1.2 }
        // Retain common portrait and widescreen shapes. Only extreme ratios crop.
        if let ratio = item.media?.aspectRatio { return max(0.65, min(1.8, ratio)) }
        return switch item.kind { case .text: 0.95; case .image: item.artwork == "lake" ? 1.02 : 0.76; case .video: 0.94; case .web: WebsiteExamples.files[item.id] != nil ? 0.62 : 0.87 }
    }
    /// Cards carry only the work, so a card is exactly its preview; search results
    /// add one line of title beneath visual works.
    static let titleSpacing: CGFloat = 6
    static func height(for item: ContentPreview, width: CGFloat, titled: Bool = false) -> CGFloat {
        width / aspectRatio(for: item) + (titled && !item.usesTextArtwork ? titleSpacing + ceil(UIFont.preferredFont(forTextStyle: .footnote).lineHeight) : 0)
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
                    } label: { Label(item.isSkill ? String(localized: "复制 Skill") : String(localized: "复制 Prompt"), systemImage: "doc.on.doc") }
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
    private var titleIsInArtwork: Bool { item.isSkill || item.kind == .text }
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
                            Image(systemName: "chevron.left").frame(minWidth: 44, minHeight: 44)
                        }.accessibilityLabel(String(localized: "返回列表"))
                            .accessibilityIdentifier("closePromptDetail")
                    }
                }
        }.tint(Palette.accent)
    }
}

struct FavoritesView: View {
    @Environment(Library.self) private var library
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var kind: PromptKind?
    @State private var skillsOnly = false
    @State private var query = ""
    @State private var images = ImageStore.shared
    @State private var scope = SavedScope.decks
    @State private var settingsPresented = false
    @State private var namingDeck = false
    @Namespace private var scopeLine
    @ScaledMetric(relativeTo: .body) private var searchHeight = 48
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if !showsDeckGrid { SavedSearchField(text: $query).frame(height: searchHeight).padding(.horizontal, 12) }
                    Group {
                        if typeSize.isAccessibilitySize {
                            VStack(alignment: .leading, spacing: 8) {
                                savedScopes
                                scopeActions
                            }
                        } else {
                            HStack(spacing: 16) { savedScopes; scopeActions }
                        }
                    }.padding(.horizontal, 20)
                    switch scope {
                    case .creators: SavedCreators(query: query)
                    case .drafts: draftedContent
                    case .decks: if showsDeckGrid { DeckGrid() } else { savedContent }
                    }
                }.padding(.top, 2).padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Palette.paper).foregroundStyle(Palette.ink)
            .rootHeaderBar {
                RootPageHeader(title: String(localized: "收藏")) {
                    Button { settingsPresented = true } label: { Image(systemName: "gearshape").frame(width: 44, height: 44) }
                        .accessibilityLabel(String(localized: "设置")).accessibilityIdentifier("savedSettings")
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $settingsPresented) { SettingsView().promptSheet() }
            .deckNamePrompt(isPresented: $namingDeck) { library.decks.create(named: $0) }
        }
    }
    /// Without decks of your own, the deck scope opens straight onto every saved work.
    private var showsDeckGrid: Bool { scope == .decks && !library.decks.decks.isEmpty }
    @ViewBuilder private var scopeActions: some View {
        if scope == .decks {
            if !showsDeckGrid { kindMenu }
            Spacer(minLength: 0)
            Button { namingDeck = true } label: { Image(systemName: "plus").frame(width: 44, height: 44) }
                .disabled(!library.decks.readable).accessibilityLabel(String(localized: "新建卡组")).accessibilityIdentifier("newDeck")
        } else if scope == .drafts { kindMenu }
    }
    private var savedScopes: some View {
        HStack(spacing: 20) {
            savedScope(.decks, title: String(localized: "卡组"), count: library.favorites.count, id: "savedPromptsScope")
            savedScope(.creators, title: String(localized: "创作者"), count: library.savedCreators.count, id: "savedCreatorsScope")
            savedScope(.drafts, title: String(localized: "我的改写"), count: nil, id: "savedDraftsScope")
        }
    }
    private func savedScope(_ value: SavedScope, title: String, count: Int?, id: String) -> some View {
        let selected = scope == value
        return Button { withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) { scope = value } } label: {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(title).font(.headline)
                if let count { Text(count.formatted()).font(.caption.monospacedDigit()).fixedSize().foregroundStyle(Palette.muted) }
            }.foregroundStyle(selected ? Palette.ink : Palette.muted)
                .frame(minHeight: 48).contentShape(Rectangle())
                .overlay(alignment: .bottom) {
                    if selected {
                        Capsule().fill(Palette.accent).frame(height: 2).matchedGeometryEffect(id: "saved-scope", in: scopeLine)
                    }
                }
        }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
            .accessibilityIdentifier(id)
    }
    @ViewBuilder private var draftedContent: some View {
        let drafted = library.draftedIDs
        let candidates = library.favorites + library.prompts.filter { !library.savedIDs.contains($0.id) }
        let items = candidates.filter { drafted.contains($0.id) && PromptQuery(text: query, kind: kind, skillsOnly: skillsOnly).matches($0) }
        if items.isEmpty {
            ContentUnavailableView(String(localized: "还没有改写过的 Prompt"), systemImage: "square.and.pencil",
                                   description: Text(String(localized: "在详情页改写并保存后，会集中出现在这里。")))
        } else { PromptGrid(items: items, origin: .favorite).padding(.horizontal, PromptGridLayout.inset) }
    }
    private var kindMenu: some View {
        Menu {
            Button(String(localized: "全部")) { kind = nil; skillsOnly = false }
            ForEach(PromptKind.allCases) { value in
                Button(value.title) { kind = value; skillsOnly = false }
            }
            Button("Skills") { kind = nil; skillsOnly = true }
        } label: {
            HStack(spacing: 5) {
                Text(skillsOnly ? "Skills" : kind?.title ?? String(localized: "全部"))
                Image(systemName: "chevron.down").font(.caption2)
            }.font(.subheadline).foregroundStyle(Palette.muted).frame(minHeight: 44)
        }.accessibilityIdentifier("savedKindFilter")
    }
    @ViewBuilder private var savedContent: some View {
        if !images.offlineFailures.isEmpty {
            Button { Task { if let urls = library.savedImageURLs { await images.keepOffline(urls) } } } label: {
                Label(String(localized: "部分收藏预览尚未下载，轻点重试"), systemImage: "arrow.down.circle")
                    .font(.footnote).foregroundStyle(Palette.muted)
            }.padding(.horizontal, 20)
        }
        let items = library.favorites.filter { PromptQuery(text: query, kind: kind, skillsOnly: skillsOnly).matches($0) }
        if !library.favoritesReadable {
            ContentUnavailableView {
                Label(String(localized: "收藏暂时无法读取"), systemImage: "bookmark.slash")
            } description: { Text(String(localized: "原文件和离线预览已保留，暂时不会覆盖你的收藏。")) }
            actions: { Button(String(localized: "重新读取收藏")) { library.reloadFavorites() }.buttonStyle(.bordered) }
        } else if items.isEmpty {
            if !query.isEmpty { ContentUnavailableView.search(text: query) }
            else if !library.favorites.isEmpty {
                ContentUnavailableView(String(localized: "暂无匹配内容"), systemImage: "bookmark", description: Text(String(localized: "试试其他分类，或清除筛选条件。")))
            } else {
                VStack(spacing: 18) {
                    SpectralPages(openness: 0.7, compact: true).frame(width: 112, height: 112)
                    Text(String(localized: "暂无收藏")).font(.title3.weight(.medium))
                    Text(String(localized: "在详情页收藏喜欢的内容，也可以长按卡片收藏。"))
                        .font(.subheadline).foregroundStyle(Palette.muted).multilineTextAlignment(.center).lineSpacing(4)
                }.padding(.horizontal, 48).padding(.vertical, 50).frame(maxWidth: .infinity)
            }
        } else { PromptGrid(items: items, origin: .favorite).padding(.horizontal, PromptGridLayout.inset) }
    }
}

/// Identical placement, material, tint and hit area across the two root pages.
struct RootPageHeader<Trailing: View>: View {
    let title: String
    var titleID = ""
    @ViewBuilder let trailing: Trailing
    var body: some View {
        HStack {
            Text(title).font(.largeTitle.bold()).accessibilityAddTraits(.isHeader).accessibilityIdentifier(titleID)
            Spacer()
            trailing.font(.title3).buttonStyle(.plain).readingGlass()
        }.foregroundStyle(Palette.ink).padding(.leading, 20).padding(.trailing, 16).padding(.vertical, 6)
    }
}

/// UISearchBar retains native clear, keyboard and accessibility behavior without
/// reserving a navigation drawer above this compact collection layout.
private struct SavedSearchField: UIViewRepresentable {
    @Binding var text: String
    func makeUIView(context: Context) -> UISearchBar {
        let bar = UISearchBar()
        bar.searchBarStyle = .minimal
        bar.placeholder = String(localized: "搜索收藏")
        bar.delegate = context.coordinator
        bar.autocapitalizationType = .none
        bar.autocorrectionType = .no
        bar.searchTextField.font = .preferredFont(forTextStyle: .subheadline)
        bar.searchTextField.adjustsFontForContentSizeCategory = true
        return bar
    }
    func updateUIView(_ bar: UISearchBar, context: Context) {
        context.coordinator.parent = self
        if bar.text != text { bar.text = text }
        bar.tintColor = UIColor(Palette.accent)
    }
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    final class Coordinator: NSObject, UISearchBarDelegate {
        var parent: SavedSearchField
        init(_ parent: SavedSearchField) { self.parent = parent }
        func searchBar(_ searchBar: UISearchBar, textDidChange searchText: String) { parent.text = searchText }
        func searchBarSearchButtonClicked(_ searchBar: UISearchBar) { searchBar.resignFirstResponder() }
    }
}

private enum SavedScope { case decks, creators, drafts }

/// Every saved work first, then the decks you made. Covers are a 2×2 contact sheet.
private struct DeckGrid: View {
    @Environment(Library.self) private var library
    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 18) {
            NavigationLink { DeckDetail(deckID: nil) } label: {
                DeckTile(name: String(localized: "全部收藏"), items: library.favorites)
            }.buttonStyle(.cardPress).accessibilityIdentifier("deck-all")
            ForEach(library.decks.decks) { deck in
                NavigationLink { DeckDetail(deckID: deck.id) } label: {
                    DeckTile(name: deck.name, items: DeckDetail.items(deck.itemIDs, in: library))
                }.buttonStyle(.cardPress).accessibilityIdentifier("deck-\(deck.id)")
            }
        }.padding(.horizontal, PromptGridLayout.inset)
    }
}

private struct DeckTile: View {
    let name: String
    let items: [Prompt]
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Grid(horizontalSpacing: 2, verticalSpacing: 2) {
                ForEach(0..<2, id: \.self) { row in
                    GridRow {
                        ForEach(0..<2, id: \.self) { column in
                            let index = row * 2 + column
                            Group {
                                if index < items.count { Artwork(item: items[index], compact: true, fillsFrame: true) }
                                else { Palette.soft }
                            }.aspectRatio(1, contentMode: .fill).clipped()
                        }
                    }
                }
            }.clipShape(RoundedRectangle(cornerRadius: PromptCardGeometry.cornerRadius, style: .continuous))
            HStack(alignment: .firstTextBaseline) {
                Text(name).font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer(minLength: 4)
                Text(items.count.formatted()).font(Typography.meta(size: 11)).foregroundStyle(Palette.muted)
            }
        }.foregroundStyle(Palette.ink).contentShape(Rectangle())
            .accessibilityElement(children: .ignore).accessibilityLabel(name).accessibilityValue(String(localized: "\(items.count) 张"))
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
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(String(localized: "\(items.count) 张")).font(Typography.meta(size: 11)).tracking(1.2).foregroundStyle(Palette.muted)
                    Text(deck?.name ?? String(localized: "全部收藏")).font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
                }.padding(.horizontal, 20)
                PromptGrid(items: items, origin: .favorite).padding(.horizontal, PromptGridLayout.inset)
            }.padding(.bottom, 24)
        }
        .background(Palette.paper).foregroundStyle(Palette.ink)
        .toolbar {
            if let deck {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { renaming = true } label: { Label(String(localized: "重命名"), systemImage: "pencil") }
                        Button(role: .destructive) { confirmsDelete = true } label: { Label(String(localized: "删除卡组"), systemImage: "trash") }
                    } label: { Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44) }
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
