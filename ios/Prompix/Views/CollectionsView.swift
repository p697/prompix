import SwiftUI

struct Collection: Identifiable {
    let id: String
    let title: String
    let subtitle: String
    var tags: Set<String> { Set(FeedCollections.definitions[id]?.tags ?? []) }
    var kind: PromptKind? { FeedCollections.definitions[id]?.kind.flatMap(PromptKind.init(rawValue:)) }
    static let all: [Collection] = [
        .init(id: "play", title: String(localized: "趣味聊天"), subtitle: String(localized: "猜谜、角色扮演与趣味互动")),
        .init(id: "portraits", title: String(localized: "人像与角色"), subtitle: String(localized: "摄影布光、人物造型与原创角色")),
        .init(id: "products", title: String(localized: "产品与商业摄影"), subtitle: String(localized: "商品静物、场景布置与品牌画面")),
        .init(id: "graphics", title: String(localized: "海报与信息图"), subtitle: String(localized: "文字排版、视觉层次与信息表达")),
        .init(id: "illustration", title: String(localized: "插画与概念设计"), subtitle: String(localized: "不同画风、场景设定与视觉实验")),
        .init(id: "writing", title: String(localized: "写作与故事"), subtitle: String(localized: "短篇、文案、诗歌与文字修改")),
        .init(id: "learning", title: String(localized: "学习与思考"), subtitle: String(localized: "语言练习、知识解释与思路梳理")),
        .init(id: "daily", title: String(localized: "工作与生活"), subtitle: String(localized: "邮件、面试、旅行与日常安排")),
        .init(id: "video", title: String(localized: "视频创作"), subtitle: String(localized: "运镜、转场与动态场景的实际案例")),
        .init(id: "web", title: String(localized: "网页与小工具"), subtitle: String(localized: "作品集、网站与可以操作的工具"))
    ]
    @MainActor func count(in library: Library) -> Int {
        if let feed = library.feed { return feed.browse.value?.collections.first { $0.id == id }?.count ?? 0 }
        return items(in: library).count
    }
    @MainActor func previews(in library: Library) -> [ContentPreview] {
        if let feed = library.feed {
            return (feed.browse.value?.collections.first { $0.id == id }?.covers ?? [])
                .filter { !library.isRemoved(id: $0.id) }.map(ContentPreview.init)
        }
        return covers(from: items(in: library)).map(ContentPreview.init)
    }
    func includes(_ prompt: Prompt) -> Bool {
        if let kind, prompt.kind != kind { return false }
        return tags.isEmpty || !tags.isDisjoint(with: prompt.tags)
    }
    @MainActor func items(in library: Library) -> [Prompt] { library.prompts.filter(includes) }
    func covers(from items: [Prompt]) -> [Prompt] {
        var seen = Set<String>()
        let visual = items.filter {
            $0.kind != .text && !$0.isSkill &&
                ($0.media?.image != nil || $0.media?.imageURL != nil || WebsiteExamples.files[$0.id] != nil) &&
                seen.insert($0.id).inserted
        }
        // Visual topics use full-bleed previews. Text-only topics keep one
        // readable typographic cover instead of squeezing two narrow columns.
        return visual.isEmpty ? Array(items.prefix(1)) : Array(visual.prefix(2))
    }
}
struct CollectionsDirectory: View {
    @Environment(Library.self) private var library
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    private var columns: [GridItem] {
        Array(repeating: GridItem(.flexible(), spacing: 16), count: typeSize.isAccessibilitySize || voiceOverEnabled ? 1 : 2)
    }
    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, alignment: .leading, spacing: 24) {
                ForEach(Collection.all.filter { $0.count(in: library) > 0 }) { collection in
                    let count = collection.count(in: library)
                    NavigationLink { CollectionDetail(collection: collection) } label: {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack(spacing: 4) {
                                ForEach(collection.previews(in: library).prefix(2)) { item in
                                    Artwork(preview: item, compact: true).frame(maxWidth: .infinity).clipped()
                                }
                            }.aspectRatio(1, contentMode: .fit)
                                .background(Palette.soft).clipShape(RoundedRectangle(cornerRadius: 16)).accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 5) {
                                HStack(alignment: .firstTextBaseline, spacing: 12) {
                                    Text(collection.title).font(.subheadline.weight(.medium))
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                if typeSize.isAccessibilitySize {
                                    Text(collection.subtitle).font(.subheadline).foregroundStyle(Palette.muted)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                Text(String(localized: "\(count) 个 Prompt")).font(.caption).foregroundStyle(Palette.muted)
                            }.padding(.horizontal, 2)
                        }.foregroundStyle(Palette.ink).multilineTextAlignment(.leading)
                            .contentShape(Rectangle())
                    }.buttonStyle(.plain)
                        .accessibilityLabel("\(collection.title) \(collection.subtitle) \(String(localized: "\(count) 个 Prompt"))")
                        .accessibilityIdentifier("collection-\(collection.id)")
                }
            }.padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 28)
        }.background(Palette.paper).navigationTitle(String(localized: "专题"))
            .task { await library.feed?.browse.load() }
            .pageRefreshable { await library.feed?.browse.load(force: true) }
    }
}
/// Deduplicate by item identity AND source image: different cards can reuse one
/// image. Selection is bounded to the first page and never reorders the feed.
enum HomeCoverSelection {
    static func select(_ candidates: [ContentPreview], avoiding: [ContentPreview], limit: Int = 2) -> [ContentPreview] {
        guard limit > 0 else { return [] }
        var ids = Set(avoiding.map(\.id))
        var images = Set(avoiding.compactMap { $0.media?.imageURL?.absoluteString ?? $0.media?.image })
        var selected: [ContentPreview] = []
        let distinct = candidates.filter { candidate in
            let image = candidate.media?.imageURL?.absoluteString ?? candidate.media?.image
            return !ids.contains(candidate.id) && (image.map { !images.contains($0) } ?? true)
        }
        let visual = distinct.filter { $0.hasSourceImage || WebsiteExamples.files[$0.id] != nil }
        // A single readable text cover is preferable to narrow text columns;
        // never mix a typographic Skill into an available visual composition.
        let pool = visual.isEmpty ? Array(distinct.prefix(1)) : visual
        for candidate in pool {
            let image = candidate.media?.imageURL?.absoluteString ?? candidate.media?.image
            guard !ids.contains(candidate.id), image.map({ !images.contains($0) }) ?? true else { continue }
            ids.insert(candidate.id)
            if let image { images.insert(image) }
            selected.append(candidate)
            if selected.count == limit { break }
        }
        return selected
    }
}

struct CollectionRail: View {
    var query = FeedQuery(sort: "discovery")
    @Environment(Library.self) private var library
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    private var collections: [Collection] {
        ["portraits", "play", "graphics", "web", "video"].compactMap { id in Collection.all.first { $0.id == id } }
    }
    private var waiting: Bool {
        guard let feed = library.feed else { return false }
        return feed.discovery.query != query ||
            (feed.browse.value == nil && feed.browse.failure == nil) ||
            (feed.discovery.release == nil && feed.discovery.failure == nil)
    }
    private var covers: [String: [ContentPreview]] {
        var result: [String: [ContentPreview]] = [:]
        let page = Array((library.feed?.discovery.query == query ? library.feed?.discovery.items ?? [] : []).prefix(30)).filter { !library.isRemoved(id: $0.id) }
        var excluded = library.feed.map { feed in
            Array(page.prefix(8)).map(ContentPreview.init) + feed.creatorDiscovery.items.prefix(12).compactMap { feed.creatorPreview($0).map(ContentPreview.init) }
        } ?? Array(library.prompts.prefix(8)).map(ContentPreview.init)
        for collection in collections {
            let additional = page.filter { card in
                (collection.kind == nil || card.kind == collection.kind) &&
                    (collection.tags.isEmpty || !collection.tags.isDisjoint(with: card.tags))
            }.map(ContentPreview.init)
            let candidates = collection.previews(in: library) + additional
            let selected = HomeCoverSelection.select(candidates, avoiding: excluded)
            result[collection.id] = selected
            excluded += selected
        }
        return result
    }
    var body: some View {
        let selected = covers
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text(String(localized: "按用途探索")).font(Typography.editorial(.title3))
                    .foregroundStyle(Palette.ink).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 12)
                NavigationLink { CollectionsDirectory() } label: {
                    Text(String(localized: "查看全部")).font(.footnote).foregroundStyle(Palette.muted).frame(minHeight: 44)
                }.accessibilityIdentifier("allCollections")
            }.padding(.horizontal, 20)
            if typeSize.isAccessibilitySize || voiceOverEnabled {
                VStack(spacing: 12) { ForEach(collections.prefix(1)) { collection in
                    NavigationLink { CollectionDetail(collection: collection) } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(collection.title).font(Typography.editorial(.title3))
                                Text(collection.subtitle).font(.subheadline).foregroundStyle(Palette.muted)
                            }
                            Spacer(); Image(systemName: "chevron.right").font(.caption).foregroundStyle(Palette.muted)
                        }.multilineTextAlignment(.leading).frame(minHeight: 44)
                            .padding(16).background(Palette.soft, in: RoundedRectangle(cornerRadius: 14))
                    }.buttonStyle(.plain)
                } }.padding(.horizontal, 20)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: 12) {
                        ForEach(collections) { collection in
                            NavigationLink { CollectionDetail(collection: collection) } label: {
                                VStack(alignment: .leading, spacing: 8) {
                                    ZStack {
                                        Palette.soft
                                        if waiting { LoadingSurface() }
                                        else if let previews = selected[collection.id], !previews.isEmpty {
                                            HStack(spacing: 2) {
                                                ForEach(previews) { cover in
                                                    Artwork(preview: cover, compact: true, fillsFrame: true)
                                                        .frame(maxWidth: .infinity).clipped()
                                                }
                                            }
                                        } else {
                                            // A topic identity is honest when the small candidate
                                            // pool has no distinct cover. No fake work or duplicate.
                                            HStack(spacing: 16) {
                                                Image(systemName: collection.kind?.symbol ?? "sparkles")
                                                    .font(.system(size: 28, weight: .light))
                                                Text(collection.subtitle).font(.subheadline)
                                                    .lineLimit(3).multilineTextAlignment(.leading)
                                            }.foregroundStyle(Palette.muted).padding(20)
                                        }
                                    }.frame(height: 116).clipShape(RoundedRectangle(cornerRadius: 14)).accessibilityHidden(true)
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(collection.title).font(.subheadline.weight(.medium))
                                            .lineLimit(1)
                                        Text(String(localized: "\(collection.count(in: library)) 条内容"))
                                            .font(.caption).foregroundStyle(Palette.muted)
                                            .redacted(reason: waiting ? .placeholder : [])
                                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 2)
                                }.frame(width: 246)
                                    .foregroundStyle(Palette.ink).multilineTextAlignment(.leading).contentShape(Rectangle())
                            }.buttonStyle(.plain).accessibilityIdentifier("home-collection-\(collection.id)")
                        }
                    }.padding(.horizontal, 20)
                }
            }
        }
            .task { await library.feed?.browse.load() }
    }
}
struct CollectionDetail: View {
    let collection: Collection
    @Environment(Library.self) private var library
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                Text(collection.title).font(Typography.editorial(.largeTitle)).foregroundStyle(Palette.ink).fixedSize(horizontal: false, vertical: true)
                Text(collection.subtitle).font(.subheadline).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                let items = collection.items(in: library)
                if let feed = library.feed {
                    OwnedFeedResults(repository: feed, query: FeedQuery(collection: collection.id, sort: "recommended"), fallback: items)
                } else if items.isEmpty {
                    ContentUnavailableView(String(localized: "暂无匹配内容"), systemImage: "sparkle", description: Text(String(localized: "试试其他分类，或清除筛选条件。")))
                } else { PromptGrid(items: items) }
            }.padding(20)
        }.background(Palette.paper).navigationTitle(String(localized: "专题")).navigationBarTitleDisplayMode(.inline)
    }
}
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(Library.self) private var library
    @State private var cleared = false
    @State private var showOnboarding = false
    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 10) {
                        SpectralPages(compact: true).frame(width: 40, height: 40)
                        Text("Prompix").font(.largeTitle.weight(.medium)).tracking(-1)
                    }.foregroundStyle(Palette.ink).padding(.top, 12).padding(.bottom, 20)
                        .listRowSeparator(.hidden)
                    LabeledContent(String(localized: "版本")) { Text("\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—") (\(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "—"))").foregroundStyle(Palette.muted) }
                    Link(String(localized: "App 语言与系统设置"), destination: URL(string: UIApplication.openSettingsURLString)!)
                    Button(String(localized: "onboarding.replay", table: "Onboarding")) { showOnboarding = true }
                        .accessibilityIdentifier("replayOnboarding")
                    Text(String(localized: "内容优先显示 App 语言的译文，可在详情中切回原文。作者名、代码和模型参数保持不变。")).font(.footnote).foregroundStyle(Palette.muted).listRowSeparator(.hidden)
                    if let updated = library.updatedAt { LabeledContent(String(localized: "最近更新")) { Text(updated, style: .date).foregroundStyle(Palette.muted) } }
                    Button(library.isRefreshing ? String(localized: "正在更新…") : String(localized: "检查内容更新")) { Task { await library.refresh(force: true) } }.disabled(library.isRefreshing)
                    if let message = library.syncMessage { Text(message).font(.footnote).foregroundStyle(Palette.muted) }
                }.listRowBackground(Color.clear)
                Section {
                    NavigationLink { RecommendationPreferences() } label: {
                        Label(RecommendationCopy.text("interests.title"), systemImage: "slider.horizontal.3")
                    }.accessibilityIdentifier("recommendationPreferences")
                }.listRowBackground(Color.clear)
                Section {
                    Button(cleared ? String(localized: "图片缓存已清理") : String(localized: "清理图片缓存")) { ImageStore.shared.clear(); cleared = true }
                    Text(String(localized: "清理浏览缓存，保留收藏缩略图、Prompt 文字和编辑草稿。")).font(.footnote).foregroundStyle(Palette.muted).listRowSeparator(.hidden)
                    Text(String(localized: "收藏和草稿保存在本机，不上传编辑内容。搜索词会发送到内容服务以查询结果，不用于广告或用户画像。没有广告与分析 SDK。删除 App 会清除本地数据。"))
                        .font(.footnote).foregroundStyle(Palette.muted).listRowSeparator(.hidden)
                    Text(String(localized: "视频仅在你点开时播放，离开播放器或切到后台后暂停。内置内容可离线浏览；外部工具需要网络。"))
                        .font(.footnote).foregroundStyle(Palette.muted).listRowSeparator(.hidden)
                } header: { Text(String(localized: "本地数据")).font(.footnote.weight(.semibold)).foregroundStyle(Palette.muted) }.listRowBackground(Color.clear)
                Section {
                    Text(String(localized: "内容来自 Prompix 原创与开放社区，每条保留作者和原始来源。每天收集新内容，打开 App 时检查更新；也可以在发现页下拉刷新。不同模型的实际生成结果可能不同。"))
                        .font(.footnote).foregroundStyle(Palette.muted).listRowSeparator(.hidden)
                } header: { Text(String(localized: "内容与更新")).font(.footnote.weight(.semibold)).foregroundStyle(Palette.muted) }.listRowBackground(Color.clear)
                Section {
                    Link(String(localized: "帮助与反馈"), destination: SupportLinks.url(.support)).accessibilityIdentifier("supportWebsite")
                    Link(String(localized: "隐私说明"), destination: SupportLinks.url(.privacy)).accessibilityIdentifier("privacyPolicy")
                    Link(String(localized: "内容来源与说明"), destination: SupportLinks.url(.content)).accessibilityIdentifier("contentPolicy")
                    Link(String(localized: "Prompix 官网"), destination: SupportLinks.url(.home))
                    Link(String(localized: "开源项目"), destination: URL(string: "https://github.com/p697/prompix")!)
                } header: { Text(String(localized: "帮助与信息")).font(.footnote.weight(.semibold)).foregroundStyle(Palette.muted) }.listRowBackground(Color.clear)
            }.listStyle(.plain).contentMargins(.horizontal, 20)
                .scrollContentBackground(.hidden).background(Palette.paper)
                .tint(Palette.accent)
                .navigationTitle(String(localized: "关于与设置")).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { dismiss() } } }
        }.fullScreenCover(isPresented: $showOnboarding) { PrompixOnboarding { showOnboarding = false } }
    }
}
