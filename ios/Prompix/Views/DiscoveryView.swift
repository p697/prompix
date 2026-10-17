import SwiftUI

private enum MainTab: Hashable { case discover, saved, search }

struct RootView: View {
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
        tabs.tint(Palette.accent)
            .environment(\.recommendationSurfaceVisible, !showsOnboarding)
            .fullScreenCover(isPresented: $showsOnboarding) {
                PrompixOnboarding {
                    UserDefaults.standard.set(true, forKey: "hasCompletedOnboarding")
                    showsOnboarding = false
                }.interactiveDismissDisabled()
            }
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
    @State private var settingsPresented = false
    @State private var chromeCollapsed = false
    @State private var headerHeight: CGFloat = 112
    @State private var viewportHeight: CGFloat = 0
    @State private var feedLayout = PromptGridLayout(width: 0)
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let topics = ["好玩一点", "创作灵感", "日常有用"]
    private var items: [Prompt] { library.prompts.filter { PromptQuery(kind: kind, topic: topic, model: model, skillsOnly: skillsOnly).matches($0) } }
    private var feedQuery: FeedQuery { FeedQuery(kind: skillsOnly ? "skill" : kind?.rawValue, tag: topic, model: model, sort: feedSort) }
    private var models: [String] {
        if let feed = library.feed { return feed.browse.value?.models.map(\.name) ?? [] }
        return Array(Set(library.prompts.filter { PromptQuery(kind: kind, skillsOnly: skillsOnly).matches($0) }.map(\.model))).sorted()
    }
    private var isFiltered: Bool { kind != nil || skillsOnly || topic != nil || model != nil }
    private var needsFirstVideoUpdate: Bool {
        kind == .video && library.version.hasPrefix("studio-") && !library.prompts.contains { $0.kind == .video }
    }
    var body: some View {
        NavigationStack {
            ZStack(alignment: .top) {
                ScrollViewReader { scroll in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 14) {
                            Group {
                                if !isFiltered {
                                    CreatorRail()
                                    CollectionRail(query: feedQuery).padding(.bottom, 6)
                                }
                                discoveryContext
                                if skillsOnly {
                                    Text(String(localized: "可在支持 Agent Skills 的工具中使用，包含完整说明与源文件；具体依赖请查看详情。"))
                                        .font(.subheadline).foregroundStyle(Palette.muted).padding(.horizontal, 20)
                                }
                                if let feed = library.feed {
                                    FeedResults(store: feed.discovery, query: feedQuery, loadsOnAppear: false, fallback: items, layout: feedLayout)
                                } else if items.isEmpty {
                                    if needsFirstVideoUpdate {
                                        ContentUnavailableView {
                                            Label(String(localized: "视频内容需要联网更新"), systemImage: "play.rectangle")
                                        } description: {
                                            Text(String(localized: "首次联网更新后可浏览视频 Prompt。你也可以先查看其他类型的内容。"))
                                        } actions: {
                                            Button(library.isRefreshing ? String(localized: "正在更新…") : String(localized: "检查内容更新")) {
                                                Task { await library.refresh(force: true) }
                                            }.buttonStyle(.borderedProminent).disabled(library.isRefreshing).accessibilityIdentifier("loadVideoExamples")
                                            Button(String(localized: "查看其他内容")) { kind = nil; skillsOnly = false; topic = nil; model = nil }
                                                .buttonStyle(.bordered).accessibilityIdentifier("browseOtherIdeas")
                                        }
                                    } else {
                                        ContentUnavailableView(String(localized: "暂无匹配内容"), systemImage: "sparkle", description: Text(String(localized: "试试其他分类，或清除筛选条件。")))
                                    }
                                } else {
                                    PromptGrid(items: items).padding(.horizontal, 12)
                                }
                            }
                        }.id("discovery-top").padding(.bottom, 24)
                            .frame(minHeight: viewportHeight, alignment: .top)
                            .transaction { $0.animation = nil }
                    }
                    .accessibilityIdentifier("discoveryScroll")
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewportHeight = $0 }
                    .onGeometryChange(for: PromptGridLayout.self) { proxy in
                        PromptGridLayout.measured(in: proxy, inset: 12)
                    } action: { if !$0.widths.isEmpty { feedLayout = $0 } }
                    .plainTopEdge()
                    .scrollClipDisabled()
                    .background(Palette.paper).foregroundStyle(Palette.ink)
                    .readingChrome($chromeCollapsed)
                    .safeAreaInset(edge: .top, spacing: 0) {
                        // Reserve space for native refresh without moving content
                        // when chrome collapses. Controls are overlaid independently
                        // so their layout is separate from the scrolling cards.
                        Color.clear.frame(height: headerHeight).allowsHitTesting(false)
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
                            chromeCollapsed = false
                            scroll.scrollTo("discovery-top", anchor: .top)
                        }
                    }
                }
                discoveryChrome.zIndex(1)
            }
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $settingsPresented) { SettingsView().promptSheet() }
            .task(id: feedQuery) { await library.feed?.discovery.load(feedQuery) }
            .task(id: "\(library.recommendations.preferenceRevision)-\(settingsPresented)-\(recommendationSurfaceVisible)") {
                let revision = library.recommendations.preferenceRevision
                guard recommendationSurfaceVisible, !settingsPresented, revision != appliedPreferenceRevision else { return }
                appliedPreferenceRevision = revision
                library.feed?.discovery.invalidateCachedPages()
                if feedSort == "recommended" { await library.feed?.discovery.load(feedQuery, force: true) }
            }
        }
    }
    private func selectKind(_ next: PromptKind?, _ skills: Bool) {
        kind = next; skillsOnly = skills; topic = nil; model = nil
        library.feed?.discovery.select(feedQuery)
    }
    private var discoveryChrome: some View {
        discoveryHeader
            .offset(y: chromeCollapsed ? -headerHeight - 12 : 0)
            .opacity(chromeCollapsed ? 0 : 1)
            .allowsHitTesting(!chromeCollapsed)
            .accessibilityHidden(chromeCollapsed)
            .background {
                GeometryReader { proxy in
                    ReadingTopFade(collapsed: chromeCollapsed)
                        .frame(height: proxy.safeAreaInsets.top + (chromeCollapsed ? 0 : proxy.size.height) + ReadingTopFade.featherHeight)
                        .offset(y: -proxy.safeAreaInsets.top)
                }.allowsHitTesting(false).accessibilityHidden(true)
            }
            .animation(reduceMotion ? nil : .smooth(duration: 0.28), value: chromeCollapsed)
    }
    private var discoveryHeader: some View {
        VStack(spacing: 4) {
            RootPageHeader(settingsID: "discoverySettings") { settingsPresented = true }
            KindPicker(selection: $kind, skillsOnly: $skillsOnly, onSelect: selectKind)
        }.foregroundStyle(Palette.ink).padding(.bottom, 4)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { headerHeight = $0 }
            .accessibilityElement(children: .contain).accessibilityIdentifier("discoveryHeader")
    }
    private var discoveryContext: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline) { resultHeading; Spacer(); resultActions }
            VStack(alignment: .leading, spacing: 4) { resultHeading; resultActions }
        }.padding(.horizontal, 16)
    }
    private var resultHeading: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(skillsOnly ? String(localized: "Agent Skills") : isFiltered ? String(localized: "筛选结果") : String(localized: "全部内容"))
                .font(.subheadline.weight(.medium))

        }
    }
    private var resultActions: some View {
        HStack(spacing: 16) {
            if isFiltered {
                Button(String(localized: "清除筛选")) { selectKind(nil, false) }
                    .font(.footnote).frame(minHeight: 44)
            }
            filterPicker
        }
    }
    private var filterPicker: some View {
        Menu {
            Group {
                Picker(String(localized: "排序"), selection: $feedSort) {
                    Text(String(localized: "推荐")).tag("recommended")
                    Text(String(localized: "最新收录")).tag("latest")
                }
            }
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
        } label: {
            Label(String(localized: "筛选"), systemImage: "line.3.horizontal.decrease")
                .font(.footnote).foregroundStyle(topic == nil && model == nil ? Palette.muted : Palette.accent)
                .frame(minHeight: 44)
        }.accessibilityIdentifier("discoveryFilters")
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
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    @State private var measuredLayout = PromptGridLayout(width: 0)
    private var layout: PromptGridLayout { suppliedLayout.flatMap { $0.widths.isEmpty ? nil : $0 } ?? measuredLayout }
    @State private var viewport = GridViewport()
    @State private var prefetchOwner = UUID()
    @Environment(\.scenePhase) private var scenePhase
    @ScaledMetric(relativeTo: .footnote) private var titleSize = 13
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
        let font = UIFont.systemFont(ofSize: titleSize)
        for item in items {
            let column = bottoms.indices.min { bottoms[$0] < bottoms[$1] }!
            let value = preview(item)
            let top = bottoms[column]
            let height = PromptCardGeometry.height(for: value, width: widths[column], titleFont: font)
            bottoms[column] += height + (linear ? 24 : 14)
            if !value.usesTextArtwork, viewport.includes(top: top, height: height), let url = value.media?.imageURL { candidates.append((top, url)) }
            if bottoms.allSatisfy({ $0 > viewport.end }) { break }
        }
        var seen = Set<URL>()
        return Array(candidates.sorted { $0.0 < $1.0 }.map(\.1).filter { seen.insert($0).inserted }.prefix(20))
    }
    private var balancedColumns: [[Int]] {
        let widths = layout.widths.isEmpty ? Array(repeating: CGFloat(180), count: layout.columns) : layout.widths
        let font = UIFont.systemFont(ofSize: titleSize)
        return PromptMasonry.columns(itemCount: items.count, widths: widths, spacing: 14) { index, width in
            PromptCardGeometry.height(for: preview(items[index]), width: width, titleFont: font)
        }
    }
    private func column(_ indices: [Int]) -> some View {
        LazyVStack(spacing: 14) {
            ForEach(indices.map { items[$0] }) { item in
                cell(item)
            }
        }.frame(maxWidth: .infinity)
    }
}

struct PromptGridLayout: Equatable {
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
        guard width > 0 else { widths = []; gaps = [14]; return }
        let half = count / 2
        if let division = usableDivision {
            let leading = max(0, (division.minX - 8 - CGFloat(half - 1) * 14) / CGFloat(half))
            let trailing = max(0, (width - division.maxX - 8 - CGFloat(half - 1) * 14) / CGFloat(half))
            widths = Array(repeating: leading, count: half) + Array(repeating: trailing, count: half)
            gaps = (0..<(count - 1)).map { $0 == half - 1 ? division.width + 16 : 14 }
        } else {
            widths = Array(repeating: max(0, (width - CGFloat(count - 1) * 14) / CGFloat(count)), count: count)
            gaps = Array(repeating: 14, count: count - 1)
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
    static let titleSpacing: CGFloat = 6
    static func aspectRatio(for item: Prompt) -> CGFloat { aspectRatio(for: ContentPreview(item)) }
    static func aspectRatio(for item: ContentPreview) -> CGFloat {
        if item.usesTextArtwork { return 0.95 }
        // Retain common portrait and widescreen shapes. Only extreme ratios crop.
        if let ratio = item.media?.aspectRatio { return max(0.65, min(1.8, ratio)) }
        return switch item.kind { case .text: 0.95; case .image: item.artwork == "lake" ? 1.02 : 0.76; case .video: 0.94; case .web: WebsiteExamples.files[item.id] != nil ? 0.62 : 0.87 }
    }
    static func height(for item: Prompt, width: CGFloat, titleFont: UIFont) -> CGFloat {
        height(for: ContentPreview(item), width: width, titleFont: titleFont)
    }
    static func height(for item: ContentPreview, width: CGFloat, titleFont: UIFont) -> CGFloat {
        let preview = width / aspectRatio(for: item)
        guard !item.usesTextArtwork else { return preview }
        let bounds = (item.displayTitle as NSString).boundingRect(
            with: CGSize(width: max(1, width - 4), height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: titleFont], context: nil)
        return preview + titleSpacing + ceil(min(bounds.height, titleFont.lineHeight * 2))
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
            }.buttonStyle(.plain).accessibilityLabel(item.displayTitle).accessibilityIdentifier("prompt-\(item.id)")
                .contextMenu {
                    Button {
                        UIPasteboard.general.string = item.displayContent.prompt
                        copiedFeedback.toggle()
                    } label: { Label(item.isSkill ? String(localized: "复制 Skill") : String(localized: "复制 Prompt"), systemImage: "doc.on.doc") }
                    Button {
                        if library.toggle(item) { savedFeedback.toggle() }
                    } label: { Label(library.isSaved(item) ? String(localized: "取消收藏") : String(localized: "收藏 Prompt"), systemImage: library.isSaved(item) ? "bookmark.slash" : "bookmark") }
                }
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
    @State private var showCreators = false
    @State private var settingsPresented = false
    @Namespace private var scopeLine
    @ScaledMetric(relativeTo: .body) private var searchHeight = 48
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    SavedSearchField(text: $query).frame(height: searchHeight).padding(.horizontal, 12)
                    Group {
                        if typeSize.isAccessibilitySize {
                            VStack(alignment: .leading, spacing: 8) {
                                savedScopes
                                if !showCreators { kindMenu }
                            }
                        } else {
                            HStack(spacing: 16) { savedScopes; if !showCreators { kindMenu } }
                        }
                    }.padding(.horizontal, 20)
                    if showCreators { SavedCreators(query: query) }
                    else { savedContent }
                }.padding(.top, 2).padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .plainTopEdge().background(Palette.paper).foregroundStyle(Palette.ink)
            .safeAreaInset(edge: .top, spacing: 0) {
                RootPageHeader(title: String(localized: "收藏"), settingsID: "savedSettings") { settingsPresented = true }
                    .background(Palette.paper)
            }
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $settingsPresented) { SettingsView().promptSheet() }
        }
    }
    private var savedScopes: some View {
        HStack(spacing: 24) {
            savedScope(false, title: String(localized: "内容"), count: library.favorites.count)
            savedScope(true, title: String(localized: "创作者"), count: library.savedCreators.count)
            Spacer(minLength: 0)
        }
    }
    private func savedScope(_ creators: Bool, title: String, count: Int) -> some View {
        Button { withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) { showCreators = creators } } label: {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(title).font(.headline)
                Text(count.formatted()).font(.caption.monospacedDigit()).fixedSize().foregroundStyle(Palette.muted)
            }.foregroundStyle(showCreators == creators ? Palette.ink : Palette.muted)
                .frame(minHeight: 48).contentShape(Rectangle())
                .overlay(alignment: .bottom) {
                    if showCreators == creators {
                        Capsule().fill(Palette.accent).frame(height: 2).matchedGeometryEffect(id: "saved-scope", in: scopeLine)
                    }
                }
        }.buttonStyle(.plain).accessibilityAddTraits(showCreators == creators ? .isSelected : [])
            .accessibilityIdentifier(creators ? "savedCreatorsScope" : "savedPromptsScope")
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
        } else { PromptGrid(items: items, origin: .favorite).padding(.horizontal, 12) }
    }
}

/// Identical placement, material, tint and hit area across the two root pages.
struct RootPageHeader: View {
    var title: String?
    let settingsID: String
    let settings: () -> Void
    var body: some View {
        HStack {
            if let title { Text(title).font(.title2.weight(.semibold)).tracking(-0.5).accessibilityAddTraits(.isHeader) }
            else { PrompixWordmark().accessibilityIdentifier("discoveryHeading") }
            Spacer()
            Button(action: settings) { Image(systemName: "gearshape").frame(width: 44, height: 44) }
                .buttonStyle(.plain).readingGlass().accessibilityLabel(String(localized: "设置"))
                .accessibilityIdentifier(settingsID)
        }.font(.title3).foregroundStyle(Palette.ink).padding(.horizontal, 20).padding(.vertical, 6)
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
