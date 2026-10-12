import SwiftUI

struct RootView: View {
    var body: some View {
        TabView {
            DiscoverView().tabItem { Label { Text(String(localized: "发现")) } icon: { TabSymbol.image("discover") } }
            CollectionsView().tabItem { Label { Text(String(localized: "专题")) } icon: { TabSymbol.image("collections") } }
            FavoritesView().tabItem { Label { Text(String(localized: "收藏")) } icon: { TabSymbol.image("saved") } }
        }
    }
}

struct DiscoverView: View {
    @Environment(Library.self) private var library
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var kind: PromptKind?
    @State private var topic: String?
    @State private var model: String?
    @State private var searchPresented = false
    @State private var settingsPresented = false
    private let topics = ["好玩一点", "创作灵感", "日常有用"]
    private var items: [Prompt] { library.prompts.filter { PromptQuery(kind: kind, topic: topic, model: model).matches($0) } }
    private var needsFirstVideoUpdate: Bool {
        kind == .video && library.version.hasPrefix("studio-") && !library.prompts.contains { $0.kind == .video }
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    KindPicker(selection: $kind)
                    HStack(spacing: 8) {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                topicButton(nil, String(localized: "全部用途"))
                                ForEach(topics, id: \.self) { topicButton($0, NSLocalizedString($0, comment: "Discovery topic")) }
                            }.padding(.leading, 20).padding(.trailing, 4)
                        }
                        modelPicker.padding(.trailing, 16)
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
                                Button(String(localized: "查看其他内容")) { kind = nil; topic = nil; model = nil }
                                    .buttonStyle(.bordered).accessibilityIdentifier("browseOtherIdeas")
                            }
                        } else {
                            ContentUnavailableView(String(localized: "暂无匹配内容"), systemImage: "sparkle", description: Text(String(localized: "试试其他分类，或清除筛选条件。")))
                        }
                    } else { PromptGrid(items: items).padding(.horizontal, 16) }
                }.padding(.top, 4).padding(.bottom, 16)
            }
            .refreshable { await library.refresh(force: true) }
            .onChange(of: kind) { _, _ in model = nil }
            .navigationTitle("").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { Text("prompix").font(.system(.title, design: .serif, weight: .semibold)).fixedSize().accessibilityAddTraits(.isHeader) }
                ToolbarItem(placement: .topBarTrailing) { Button(String(localized: "搜索"), systemImage: "magnifyingglass") { searchPresented = true }.accessibilityIdentifier("searchButton") }
                ToolbarItem(placement: .topBarTrailing) { Button(String(localized: "设置"), systemImage: "slider.horizontal.3") { settingsPresented = true } }
            }
            .navigationDestination(for: Prompt.self) { PromptDetail(item: $0) }
            .sheet(isPresented: $searchPresented) { SearchView() }
            .sheet(isPresented: $settingsPresented) { SettingsView() }
        }
    }
    private var modelPicker: some View {
        Menu {
            Button(String(localized: "全部模型")) { model = nil }
            ForEach(Array(Set(library.prompts.filter { kind == nil || $0.kind == kind }.map(\.model))).sorted(), id: \.self) { value in
                Button { model = value } label: {
                    if model == value { Label(value, systemImage: "checkmark") } else { Text(value) }
                }
            }
        } label: {
            Group {
                if typeSize.isAccessibilitySize {
                    Image(systemName: "line.3.horizontal.decrease").font(.system(size: 22)).frame(width: 44, height: 44)
                } else {
                    Label(model ?? String(localized: "模型"), systemImage: "line.3.horizontal.decrease")
                        .font(.footnote).lineLimit(1).padding(.horizontal, 12).frame(maxWidth: 120, minHeight: 44)
                }
            }.foregroundStyle(model == nil ? Palette.muted : Palette.accent)
                .background(Palette.soft, in: Capsule()).contentShape(Capsule())
        }.accessibilityLabel(model ?? String(localized: "全部模型"))
    }
    private func topicButton(_ value: String?, _ title: String) -> some View {
        Button { topic = value } label: {
            Text(title).font(.footnote.weight(topic == value ? .semibold : .regular))
                .foregroundStyle(topic == value ? Color(uiColor: .systemBackground) : Palette.muted)
                .padding(.horizontal, 15).padding(.vertical, 9)
                .background(topic == value ? Color.primary : Palette.soft, in: Capsule())
                .frame(minHeight: 44).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityAddTraits(topic == value ? .isSelected : [])
    }
}

struct PromptGrid: View {
    let items: [Prompt]
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    var body: some View {
        // Separate masonry columns read column-first. A linear native stack
        // preserves the editorial sequence when navigating with VoiceOver.
        if typeSize.isAccessibilitySize || voiceOverEnabled {
            LazyVStack(spacing: 24) { ForEach(items) { PromptCard(item: $0) } }
        } else {
            HStack(alignment: .top, spacing: 12) {
                column(0)
                column(1)
            }
        }
    }
    private func column(_ parity: Int) -> some View {
        LazyVStack(spacing: 23) {
            ForEach(Array(items.enumerated()).filter { $0.offset % 2 == parity }, id: \.element.id) { _, item in
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
            NavigationLink(value: item) {
                VStack(alignment: .leading, spacing: 10) {
                    Artwork(item: item).aspectRatio(ratio, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 12))
                    Text(item.title).font(.system(.subheadline, weight: .medium)).foregroundStyle(.primary)
                        .lineSpacing(3).lineLimit(typeSize.isAccessibilitySize ? nil : 3).multilineTextAlignment(.leading).padding(.horizontal, 2)
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel(item.title).accessibilityIdentifier("prompt-\(item.id)")
            HStack(spacing: 4) {
                Image(systemName: item.kind.symbol).font(.system(size: 10)).accessibilityHidden(true)
                Text(item.kind.title).font(.footnote)
                Spacer(minLength: 0)
                Button {
                    if library.toggle(item) { savedFeedback.toggle() }
                } label: {
                    Image(systemName: library.isSaved(item) ? "bookmark.fill" : "bookmark")
                        .font(.system(size: 13)).foregroundStyle(library.isSaved(item) ? Palette.accent : Palette.muted)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityLabel(library.isSaved(item) ? String(localized: "取消收藏：\(item.title)") : String(localized: "收藏：\(item.title)"))
                    .sensoryFeedback(.selection, trigger: savedFeedback)
            }.foregroundStyle(Palette.muted).padding(.leading, 2).padding(.top, 0).padding(.bottom, -10)
        }
    }
    private var ratio: CGFloat {
        if let ratio = item.media?.aspectRatio { return max(0.65, min(1.5, ratio)) }
        return switch item.kind { case .text: 0.84; case .image: item.artwork == "lake" ? 1.02 : 0.76; case .video: 0.94; case .web: WebsiteExamples.files[item.id] != nil ? 0.62 : 0.87 }
    }
}

struct SearchView: View {
    @Environment(Library.self) private var library
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var kind: PromptKind?
    private var results: [Prompt] { library.prompts.filter { PromptQuery(text: query, kind: kind).matches($0) } }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    KindPicker(selection: $kind)
                    if query.isEmpty {
                        HStack { ForEach(["塔罗", "网站", "电影"], id: \.self) { term in Button(NSLocalizedString(term, comment: "Suggested search")) { query = term }.buttonStyle(.bordered).controlSize(.large) } }.padding(.horizontal, 20)
                    }
                    if results.isEmpty { ContentUnavailableView.search(text: query) }
                    else { PromptGrid(items: results).padding(.horizontal, 16) }
                }.padding(.bottom, 24)
            }.navigationTitle(String(localized: "搜索 Prompt")).navigationBarTitleDisplayMode(.inline)
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: String(localized: "搜索标题、用途或模型"))
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { dismiss() } } }
                .navigationDestination(for: Prompt.self) { PromptDetail(item: $0) }
        }
    }
}

struct FavoritesView: View {
    @Environment(Library.self) private var library
    @State private var kind: PromptKind?
    @State private var query = ""
    @State private var images = ImageStore.shared
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    KindPicker(selection: $kind)
                    if !images.offlineFailures.isEmpty {
                        Button { Task { if let urls = library.savedImageURLs { await images.keepOffline(urls) } } } label: {
                            Label(String(localized: "部分收藏预览尚未下载，轻点重试"), systemImage: "arrow.down.circle")
                                .font(.footnote).foregroundStyle(Palette.muted)
                        }.padding(.horizontal, 20)
                    }
                    let items = library.favorites.filter { PromptQuery(text: query, kind: kind).matches($0) }
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
                }.padding(.bottom, 24)
            }.navigationTitle(String(localized: "收藏"))
                .searchable(text: $query, prompt: String(localized: "搜索收藏"))
                .navigationDestination(for: Prompt.self) { PromptDetail(item: $0) }
        }
    }
}
