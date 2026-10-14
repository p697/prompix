import SwiftUI

struct PromptUseSheet: View {
    let item: Prompt
    let language: String?
    @State private var text: String
    private let onPrepared: (String) -> Bool
    private let onEdit: ((String) -> Void)?
    @State private var editorPresented = false
    @State private var variablesPresented = false
    @State private var saveFailed = false
    @State private var leavePresented = false
    var title: String? = nil
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @AppStorage("preferredPromptDestination") private var preferred = "source"
    @State private var selected: String?
    @State private var copied = false
    @State private var openFailed = false
    init(item: Prompt, text: String, title: String? = nil, language: String? = nil, onEdit: ((String) -> Void)? = nil, onPrepared: @escaping (String) -> Bool) {
        self.item = item; self.title = title; self.language = language; self.onPrepared = onPrepared; self.onEdit = onEdit
        _text = State(initialValue: text)
    }
    private var template: PromptTemplate { PromptTemplate(text, enabled: !item.isSkill) }
    private var destinations: [PromptDestination] { PromptDestination.choices(for: item) }
    private var destination: PromptDestination? {
        destinations.first { $0.id == (selected ?? preferred) } ?? destinations.first
    }
    private var command: String? { PromptDestination.installationCommand(for: item) }
    private var transferText: String { item.isSkill ? command ?? text : text }
    private var prepared: PromptDestination.Transfer? { destination?.transfer(text) }
    private func open(_ transfer: PromptDestination.Transfer) {
        UIPasteboard.general.string = transfer.text; copied = true; openFailed = false
        openURL(transfer.url) { accepted in openFailed = !accepted }
    }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(title ?? item.displayTitle).font(Typography.editorial(.title2)).fixedSize(horizontal: false, vertical: true)
                        if item.isSkill {
                            Text(command == nil ? String(localized: "在电脑上的编程助手中安装。安装时会询问目标工具；完整文件夹会一并获取。") : String(localized: "复制安装命令到编程助手，或在手机上的 Claude Code 中继续。完整文件夹会一并获取。"))
                                .font(.subheadline).foregroundStyle(Palette.muted)
                        } else if PromptDestination.requiresDesktop(for: item) {
                            Text(String(localized: "此工作流需要电脑上的代码工具。复制或分享内容，在电脑中继续。"))
                                .font(.subheadline).foregroundStyle(Palette.muted).accessibilityIdentifier("desktopWorkflowGuidance")
                        } else if prepared?.includesPrompt == true {
                            Text(String(localized: "内容将填入目标工具，由你确认发送。参考图片和文件需另行添加。"))
                                .font(.subheadline).foregroundStyle(Palette.muted).accessibilityIdentifier("prefillGuidance")
                        } else if destination?.supportsPrefill == true && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            Text(String(localized: "内容较长，将复制全文；打开工具后粘贴即可。"))
                                .font(.subheadline).foregroundStyle(Palette.muted).accessibilityIdentifier("prefillFallbackGuidance")
                        } else {
                            Text(String(localized: "选择工具，复制后即可粘贴使用。发送前请确认内容，参考图片和文件需在目标工具中添加。"))
                                .font(.subheadline).foregroundStyle(Palette.muted)
                        }
                    }.padding(.vertical, 4)
                }.listRowBackground(Color.clear).listRowSeparator(.hidden)
                if !item.isSkill {
                    Section {
                        Button {
                            if let onEdit { onEdit(text) } else { editorPresented = true }
                        } label: {
                            Label(String(localized: "编辑 Prompt"), systemImage: "square.and.pencil").frame(minHeight: 44)
                        }.accessibilityIdentifier("editPreparedPrompt")
                        if !template.fields.isEmpty {
                            Button { variablesPresented = true } label: {
                                Label(String(localized: "填写变量"), systemImage: "text.cursor").frame(minHeight: 44)
                            }.accessibilityIdentifier("preparePromptVariables")
                        }
                    }.listRowBackground(Palette.surface)
                }
                if saveFailed {
                    Section {
                        Text(String(localized: "尚未保存，可先复制保留")).accessibilityIdentifier("preparedPromptSaveError")
                        Button(String(localized: "重试保存")) { saveFailed = !onPrepared(text) }
                    }.listRowBackground(Palette.surface)
                }
                if !item.isSkill && !destinations.isEmpty {
                    Section {
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
                            }.accessibilityLabel(target.id == "v0" ? Prompt.localizedModel("v0 / 网站生成工具") : target.name)
                                .accessibilityValue(target.url.host ?? "")
                                .accessibilityIdentifier("destination-\(target.id)")
                                .accessibilityAddTraits(destination?.id == target.id ? .isSelected : [])
                        }
                    } header: {
                        Text(String(localized: "选择工具"))
                    } footer: {
                        if destination?.id == PromptDestination.claudeCode.id {
                            Text(String(localized: "需要 Claude Code 权限，并在目标工具中选择你的项目。"))
                                .accessibilityIdentifier("codeAccessGuidance")
                        }
                    }.listRowBackground(Palette.surface)
                }
                if item.isSkill, let command {
                    Section {
                        Button { open(PromptDestination.claudeCode.transfer(command)) } label: {
                            Label(String(localized: "在 Claude Code 中准备安装"), systemImage: "arrow.up.right")
                                .frame(minHeight: 44)
                        }.accessibilityIdentifier("skillCodeOpen")
                    } header: {
                        Text(String(localized: "在手机上继续"))
                    } footer: {
                        Text(String(localized: "需要 Claude Code 权限。安装命令会填入输入框，请选择自己的项目并确认发送。"))
                            .accessibilityIdentifier("skillCodeGuidance")
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
            .sheet(isPresented: $editorPresented) {
                PromptEditor(item: item, language: language, initialText: text) { updated in
                    let saved = onPrepared(updated)
                    if saved {
                        text = updated; copied = false; openFailed = false; saveFailed = false
                    }
                    return saved
                }
            }
            .sheet(isPresented: $variablesPresented) {
                PromptVariablesSheet(template: template) { prepared in
                    text = prepared; copied = false; openFailed = false
                    saveFailed = !onPrepared(prepared)
                }
            }
            .navigationTitle(item.isSkill ? String(localized: "使用这个 Skill") : String(localized: "使用 Prompt"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "完成")) {
                        if saveFailed { leavePresented = true } else { dismiss() }
                    }.accessibilityIdentifier("finishPromptUse")
                }
            }
            .promptActionBar {
                if let destination {
                    Button {
                        preferred = destination.id
                        open(destination.transfer(text))
                    } label: {
                        PrimaryActionLabel(title: prepared?.includesPrompt == true ? String(localized: "打开并填入") : String(localized: "复制并打开工具"), compactTitle: prepared?.includesPrompt == true ? String(localized: "打开并填入") : String(localized: "复制并打开"), symbol: "arrow.up.right")
                    }.buttonStyle(.plain).padding(20).background(Palette.paper).accessibilityIdentifier("handoffOpen").disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } else if PromptDestination.requiresDesktop(for: item) {
                    Button {
                        UIPasteboard.general.string = text; copied = true
                    } label: {
                        PrimaryActionLabel(title: copied ? String(localized: "已复制") : String(localized: "复制完整内容"), compactTitle: String(localized: "复制"), symbol: copied ? "checkmark" : "doc.on.doc")
                    }.buttonStyle(.plain).padding(20).background(Palette.paper).accessibilityIdentifier("copyDesktopWorkflow")
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } else if item.isSkill, command != nil {
                    Button {
                        UIPasteboard.general.string = transferText; copied = true
                    } label: {
                        PrimaryActionLabel(title: copied ? String(localized: "已复制") : String(localized: "复制安装命令"), compactTitle: String(localized: "复制"), symbol: copied ? "checkmark" : "terminal")
                    }.buttonStyle(.plain).padding(20).background(Palette.paper).accessibilityIdentifier("copyInstallCommand")
                }
            }.sensoryFeedback(.success, trigger: copied)
        }
        .promptSheet()
        .interactiveDismissDisabled(saveFailed)
        .alert(String(localized: "本次修改尚未保存"), isPresented: $leavePresented) {
            Button(String(localized: "复制并退出")) {
                UIPasteboard.general.string = text
                dismiss()
            }.accessibilityIdentifier("copyPreparedPromptAndLeave")
            Button(String(localized: "放弃本次修改并退出"), role: .destructive) { dismiss() }
                .accessibilityIdentifier("discardPreparedPromptAndLeave")
            Button(String(localized: "继续编辑"), role: .cancel) {}
        }
    }
}
