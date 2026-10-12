import SwiftUI

struct PromptUseSheet: View {
    let item: Prompt
    let text: String
    var title: String? = nil
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @AppStorage("preferredPromptDestination") private var preferred = "source"
    @State private var selected: String?
    @State private var copied = false
    @State private var openFailed = false
    private var destinations: [PromptDestination] { PromptDestination.choices(for: item) }
    private var destination: PromptDestination? {
        destinations.first { $0.id == (selected ?? preferred) } ?? destinations.first
    }
    private var command: String? { PromptDestination.installationCommand(for: item) }
    private var transferText: String { item.isSkill ? command ?? text : text }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(title ?? item.displayTitle).font(Typography.editorial(.title3)).fixedSize(horizontal: false, vertical: true)
                    if item.isSkill {
                        Text(String(localized: "在电脑上的编程助手中安装。安装时会询问目标工具；完整文件夹会一并获取。"))
                            .font(.subheadline).foregroundStyle(Palette.muted)
                    } else {
                        Text(String(localized: "选择工具，复制后即可粘贴使用。发送前请确认内容，参考图片和文件需在目标工具中添加。"))
                            .font(.subheadline).foregroundStyle(Palette.muted)
                    }
                }.listRowBackground(Palette.surface)
                if !item.isSkill && !destinations.isEmpty {
                    Section(String(localized: "选择工具")) {
                        ForEach(destinations) { target in
                            Button {
                                selected = target.id; preferred = target.id; openFailed = false
                            } label: {
                                HStack(spacing: 12) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(target.name).font(.body).foregroundStyle(Palette.ink)
                                        Text(target.url.host ?? "").font(.caption).foregroundStyle(Palette.muted)
                                    }
                                    Spacer()
                                    Image(systemName: destination?.id == target.id ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(destination?.id == target.id ? Palette.accent : Palette.muted)
                                }.padding(.vertical, 5).contentShape(Rectangle())
                            }.accessibilityIdentifier("destination-\(target.id)")
                                .accessibilityAddTraits(destination?.id == target.id ? .isSelected : [])
                        }
                    }.listRowBackground(Palette.surface)
                }
                Section(item.isSkill && command != nil ? String(localized: "安装命令") : String(localized: "准备好的内容")) {
                    DisclosureGroup(String(localized: "查看完整内容")) {
                        Text(transferText).font(.footnote.monospaced()).textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("handoffText")
                    }.accessibilityIdentifier("handoffPreview")
                    Button {
                        UIPasteboard.general.string = transferText; copied = true
                    } label: { Label(copied ? String(localized: "已复制") : String(localized: "复制"), systemImage: copied ? "checkmark" : "doc.on.doc") }
                        .accessibilityIdentifier("handoffCopy").disabled(transferText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    ShareLink(item: transferText) { Label(String(localized: "分享"), systemImage: "square.and.arrow.up") }
                        .accessibilityIdentifier("handoffShare").disabled(transferText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }.listRowBackground(Palette.surface)
                if openFailed {
                    Section {
                        Text(String(localized: "未能打开工具。内容已复制，可手动打开目标 App 后粘贴。"))
                            .foregroundStyle(Palette.muted).accessibilityIdentifier("handoffOpenError")
                    }.listRowBackground(Palette.surface)
                }
                if let skill = item.skill {
                    Section {
                        Link(destination: skill.installURL) { Label(String(localized: "查看源文件与安装说明"), systemImage: "arrow.up.right") }
                    }.listRowBackground(Palette.surface)
                }
            }
            .scrollContentBackground(.hidden).background(Palette.paper)
            .navigationTitle(item.isSkill ? String(localized: "使用这个 Skill") : String(localized: "使用 Prompt"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { dismiss() } } }
            .safeAreaInset(edge: .bottom) {
                if let destination {
                    Button {
                        UIPasteboard.general.string = text; copied = true; openFailed = false
                        preferred = destination.id
                        openURL(destination.url) { accepted in openFailed = !accepted }
                    } label: {
                        PrimaryActionLabel(title: String(localized: "复制并打开工具"), compactTitle: String(localized: "复制并打开"), symbol: "arrow.up.right")
                    }.buttonStyle(.plain).padding(20).background(Palette.paper).accessibilityIdentifier("handoffOpen").disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } else if item.isSkill, command != nil {
                    Button {
                        UIPasteboard.general.string = transferText; copied = true
                    } label: {
                        PrimaryActionLabel(title: copied ? String(localized: "已复制") : String(localized: "复制安装命令"), compactTitle: String(localized: "复制"), symbol: copied ? "checkmark" : "terminal")
                    }.buttonStyle(.plain).padding(20).background(Palette.paper).accessibilityIdentifier("copyInstallCommand")
                }
            }.sensoryFeedback(.success, trigger: copied)
        }
    }
}
