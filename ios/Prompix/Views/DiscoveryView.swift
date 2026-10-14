import SwiftUI

private enum MainTab: Hashable { case discover, saved, search }

struct RootView: View {
    @State private var showsOnboarding = !UserDefaults.standard.bool(forKey: "hasCompletedOnboarding")
    @State private var tab = MainTab.discover
    @State private var query = ""
    @State private var searchFocused = false
    var body: some View {
        tabs.tint(Palette.accent)
            .fullScreenCover(isPresented: $showsOnboarding) {
                PrompixOnboarding {
                    UserDefaults.standard.set(true, forKey: "hasCompletedOnboarding")
                    showsOnboarding = false
                }.interactiveDismissDisabled()
            }
    }
    @ViewBuilder private var tabs: some View {
        if #available(iOS 18, *) {
            TabView(selection: $tab) {
                Tab(value: MainTab.discover) { DiscoverView() } label: {
                    Label { Text(String(localized: "发现")) } icon: { TabSymbol.image("safari") }
                }
                Tab(value: MainTab.saved) { FavoritesView() } label: {
                    Label { Text(String(localized: "收藏")) } icon: { TabSymbol.image("heart") }
                }
                if #available(iOS 27, *) {
                    Tab(String(localized: "搜索"), systemImage: "magnifyingglass", value: MainTab.search, role: .prominent) { SearchView(query: $query, focused: $searchFocused) }
                } else {
                    Tab(value: MainTab.search, role: .search) { SearchView(query: $query, focused: $searchFocused) }
                }
            }
            .onChange(of: tab) { _, value in if value == .search { searchFocused = true } }
            .autocorrectionDisabled().textInputAutocapitalization(.never)
        } else {
            TabView(selection: $tab) {
                DiscoverView().tag(MainTab.discover)
                    .tabItem { Label { Text(String(localized: "发现")) } icon: { TabSymbol.image("safari") } }
                FavoritesView().tag(MainTab.saved)
                    .tabItem { Label { Text(String(localized: "收藏")) } icon: { TabSymbol.image("heart") } }
                SearchView(query: $query, focused: $searchFocused).tag(MainTab.search)
                    .tabItem { Label(String(localized: "搜索"), systemImage: "magnifyingglass") }
            }
        }
    }
}

struct DiscoverView: View {
    @Environment(Library.self) private var library
    @State private var kind: PromptKind?
    @State private var skillsOnly = false
    @State private var topic: String?
    @State private var model: String?
    @State private var chromeCollapsed = false
    @State private var headerHeight: CGFloat = 112
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var settingsPresented = false
    private let topics = ["好玩一点", "创作灵感", "日常有用"]
    private var items: [Prompt] { library.prompts.filter { PromptQuery(kind: kind, topic: topic, model: model, skillsOnly: skillsOnly).matches($0) } }
    private var isFiltered: Bool { kind != nil || skillsOnly || topic != nil || model != nil }
    private var needsFirstVideoUpdate: Bool {
        kind == .video && library.version.hasPrefix("studio-") && !library.prompts.contains { $0.kind == .video }
    }
    var body: some View {
        NavigationStack {
            ScrollViewReader { scroll in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        Color.clear.frame(height: headerHeight).id("discovery-top")
                        Group {
                            if library.isRefreshing || library.syncMessage != nil { CatalogUpdateStatus().padding(.horizontal, 20) }
                            if !isFiltered {
                                CreatorRail()
                                CollectionRail().padding(.bottom, 6)
                            }
                            discoveryContext
                            if skillsOnly {
                                Text(String(localized: "可带到编程助手中使用的技能，包含完整说明与源文件。"))
                                    .font(.subheadline).foregroundStyle(Palette.muted).padding(.horizontal, 20)
                            }
                            if items.isEmpty {
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
                    }.padding(.bottom, 24)
                }
                .plainTopEdge()
                .background(Palette.paper).foregroundStyle(Palette.ink)
                .readingChrome($chromeCollapsed)
                .overlay(alignment: .top) {
                    GeometryReader { proxy in
                        Palette.paper.frame(height: proxy.safeAreaInsets.top)
                            .offset(y: -proxy.safeAreaInsets.top)
                    }.allowsHitTesting(false).accessibilityHidden(true)
                }
                .overlay(alignment: .top) {
                    discoveryHeader
                        .offset(y: chromeCollapsed ? -headerHeight - 12 : 0)
                        .opacity(chromeCollapsed ? 0 : 1)
                        .allowsHitTesting(!chromeCollapsed)
                        .accessibilityHidden(chromeCollapsed)
                        .animation(reduceMotion ? nil : .smooth(duration: 0.28), value: chromeCollapsed)
                }
                .refreshable { await library.refresh(force: true) }
                .onChange(of: kind) { _, _ in model = nil; topic = nil; chromeCollapsed = false; scroll.scrollTo("discovery-top", anchor: .top) }
                .onChange(of: skillsOnly) { _, _ in model = nil; topic = nil; chromeCollapsed = false; scroll.scrollTo("discovery-top", anchor: .top) }
                .onChange(of: topic) { _, _ in chromeCollapsed = false; scroll.scrollTo("discovery-top", anchor: .top) }
                .onChange(of: model) { _, _ in chromeCollapsed = false; scroll.scrollTo("discovery-top", anchor: .top) }
            }
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $settingsPresented) { SettingsView().promptSheet() }
        }
    }
    private var discoveryHeader: some View {
        VStack(spacing: 4) {
            HStack {
                Text("Prompix").font(.title2.weight(.semibold)).tracking(-0.8)
                    .accessibilityAddTraits(.isHeader).accessibilityIdentifier("discoveryHeading")
                Spacer()
                Button { settingsPresented = true } label: { Image(systemName: "gearshape").frame(width: 44, height: 44) }
                    .buttonStyle(.plain).readingGlass().accessibilityLabel(String(localized: "设置")).accessibilityIdentifier("discoverySettings")
            }.font(.title3).padding(.horizontal, 20).padding(.vertical, 6)
            KindPicker(selection: $kind, skillsOnly: $skillsOnly)
        }.foregroundStyle(Palette.ink).padding(.bottom, 4).background(Palette.paper)
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
            Text(items.count.formatted()).font(.caption.monospacedDigit()).foregroundStyle(Palette.muted)
        }
    }
    private var resultActions: some View {
        HStack(spacing: 16) {
            if isFiltered {
                Button(String(localized: "清除筛选")) { kind = nil; skillsOnly = false; topic = nil; model = nil }
                    .font(.footnote).frame(minHeight: 44)
            }
            if !skillsOnly { filterPicker }
        }
    }
    private var filterPicker: some View {
        Menu {
            Menu(String(localized: "全部用途")) {
                Button(String(localized: "全部用途")) { topic = nil }
                ForEach(topics, id: \.self) { value in
                    Button { topic = value } label: {
                        if topic == value { Label(NSLocalizedString(value, comment: "Topic"), systemImage: "checkmark") }
                        else { Text(NSLocalizedString(value, comment: "Topic")) }
                    }
                }
            }
            Menu(String(localized: "模型")) {
                Button(String(localized: "全部模型")) { model = nil }
                ForEach(Array(Set(library.prompts.filter { PromptQuery(kind: kind, skillsOnly: skillsOnly).matches($0) }.map(\.model))).sorted(), id: \.self) { value in
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

struct CatalogUpdateStatus: View {
    @Environment(Library.self) private var library
    var body: some View {
        if library.isRefreshing || library.syncMessage != nil {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    if library.isRefreshing { ProgressView().controlSize(.small) }
                    else { Image(systemName: "arrow.clockwise").foregroundStyle(Palette.accent) }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(title).font(.footnote.weight(.medium))
                        Text(library.isRefreshing ? String(localized: "更新期间可继续浏览已下载内容。") : String(localized: "已下载内容仍可浏览，轻点重试。"))
                            .font(.caption).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                    if !library.isRefreshing {
                        Button(String(localized: "重试")) { Task { await library.refresh(force: true) } }
                            .font(.footnote.weight(.medium)).frame(minWidth: 44, minHeight: 44)
                            .accessibilityIdentifier("retryCatalogUpdate")
                    }
                }
                if let fraction = library.syncState.fractionCompleted {
                    ProgressView(value: fraction).tint(Palette.accent)
                }
            }.padding(14).background(Palette.soft, in: RoundedRectangle(cornerRadius: 14))
                .accessibilityElement(children: .contain).accessibilityIdentifier("catalogUpdateStatus")
        }
    }
    private var title: String {
        switch library.syncState {
        case .checking: String(localized: "正在检查内容更新…")
        case .downloading: String(localized: "正在下载新内容…")
        case .installing: String(localized: "正在整理新内容…")
        default: library.isRefreshing ? String(localized: "正在更新…") : String(localized: "内容更新未完成")
        }
    }
}

struct PromptGrid: View {
    let items: [Prompt]
    var origin: PromptDetailOrigin = .catalog
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    @State private var layout = PromptGridLayout(width: 0)
    @ScaledMetric(relativeTo: .footnote) private var titleSize = 13
    var body: some View {
        // Separate masonry columns read column-first. A linear native stack
        // preserves the editorial sequence when navigating with VoiceOver.
        if typeSize.isAccessibilitySize || voiceOverEnabled {
            LazyVStack(spacing: 24) { ForEach(items) { PromptCard(item: $0, origin: origin) } }
        } else {
            let columns = balancedColumns
            HStack(alignment: .top, spacing: 0) {
                ForEach(0..<layout.columns, id: \.self) { index in
                    column(columns[index]).frame(width: layout.widths.isEmpty ? nil : layout.widths[index])
                    if index < layout.columns - 1 { Color.clear.frame(width: layout.gaps[index], height: 1) }
                }
            }.frame(minWidth: 0, maxWidth: .infinity)
                .onGeometryChange(for: PromptGridLayout.self) { proxy in
                    if #available(iOS 27.1, *) {
                        PromptGridLayout(width: proxy.size.width, division: proxy.reservedRegions(kind: .division)
                            .map(\.frame).first { $0.height > $0.width && $0.minX > 0 && $0.maxX < proxy.size.width })
                    } else { PromptGridLayout(width: proxy.size.width) }
                } action: { layout = $0 }
        }
    }
    private var balancedColumns: [[Int]] {
        let widths = layout.widths.isEmpty ? Array(repeating: CGFloat(180), count: layout.columns) : layout.widths
        let font = UIFont.systemFont(ofSize: titleSize)
        return PromptMasonry.columns(itemCount: items.count, widths: widths, spacing: 14) { index, width in
            PromptCardGeometry.height(for: items[index], width: width, titleFont: font)
        }
    }
    private func column(_ indices: [Int]) -> some View {
        LazyVStack(spacing: 14) {
            ForEach(indices.map { items[$0] }) { item in
                PromptCard(item: item, origin: origin)
            }
        }.frame(maxWidth: .infinity)
    }
}

struct PromptGridLayout: Equatable {
    let columns: Int
    let widths: [CGFloat]
    let gaps: [CGFloat]
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
    static func aspectRatio(for item: Prompt) -> CGFloat {
        if item.isSkill { return 0.95 }
        if let ratio = item.media?.aspectRatio { return max(0.65, min(1.5, ratio)) }
        return switch item.kind { case .text: 0.95; case .image: item.artwork == "lake" ? 1.02 : 0.76; case .video: 0.94; case .web: WebsiteExamples.files[item.id] != nil ? 0.62 : 0.87 }
    }
    static func height(for item: Prompt, width: CGFloat, titleFont: UIFont) -> CGFloat {
        let preview = width / aspectRatio(for: item)
        guard !item.isSkill && item.kind != .text else { return preview }
        let bounds = (item.displayTitle as NSString).boundingRect(
            with: CGSize(width: max(1, width - 4), height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: titleFont], context: nil)
        return preview + 8 + ceil(min(bounds.height, titleFont.lineHeight * 2))
    }
}

struct PromptCard: View {
    let item: Prompt
    var origin: PromptDetailOrigin = .catalog
    @Environment(Library.self) private var library
    @State private var detailPresented = false
    @State private var savedFeedback = false
    @State private var copiedFeedback = false
    @Namespace private var transition
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { detailPresented = true } label: {
                VStack(alignment: .leading, spacing: 8) {
                    if typeSize.isAccessibilitySize && (item.kind == .text || item.isSkill) {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(item.displayTitle).font(.headline).foregroundStyle(.primary)
                            Text(item.displaySummary).font(.subheadline).foregroundStyle(Palette.muted)
                        }.fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                            .padding(20).background(Palette.soft, in: RoundedRectangle(cornerRadius: 6))
                    } else {
                        Artwork(item: item).aspectRatio(ratio, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    if !titleIsInArtwork {
                        Text(item.displayTitle).font(.footnote).foregroundStyle(Palette.ink)
                            .lineLimit(typeSize.isAccessibilitySize ? nil : 2).multilineTextAlignment(.leading).padding(.horizontal, 2)
                    }
                }.contentShape(Rectangle()).promptTransitionSource(id: item.id, in: transition)
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
    @State private var kind: PromptKind?
    @State private var skillsOnly = false
    @State private var query = ""
    @State private var images = ImageStore.shared
    @State private var showCreators = false
    @State private var settingsPresented = false
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Picker(String(localized: "收藏类型"), selection: $showCreators) {
                        Text(String(localized: "内容")).tag(false)
                        Text(String(localized: "创作者")).tag(true)
                    }.pickerStyle(.segmented).padding(.horizontal, 20).accessibilityIdentifier("savedContentType")
                    if showCreators { SavedCreators(query: query) }
                    else {
                    KindPicker(selection: $kind, skillsOnly: $skillsOnly)
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
                            ContentUnavailableView(String(localized: "暂无收藏"), systemImage: "bookmark", description: Text(String(localized: "在详情页收藏喜欢的内容，也可以长按卡片收藏。")))
                        }
                    } else { PromptGrid(items: items, origin: .favorite).padding(.horizontal, 16) }
                    }
                }.padding(.bottom, 24)
            }.plainTopEdge().paperScreen()
                .navigationTitle(String(localized: "收藏")).navigationBarTitleDisplayMode(.inline)
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: String(localized: "搜索收藏"))
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(String(localized: "设置"), systemImage: "gearshape") { settingsPresented = true }
                            .accessibilityIdentifier("savedSettings")
                    }
                }
                .sheet(isPresented: $settingsPresented) { SettingsView().promptSheet() }
        }
    }
}
