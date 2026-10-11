import SwiftUI

struct RootView: View {
    var body: some View {
        TabView {
            DiscoverView().tabItem { Label { Text("发现") } icon: { TabSymbol.image("discover") } }
            CollectionsView().tabItem { Label { Text("专题") } icon: { TabSymbol.image("collections") } }
            FavoritesView().tabItem { Label { Text("收藏") } icon: { TabSymbol.image("saved") } }
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
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("灵感，随手可得。").font(.subheadline).foregroundStyle(.secondary)
                        Spacer()
                        if !typeSize.isAccessibilitySize { Text(library.updatedAt == nil ? "STUDIO EDITION" : "DAILY FINDS").font(.system(.caption2, design: .monospaced)).tracking(1.5).foregroundStyle(.tertiary) }
                    }.padding(.horizontal, 20).dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                    KindPicker(selection: $kind)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            topicButton(nil, "精选")
                            ForEach(topics, id: \.self) { topicButton($0, $0) }
                        }.padding(.horizontal, 20)
                    }
                    HStack {
                        if let updated = library.updatedAt { Text(updated, format: .dateTime.month().day()).font(.caption2).foregroundStyle(.tertiary) }
                        else { Text("原创灵感集").font(.caption2).foregroundStyle(.tertiary) }
                        Spacer()
                        Menu {
                            Button("全部模型") { model = nil }
                            ForEach(Array(Set(library.prompts.filter { kind == nil || $0.kind == kind }.map(\.model))).sorted(), id: \.self) { value in
                                Button { model = value } label: { if model == value { Label(value, systemImage: "checkmark") } else { Text(value) } }
                            }
                        } label: { Label(model ?? "全部模型", systemImage: "line.3.horizontal.decrease").font(.caption).foregroundStyle(.secondary) }
                    }.padding(.horizontal, 20)
                    if let message = library.syncMessage { Text(message).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 20) }
                    if items.isEmpty {
                        ContentUnavailableView("灵感还在路上", systemImage: "sparkle", description: Text("试试其他分类，或回到全部精选。"))
                    } else { PromptGrid(items: items).padding(.horizontal, 16) }
                    HStack { Rectangle().frame(height: 0.5); Text("慢慢逛，会遇见喜欢的").font(.caption2).fixedSize(horizontal: false, vertical: true).multilineTextAlignment(.center); Rectangle().frame(height: 0.5) }
                        .foregroundStyle(.tertiary).padding(.horizontal, 40).padding(.vertical, 24)
                }.padding(.top, 4).padding(.bottom, 16)
            }
            .refreshable { await library.refresh(force: true) }
            .onChange(of: kind) { _, _ in model = nil }
            .navigationTitle("").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { Text("prompix").font(.system(size: 27, weight: .semibold, design: .serif)).fixedSize().accessibilityAddTraits(.isHeader) }
                ToolbarItem(placement: .topBarTrailing) { Button("搜索", systemImage: "magnifyingglass") { searchPresented = true }.accessibilityIdentifier("searchButton") }
                ToolbarItem(placement: .topBarTrailing) { Button("设置", systemImage: "slider.horizontal.3") { settingsPresented = true } }
            }
            .navigationDestination(for: Prompt.self) { PromptDetail(item: $0) }
            .sheet(isPresented: $searchPresented) { SearchView() }
            .sheet(isPresented: $settingsPresented) { SettingsView() }
        }
    }
    private func topicButton(_ value: String?, _ title: String) -> some View {
        Button { topic = value } label: {
            Text(title).font(.caption.weight(topic == value ? .semibold : .regular))
                .foregroundStyle(topic == value ? Color(uiColor: .systemBackground) : .secondary)
                .padding(.horizontal, 15).padding(.vertical, 9)
                .background(topic == value ? Color.primary : Palette.soft, in: Capsule())
                .frame(minHeight: 44)
        }.buttonStyle(.plain).accessibilityAddTraits(topic == value ? .isSelected : [])
    }
}

struct PromptGrid: View {
    let items: [Prompt]
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        if typeSize.isAccessibilitySize {
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
            ForEach(Array(items.enumerated()).filter { $0.offset % 2 == parity }, id: \.element.id) { index, item in
                PromptCard(item: item).accessibilitySortPriority(Double(items.count - index))
            }
        }.frame(maxWidth: .infinity)
    }
}

struct PromptCard: View {
    let item: Prompt
    @Environment(Library.self) private var library
    @State private var savedFeedback = false
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            NavigationLink(value: item) {
                VStack(alignment: .leading, spacing: 10) {
                    Artwork(item: item).aspectRatio(ratio, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 12))
                    Text(item.title).font(.system(.subheadline, weight: .medium)).foregroundStyle(.primary)
                        .lineSpacing(3).lineLimit(3).multilineTextAlignment(.leading).padding(.horizontal, 2)
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityIdentifier("prompt-\(item.id)")
            HStack(spacing: 4) {
                Image(systemName: item.kind.symbol).font(.system(size: 10))
                Text(item.kind.title).font(.caption2)
                Spacer(minLength: 0)
                Button {
                    if library.toggle(item) { savedFeedback.toggle() }
                } label: {
                    Image(systemName: library.isSaved(item) ? "bookmark.fill" : "bookmark")
                        .font(.system(size: 13)).foregroundStyle(library.isSaved(item) ? Palette.accent : .secondary)
                        .frame(width: 44, height: 44)
                }.buttonStyle(.plain).accessibilityLabel(library.isSaved(item) ? "取消收藏：\(item.title)" : "收藏：\(item.title)")
                    .sensoryFeedback(.selection, trigger: savedFeedback)
            }.foregroundStyle(.secondary).padding(.leading, 2).padding(.top, 0).padding(.bottom, -10)
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
                        Text("从一个小小的念头开始").font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 20)
                        HStack { ForEach(["塔罗", "网站", "电影"], id: \.self) { term in Button(term) { query = term }.buttonStyle(.bordered) } }.padding(.horizontal, 20)
                    }
                    if results.isEmpty { ContentUnavailableView.search(text: query) }
                    else { PromptGrid(items: results).padding(.horizontal, 16) }
                }.padding(.bottom, 24)
            }.navigationTitle("搜索灵感").navigationBarTitleDisplayMode(.inline)
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "用途、风格、模型，或一点好奇")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
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
                    Text("留住灵感，等一个想试试的时刻。").font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 20)
                    KindPicker(selection: $kind)
                    if !images.offlineFailures.isEmpty {
                        Button { Task { if let urls = library.savedImageURLs { await images.keepOffline(urls) } } } label: {
                            Label("部分收藏预览尚未下载，轻点重试", systemImage: "arrow.down.circle")
                                .font(.caption).foregroundStyle(.secondary)
                        }.padding(.horizontal, 20)
                    }
                    let items = library.favorites.filter { PromptQuery(text: query, kind: kind).matches($0) }
                    if !library.favoritesReadable {
                        ContentUnavailableView {
                            Label("收藏暂时无法读取", systemImage: "bookmark.slash")
                        } description: { Text("原文件和离线预览已保留，暂时不会覆盖你的收藏。") }
                        actions: { Button("重新读取收藏") { library.reloadFavorites() }.buttonStyle(.bordered) }
                    } else if items.isEmpty {
                        if !query.isEmpty { ContentUnavailableView.search(text: query) }
                        else {
                        ContentUnavailableView("把喜欢的，留在这里", systemImage: "bookmark", description: Text("轻点卡片上的书签。\n文字保存在本机，缩略图会下载以供离线查看。"))
                        }
                    } else { PromptGrid(items: items).padding(.horizontal, 16) }
                }.padding(.bottom, 24)
            }.navigationTitle("收藏")
                .searchable(text: $query, prompt: "在收藏中找灵感")
                .navigationDestination(for: Prompt.self) { PromptDetail(item: $0) }
        }
    }
}
