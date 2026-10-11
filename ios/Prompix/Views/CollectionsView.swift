import SwiftUI

struct Collection: Identifiable {
    let id: String
    let title: String
    let subtitle: String
    let topic: String
    static let all: [Collection] = [
        .init(id: "play", title: String(localized: "生活，偶尔不按剧本。"), subtitle: String(localized: "塔罗、故事与一点善意的胡闹"), topic: "好玩一点"),
        .init(id: "make", title: String(localized: "给想象，一个出口。"), subtitle: String(localized: "从一张照片，到一个属于你的网站"), topic: "创作灵感"),
        .init(id: "daily", title: String(localized: "让日常，轻一点。"), subtitle: String(localized: "少一些费力，多一点自己的时间"), topic: "日常有用")
    ]
    @MainActor func items(in library: Library) -> [Prompt] { library.prompts.filter { $0.fits(topic: topic) } }
    func covers(from items: [Prompt]) -> [Prompt] {
        let previewable = items.filter {
            $0.kind == .text || $0.media?.image != nil || $0.media?.imageURL != nil || WebsiteExamples.files[$0.id] != nil
        }
        var result: [Prompt] = []
        for item in previewable where !result.contains(where: { $0.kind == item.kind }) { result.append(item) }
        for item in previewable where !result.contains(where: { $0.id == item.id }) { result.append(item) }
        return Array(result.prefix(3))
    }
}
struct CollectionsView: View {
    @Environment(Library.self) private var library
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 32) {
                    Text(String(localized: "有时候，灵感是一连串的。 ")).font(.subheadline).foregroundStyle(Palette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(Collection.all) { collection in
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
                                Text(String(localized: "\(items.count) 个灵感")).font(.footnote).foregroundStyle(Palette.muted)
                            }.foregroundStyle(.primary).multilineTextAlignment(.leading)
                        }.buttonStyle(.plain)
                            .accessibilityLabel("\(collection.title) \(collection.subtitle) \(String(localized: "\(items.count) 个灵感"))")
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
                    ContentUnavailableView(String(localized: "灵感还在路上"), systemImage: "sparkle", description: Text(String(localized: "试试其他分类，或回到全部精选。")))
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
                        Text(String(localized: "让好奇，变成创造。 ")).font(.subheadline).foregroundStyle(Palette.muted)
                    }.padding(.vertical, 12)
                    LabeledContent(String(localized: "版本")) { Text("\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—") (\(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "—"))").foregroundStyle(Palette.muted) }
                    LabeledContent(String(localized: "灵感数量")) { Text(String(library.prompts.count)).foregroundStyle(Palette.muted) }
                    Link(String(localized: "App 语言与系统设置"), destination: URL(string: UIApplication.openSettingsURLString)!)
                    Text(String(localized: "Prompt 与示例保留原作者的语言。")).font(.footnote).foregroundStyle(Palette.muted)
                    if let updated = library.updatedAt { LabeledContent(String(localized: "本期更新")) { Text(updated, style: .date).foregroundStyle(Palette.muted) } }
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
                } header: { Text(String(localized: "你的内容，留在你的设备上")).font(.footnote.weight(.semibold)).foregroundStyle(Palette.muted) }
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
