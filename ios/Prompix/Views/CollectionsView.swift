import SwiftUI

struct Collection: Identifiable {
    let id: String
    let title: String
    let subtitle: String
    let topic: String
    let symbol: String
    let color: Color
    static let all: [Collection] = [
        .init(id: "play", title: "生活，偶尔不按剧本。", subtitle: "塔罗、故事与一点善意的胡闹", topic: "好玩一点", symbol: "sparkle", color: Color(red: 0.92, green: 0.88, blue: 0.77)),
        .init(id: "make", title: "给想象，一个出口。", subtitle: "从一张照片，到一个属于你的网站", topic: "创作灵感", symbol: "sun.max", color: Color(red: 0.80, green: 0.85, blue: 0.78)),
        .init(id: "daily", title: "让日常，轻一点。", subtitle: "少一些费力，多一点自己的时间", topic: "日常有用", symbol: "wind", color: Color(red: 0.81, green: 0.85, blue: 0.87))
    ]
}
struct CollectionsView: View {
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Text("有时候，灵感是一连串的。 ").font(.subheadline).foregroundStyle(.secondary)
                    ForEach(Collection.all) { collection in
                        NavigationLink { CollectionDetail(collection: collection) } label: {
                            VStack(alignment: .leading, spacing: 16) {
                                HStack { Text("A SMALL COLLECTION").font(.system(.caption2, design: .monospaced)).tracking(2); Spacer(); Image(systemName: "arrow.up.right") }
                                Image(systemName: collection.symbol).font(.system(size: 50, weight: .ultraLight)).padding(.vertical, 12)
                                Text(collection.title).font(.title3.weight(.medium))
                                Text(collection.subtitle).font(.caption)
                            }.foregroundStyle(Color(red: 0.22, green: 0.26, blue: 0.21)).padding(24).frame(maxWidth: .infinity, alignment: .leading)
                                .background(collection.color, in: RoundedRectangle(cornerRadius: 20))
                        }.buttonStyle(.plain)
                    }
                }.padding(20).padding(.bottom, 20)
            }.navigationTitle("专题")
        }
    }
}
struct CollectionDetail: View {
    let collection: Collection
    @Environment(Library.self) private var library
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(collection.subtitle).font(.subheadline).foregroundStyle(.secondary)
                PromptGrid(items: library.prompts.filter { $0.tags.contains(collection.topic) })
            }.padding(16)
        }.navigationTitle(collection.title).navigationBarTitleDisplayMode(.inline)
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
                        Text("prompix").font(.system(size: 32, weight: .semibold, design: .serif))
                        Text("让好奇，变成创造。 ").font(.subheadline).foregroundStyle(.secondary)
                    }.padding(.vertical, 12)
                    LabeledContent("版本", value: "0.2.0 · Preview")
                    LabeledContent("灵感数量", value: String(library.prompts.count))
                    if let updated = library.updatedAt { LabeledContent("本期更新") { Text(updated, style: .date) } }
                    Button(library.isRefreshing ? "正在更新…" : "检查内容更新") { Task { await library.refresh(force: true) } }.disabled(library.isRefreshing)
                    if let message = library.syncMessage { Text(message).font(.caption).foregroundStyle(.secondary) }
                }
                Section("你的内容，留在你的设备上") {
                    Button(cleared ? "图片缓存已清理" : "清理图片缓存") { ImageStore.shared.clear(); cleared = true }
                    Text("只清理远程图片，不会删除收藏和 Prompt 文字。").font(.caption).foregroundStyle(.secondary)
                    Text("收藏和编辑都在本机完成。这一版没有账号、不上传输入、不收集行为数据。删除 App 会清除本地收藏。")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Text("视频仅在你点开时播放，离开播放器或切到后台后暂停。内置内容可离线浏览；外部工具需要网络。")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Section("内容与更新") {
                    Text("内容来自 Prompix 原创与开放社区，每条保留作者和原始来源。每天收集新内容，打开 App 时检查更新；也可以在发现页下拉刷新。不同模型的实际生成结果可能不同。")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Link("项目与反馈", destination: URL(string: "https://github.com/p697/prompix/issues")!)
                    Link("内容来源与说明", destination: URL(string: "https://github.com/p697/prompix/blob/main/docs/content-policy.md")!)
                }
            }.navigationTitle("关于与设置").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }
}
