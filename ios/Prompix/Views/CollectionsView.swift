import SwiftUI

struct Collection: Identifiable {
    let id: String
    let title: String
    let subtitle: String
    let tags: Set<String>
    var kind: PromptKind? = nil
    static let all: [Collection] = [
        .init(id: "play", title: String(localized: "趣味聊天"), subtitle: String(localized: "猜谜、角色扮演与趣味互动"), tags: ["好玩一点", "趣味互动"], kind: .text),
        .init(id: "portraits", title: String(localized: "人像与角色"), subtitle: String(localized: "摄影布光、人物造型与原创角色"), tags: ["人物肖像", "人像摄影", "肖像", "人像", "写真", "角色创作", "角色设计"]),
        .init(id: "products", title: String(localized: "产品与商业摄影"), subtitle: String(localized: "商品静物、场景布置与品牌画面"), tags: ["产品摄影", "产品设计", "商品摄影", "商业摄影", "产品海报", "品牌视觉"]),
        .init(id: "graphics", title: String(localized: "海报与信息图"), subtitle: String(localized: "文字排版、视觉层次与信息表达"), tags: ["海报设计", "信息图", "信息图表", "排版", "平面设计", "字体设计"]),
        .init(id: "illustration", title: String(localized: "插画与概念设计"), subtitle: String(localized: "不同画风、场景设定与视觉实验"), tags: ["插画", "插画设计", "概念设计", "绘本", "像素艺术"]),
        .init(id: "writing", title: String(localized: "写作与故事"), subtitle: String(localized: "短篇、文案、诗歌与文字修改"), tags: ["写作表达", "故事创作", "品牌文案", "写作", "故事", "文案"]),
        .init(id: "learning", title: String(localized: "学习与思考"), subtitle: String(localized: "语言练习、知识解释与思路梳理"), tags: ["学习方法", "英文学习", "思考训练", "学习", "知识解释"]),
        .init(id: "daily", title: String(localized: "工作与生活"), subtitle: String(localized: "邮件、面试、旅行与日常安排"), tags: ["工作效率", "求职面试", "旅行生活", "生活记录", "创作策划", "效率", "工作", "生活", "沟通"]),
        .init(id: "video", title: String(localized: "视频创作"), subtitle: String(localized: "运镜、转场与动态场景的实际案例"), tags: [], kind: .video),
        .init(id: "web", title: String(localized: "网页与小工具"), subtitle: String(localized: "作品集、网站与可以操作的工具"), tags: [], kind: .web)
    ]
    func includes(_ prompt: Prompt) -> Bool {
        if let kind, prompt.kind != kind { return false }
        return tags.isEmpty || !tags.isDisjoint(with: prompt.tags)
    }
    @MainActor func items(in library: Library) -> [Prompt] { library.prompts.filter(includes) }
    func covers(from items: [Prompt]) -> [Prompt] {
        let previewable = items.filter {
            $0.kind == .text || $0.media?.image != nil || $0.media?.imageURL != nil || WebsiteExamples.files[$0.id] != nil
        }
        var result: [Prompt] = []
        for item in previewable where !result.contains(where: { $0.kind == item.kind }) {
            result.append(item)
            if result.count == 3 { return result }
        }
        for item in previewable where !result.contains(where: { $0.id == item.id }) {
            result.append(item)
            if result.count == 3 { return result }
        }
        return result
    }
}
struct CollectionsView: View {
    @Environment(Library.self) private var library
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 32) {
                    ForEach(Collection.all.filter { !($0.items(in: library)).isEmpty }) { collection in
                        let items = collection.items(in: library)
                        NavigationLink { CollectionDetail(collection: collection) } label: {
                            VStack(alignment: .leading, spacing: 14) {
                                HStack(spacing: 6) {
                                    ForEach(collection.covers(from: items)) { item in
                                        Artwork(item: item, compact: true).frame(maxWidth: .infinity).clipped()
                                    }
                                }.frame(height: typeSize.isAccessibilitySize ? 130 : 190)
                                    .background(Palette.soft).clipShape(RoundedRectangle(cornerRadius: 16))
                                HStack(alignment: .firstTextBaseline, spacing: 12) {
                                    Text(collection.title).font(.title3.weight(.medium))
                                        .fixedSize(horizontal: false, vertical: true)
                                    Spacer(minLength: 0)
                                    Image(systemName: "arrow.up.right").font(.system(size: 16, weight: .regular))
                                }
                                Text(collection.subtitle).font(.subheadline).foregroundStyle(Palette.muted)
                                    .fixedSize(horizontal: false, vertical: true)
                                Text(String(localized: "\(items.count) 个 Prompt")).font(.footnote).foregroundStyle(Palette.muted)
                            }.foregroundStyle(.primary).multilineTextAlignment(.leading)
                        }.buttonStyle(.plain)
                            .accessibilityLabel("\(collection.title) \(collection.subtitle) \(String(localized: "\(items.count) 个 Prompt"))")
                            .accessibilityIdentifier("collection-\(collection.id)")
                    }
                }.padding(20).padding(.bottom, 20)
            }.navigationTitle(String(localized: "专题"))
        }
    }
}
struct CollectionDetail: View {
    let collection: Collection
    @Environment(Library.self) private var library
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(collection.title).font(.title2.weight(.medium)).fixedSize(horizontal: false, vertical: true)
                Text(collection.subtitle).font(.subheadline).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                let items = collection.items(in: library)
                if items.isEmpty {
                    ContentUnavailableView(String(localized: "暂无匹配内容"), systemImage: "sparkle", description: Text(String(localized: "试试其他分类，或清除筛选条件。")))
                } else { PromptGrid(items: items) }
            }.padding(16)
        }.navigationTitle(String(localized: "专题")).navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: Prompt.self) { PromptDetail(item: $0) }
    }
}
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(Library.self) private var library
    @State private var cleared = false
    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("prompix").font(.system(.largeTitle, design: .serif, weight: .semibold))
                    }.padding(.vertical, 12)
                    LabeledContent(String(localized: "版本")) { Text("\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—") (\(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "—"))").foregroundStyle(Palette.muted) }
                    LabeledContent(String(localized: "Prompt 数量")) { Text(String(library.prompts.count)).foregroundStyle(Palette.muted) }
                    Link(String(localized: "App 语言与系统设置"), destination: URL(string: UIApplication.openSettingsURLString)!)
                    Text(String(localized: "Prompt 与示例保留原作者的语言。")).font(.footnote).foregroundStyle(Palette.muted)
                    if let updated = library.updatedAt { LabeledContent(String(localized: "最近更新")) { Text(updated, style: .date).foregroundStyle(Palette.muted) } }
                    Button(library.isRefreshing ? String(localized: "正在更新…") : String(localized: "检查内容更新")) { Task { await library.refresh(force: true) } }.disabled(library.isRefreshing)
                    if let message = library.syncMessage { Text(message).font(.footnote).foregroundStyle(Palette.muted) }
                }
                Section {
                    Button(cleared ? String(localized: "图片缓存已清理") : String(localized: "清理图片缓存")) { ImageStore.shared.clear(); cleared = true }
                    Text(String(localized: "清理浏览缓存，保留收藏缩略图、Prompt 文字和编辑草稿。")).font(.footnote).foregroundStyle(Palette.muted)
                    Text(String(localized: "收藏和草稿保存在本机，不上传编辑内容或搜索词，也没有广告与分析 SDK。下载内容仍需要网络请求。删除 App 会清除其本地数据。"))
                        .font(.subheadline).foregroundStyle(Palette.muted)
                    Text(String(localized: "视频仅在你点开时播放，离开播放器或切到后台后暂停。内置内容可离线浏览；外部工具需要网络。"))
                        .font(.subheadline).foregroundStyle(Palette.muted)
                } header: { Text(String(localized: "本地数据")).font(.footnote.weight(.semibold)).foregroundStyle(Palette.muted) }
                Section {
                    Text(String(localized: "内容来自 Prompix 原创与开放社区，每条保留作者和原始来源。每天收集新内容，打开 App 时检查更新；也可以在发现页下拉刷新。不同模型的实际生成结果可能不同。"))
                        .font(.subheadline).foregroundStyle(Palette.muted)
                } header: { Text(String(localized: "内容与更新")).font(.footnote.weight(.semibold)).foregroundStyle(Palette.muted) }
                Section {
                    Link(String(localized: "帮助与反馈"), destination: SupportLinks.url(.support)).accessibilityIdentifier("supportWebsite")
                    Link(String(localized: "隐私说明"), destination: SupportLinks.url(.privacy)).accessibilityIdentifier("privacyPolicy")
                    Link(String(localized: "内容来源与说明"), destination: SupportLinks.url(.content)).accessibilityIdentifier("contentPolicy")
                    Link(String(localized: "Prompix 官网"), destination: SupportLinks.url(.home))
                    Link(String(localized: "开源项目"), destination: URL(string: "https://github.com/p697/prompix")!)
                } header: { Text(String(localized: "帮助与信息")).font(.footnote.weight(.semibold)).foregroundStyle(Palette.muted) }
            }.navigationTitle(String(localized: "关于与设置")).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { dismiss() } } }
        }
    }
}
