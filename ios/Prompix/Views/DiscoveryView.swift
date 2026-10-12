import SwiftUI

struct RootView: View {
    var body: some View {
        TabView {
            DiscoverView().tabItem { Label { Text(String(localized: "发现")) } icon: { TabSymbol.image("square.grid.2x2") } }
            CollectionsView().tabItem { Label { Text(String(localized: "专题")) } icon: { TabSymbol.image("rectangle.stack") } }
            FavoritesView().tabItem { Label { Text(String(localized: "收藏")) } icon: { TabSymbol.image("bookmark") } }
        }
    }
}

struct DiscoverView: View {
    @Environment(Library.self) private var library
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var kind: PromptKind?
    @State private var skillsOnly = false
    @State private var topic: String?
    @State private var model: String?
    @State private var searchPresented = false
    @State private var settingsPresented = false
    private let topics = ["好玩一点", "创作灵感", "日常有用"]
    private var items: [Prompt] { library.prompts.filter { PromptQuery(kind: kind, topic: topic, model: model, skillsOnly: skillsOnly).matches($0) } }
    private var isFiltered: Bool { kind != nil || skillsOnly || topic != nil || model != nil }
    private var needsFirstVideoUpdate: Bool {
        kind == .video && library.version.hasPrefix("studio-") && !library.prompts.contains { $0.kind == .video }
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    KindPicker(selection: $kind, skillsOnly: $skillsOnly)
                    if !isFiltered {
                        CreatorRail()
                        CollectionRail()
                    }
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline) { resultHeading; Spacer(); resultActions }
                        VStack(alignment: .leading, spacing: 4) { resultHeading; resultActions }
                    }.padding(.horizontal, 20)
                    if skillsOnly {
                        Text(String(localized: "可带到编程助手中使用的技能，包含完整说明与源文件。"))
                            .font(.subheadline).foregroundStyle(Palette.muted).padding(.horizontal, 20)
                    }
                    if let message = library.syncMessage { Text(message).font(.footnote).foregroundStyle(Palette.muted).padding(.horizontal, 20) }
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
                    } else { PromptGrid(items: items).padding(.horizontal, 16) }
                }.padding(.top, 4).padding(.bottom, 16)
            }
            .refreshable { await library.refresh(force: true) }
            .onChange(of: kind) { _, _ in model = nil; topic = nil }
            .onChange(of: skillsOnly) { _, _ in model = nil; topic = nil }
            .navigationTitle("").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { Text("prompix").font(.system(.title, design: .serif, weight: .semibold)).fixedSize().accessibilityAddTraits(.isHeader) }
                ToolbarItem(placement: .topBarTrailing) { Button(String(localized: "搜索"), systemImage: "magnifyingglass") { searchPresented = true }.accessibilityIdentifier("searchButton") }
                ToolbarItem(placement: .topBarTrailing) { Button(String(localized: "设置"), systemImage: "slider.horizontal.3") { settingsPresented = true } }
            }
            .sheet(isPresented: $searchPresented) { SearchView() }
            .sheet(isPresented: $settingsPresented) { SettingsView() }
        }
    }
    private var resultHeading: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(skillsOnly ? String(localized: "Agent Skills") : isFiltered ? String(localized: "筛选结果") : String(localized: "全部内容"))
                .font(.title3.weight(.semibold))
            Text(items.count.formatted()).font(.subheadline.monospacedDigit()).foregroundStyle(Palette.muted)
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

struct PromptGrid: View {
    let items: [Prompt]
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var columnCount: Int { sizeClass == .regular ? 3 : 2 }
    var body: some View {
        // Separate masonry columns read column-first. A linear native stack
        // preserves the editorial sequence when navigating with VoiceOver.
        if typeSize.isAccessibilitySize || voiceOverEnabled {
            LazyVStack(spacing: 24) { ForEach(items) { PromptCard(item: $0) } }
        } else {
            HStack(alignment: .top, spacing: 12) {
                ForEach(0..<columnCount, id: \.self) { column($0) }
            }
        }
    }
    private func column(_ parity: Int) -> some View {
        LazyVStack(spacing: 23) {
            ForEach(Array(items.enumerated()).filter { $0.offset % columnCount == parity }, id: \.element.id) { _, item in
                PromptCard(item: item)
            }
        }.frame(maxWidth: .infinity)
    }
}

struct PromptCard: View {
    let item: Prompt
    @Environment(Library.self) private var library
    @State private var savedFeedback = false
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            NavigationLink { PromptDetail(item: item) } label: {
                VStack(alignment: .leading, spacing: 10) {
                    if typeSize.isAccessibilitySize && (item.kind == .text || item.isSkill) {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(item.displayTitle).font(.headline).foregroundStyle(.primary)
                            Text(item.displaySummary).font(.subheadline).foregroundStyle(Palette.muted)
                        }.fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                            .padding(20).background(Palette.soft, in: RoundedRectangle(cornerRadius: 12))
                    } else {
                        Artwork(item: item).aspectRatio(ratio, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    if !titleIsInArtwork {
                        Text(item.displayTitle).font(.system(.subheadline, weight: .medium)).foregroundStyle(.primary)
                            .lineSpacing(3).lineLimit(typeSize.isAccessibilitySize ? nil : 3).multilineTextAlignment(.leading).padding(.horizontal, 2)
                    }
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel(item.displayTitle).accessibilityIdentifier("prompt-\(item.id)")
            HStack(spacing: 4) {
                if let creator = item.creator {
                    NavigationLink { CreatorDetail(creator: creator) } label: {
                        HStack(spacing: 5) {
                            CreatorAvatar(creator: creator, size: 18).accessibilityHidden(true)
                            Text(creator.displayName).font(.caption).lineLimit(1)
                        }.frame(minHeight: 44).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel(creator.displayName)
                } else {
                    Image(systemName: item.displaySymbol).font(.system(size: 10)).accessibilityHidden(true)
                    Text(item.displayKind).font(.footnote)
                }
                Spacer(minLength: 0)
                Button {
                    if library.toggle(item) { savedFeedback.toggle() }
                } label: {
                    Image(systemName: library.isSaved(item) ? "bookmark.fill" : "bookmark")
                        .font(.system(size: 13)).foregroundStyle(library.isSaved(item) ? Palette.accent : Palette.muted)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityLabel(library.isSaved(item) ? String(localized: "取消收藏：\(item.displayTitle)") : String(localized: "收藏：\(item.displayTitle)"))
                    .sensoryFeedback(.selection, trigger: savedFeedback)
            }.foregroundStyle(Palette.muted).padding(.leading, 2).padding(.top, 0).padding(.bottom, -10)
        }
    }
    private var titleIsInArtwork: Bool {
        if item.isSkill || (typeSize.isAccessibilitySize && item.kind == .text) { return true }
        return item.kind == .text && item.cover == nil && item.media == nil
            && ["tarot", "letter", "roast", "story", "learn", "journal", "text-editorial"].contains(item.artwork)
    }
    private var ratio: CGFloat {
        if item.isSkill { return 0.78 }
        if let ratio = item.media?.aspectRatio { return max(0.65, min(1.5, ratio)) }
        return switch item.kind { case .text: 0.84; case .image: item.artwork == "lake" ? 1.02 : 0.76; case .video: 0.94; case .web: WebsiteExamples.files[item.id] != nil ? 0.62 : 0.87 }
    }
}

struct SearchView: View {
    @Environment(Library.self) private var library
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var kind: PromptKind?
    @State private var skillsOnly = false
    @State private var recent = UserDefaults.standard.stringArray(forKey: "recentSearches") ?? []
    private var results: [Prompt] { library.prompts.filter { PromptQuery(text: query, kind: kind, skillsOnly: skillsOnly).matches($0) } }
    private var creators: [CreatorEntry] {
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        return CreatorDirectory.entries(in: library.prompts).filter {
            $0.creator.matchesSearch(query)
        }
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    KindPicker(selection: $kind, skillsOnly: $skillsOnly)
                    if query.isEmpty && kind == nil && !skillsOnly {
                        VStack(alignment: .leading, spacing: 16) {
                            if !recent.isEmpty {
                                HStack {
                                    Text(String(localized: "最近搜索")).font(.headline)
                                    Spacer()
                                    Button(String(localized: "清除")) { recent = []; UserDefaults.standard.removeObject(forKey: "recentSearches") }
                                        .font(.footnote).frame(minHeight: 44)
                                }
                                ForEach(recent, id: \.self) { term in
                                    Button { query = term } label: {
                                        HStack { Image(systemName: "clock"); Text(term); Spacer(); Image(systemName: "arrow.up.left") }
                                            .foregroundStyle(Palette.muted).frame(minHeight: 44)
                                    }.buttonStyle(.plain)
                                }
                            }
                            Text(String(localized: "试试这些用途")).font(.headline)
                            ForEach(["塔罗", "网站", "电影"], id: \.self) { term in
                                let translated = NSLocalizedString(term, comment: "Suggested search")
                                Button { query = translated } label: {
                                    HStack { Text(translated); Spacer(); Image(systemName: "arrow.up.left") }
                                        .frame(minHeight: 44).contentShape(Rectangle())
                                }.buttonStyle(.plain)
                            }
                        }.padding(.horizontal, 20)
                        CreatorRail()
                    } else {
                        if !creators.isEmpty && kind == nil && !skillsOnly {
                            VStack(alignment: .leading, spacing: 12) {
                                Text(String(localized: "创作者")).font(.headline)
                                ForEach(creators.prefix(3)) { entry in CreatorByline(creator: entry.creator) }
                            }.padding(.horizontal, 20)
                        }
                        if results.isEmpty { ContentUnavailableView.search(text: query) }
                        else {
                            Text(String(localized: "\(results.count) 条内容")).font(.footnote).foregroundStyle(Palette.muted).padding(.horizontal, 20)
                            PromptGrid(items: results).padding(.horizontal, 16)
                        }
                    }
                }.padding(.bottom, 24)
            }.navigationTitle(String(localized: "搜索 Prompt")).navigationBarTitleDisplayMode(.inline)
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: String(localized: "搜索标题、用途或模型"))
                .autocorrectionDisabled().textInputAutocapitalization(.never)
                .onSubmit(of: .search) {
                    let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !term.isEmpty {
                        recent = Array(([term] + recent.filter { $0 != term }).prefix(6))
                        UserDefaults.standard.set(recent, forKey: "recentSearches")
                    }
                }
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { dismiss() } } }
        }
    }
}

struct FavoritesView: View {
    @Environment(Library.self) private var library
    @State private var kind: PromptKind?
    @State private var skillsOnly = false
    @State private var query = ""
    @State private var images = ImageStore.shared
    @State private var showCreators = false
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
                            ContentUnavailableView(String(localized: "暂无收藏"), systemImage: "bookmark", description: Text(String(localized: "轻点卡片上的书签。\n文字保存在本机，缩略图会下载以供离线查看。")))
                        }
                    } else { PromptGrid(items: items).padding(.horizontal, 16) }
                    }
                }.padding(.bottom, 24)
            }.navigationTitle(String(localized: "收藏"))
                .searchable(text: $query, prompt: String(localized: "搜索收藏"))
        }
    }
}
