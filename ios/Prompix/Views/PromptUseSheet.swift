import SwiftUI

struct PromptUseSheet: View {
    let item: Prompt
    let language: String?
    private let sourceText: String?
    @State private var text: String
    @State private var draftText: String
    @State private var usingSource = false
    private let onPrepared: (String) -> Bool
    private let onEdit: ((String) -> Void)?
    @State private var editorPresented = false
    @State private var variablesPresented = false
    @State private var saveFailed = false
    @State private var leavePresented = false
    var title: String? = nil
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.dynamicTypeSize) private var typeSize
    @AppStorage("preferredPromptDestination") private var preferred = "source"
    @State private var selected: String?
    @State private var previewExpanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var copied = false
    @State private var openFailed = false

    init(item: Prompt, text: String, sourceText: String? = nil, title: String? = nil, language: String? = nil,
         onEdit: ((String) -> Void)? = nil, onPrepared: @escaping (String) -> Bool) {
        self.item = item; self.title = title; self.language = language
        self.sourceText = sourceText; self.onPrepared = onPrepared; self.onEdit = onEdit
        _text = State(initialValue: text)
        _draftText = State(initialValue: text)
    }
    private var template: PromptTemplate { PromptTemplate(text, enabled: !item.isSkill) }
    private var destinations: [PromptDestination] { PromptDestination.choices(for: item) }
    private var destination: PromptDestination? {
        destinations.first { $0.id == (selected ?? preferred) } ?? destinations.first
    }
    private var command: String? { PromptDestination.installationCommand(for: item) }
    private var transferText: String { item.isSkill ? command ?? text : text }
    private var prepared: PromptDestination.Transfer? { destination?.transfer(text) }
    private var hasAlternative: Bool { !item.isSkill && sourceText.map { $0 != draftText } == true }
    private var canTransfer: Bool { !transferText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private func open(_ transfer: PromptDestination.Transfer) {
        UIPasteboard.general.string = transfer.text; copied = true; openFailed = false
        openURL(transfer.url) { accepted in openFailed = !accepted }
    }
    private func selectSource(_ useSource: Bool) {
        // Switching the outgoing version is not an edit and must never overwrite a saved draft.
        guard !saveFailed, let sourceText else { return }
        usingSource = useSource
        text = useSource ? sourceText : draftText
        copied = false; openFailed = false
    }
    private func acceptEdits(_ updated: String) {
        text = updated; draftText = updated; usingSource = false
        copied = false; openFailed = false
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    Text(title ?? item.displayTitle)
                        .font(Typography.editorial(.title2)).fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    if !destinations.isEmpty { toolPicker }
                    guidance
                    if saveFailed {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(String(localized: "尚未保存，可先复制保留")).accessibilityIdentifier("preparedPromptSaveError")
                            Button(String(localized: "重试保存")) { saveFailed = !onPrepared(text) }
                                .frame(minHeight: 44)
                        }
                    }
                    if item.isSkill, let command {
                        Button { open(PromptDestination.claudeCode.transfer(command)) } label: {
                            Label(String(localized: "在 Claude Code 中准备安装"), systemImage: "arrow.up.right")
                                .frame(minHeight: 44)
                        }.accessibilityIdentifier("skillCodeOpen")
                        Text(String(localized: "需要 Claude Code 权限。安装命令会填入输入框，请选择自己的项目并确认发送。"))
                            .font(.subheadline).foregroundStyle(Palette.muted).accessibilityIdentifier("skillCodeGuidance")
                    }
                    Divider().overlay(Palette.line)
                    contentPreview
                    if openFailed {
                        Text(String(localized: "未能打开工具。内容已复制，可手动打开目标 App 后粘贴。"))
                            .font(.subheadline).foregroundStyle(Palette.muted).accessibilityIdentifier("handoffOpenError")
                    }
                    if let skill = item.skill {
                        Link(destination: skill.installURL) {
                            Label(String(localized: "查看源文件与安装说明"), systemImage: "arrow.up.right").frame(minHeight: 44)
                        }
                    }
                }
                .frame(maxWidth: 560, alignment: .leading)
                .padding(24).frame(maxWidth: .infinity)
            }
            .accessibilityIdentifier("handoffScroll")
            .background(Palette.paper).foregroundStyle(Palette.ink).tint(Palette.accent)
            .sheet(isPresented: $editorPresented) {
                PromptEditor(item: item, language: language, initialText: text, readingPreview: usingSource) { updated in
                    // Merely inspecting the reading version must not replace a personal draft.
                    if updated == text && !saveFailed { return true }
                    let saved = onPrepared(updated)
                    if saved { acceptEdits(updated); saveFailed = false }
                    return saved
                }
            }
            .sheet(isPresented: $variablesPresented) {
                PromptVariablesSheet(template: template) { prepared in
                    acceptEdits(prepared)
                    saveFailed = !onPrepared(prepared)
                }
            }
            .navigationTitle(item.isSkill ? String(localized: "使用这个 Skill") : String(localized: "使用 Prompt"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "完成")) {
                        if saveFailed { leavePresented = true } else { dismiss() }
                    }.accessibilityIdentifier("finishPromptUse")
                }
            }
            .promptActionBar { primaryAction.padding(.horizontal, 24).padding(.vertical, 16) }
            .sensoryFeedback(.success, trigger: copied)
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

    private var toolPicker: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(String(localized: "选择工具")).font(.subheadline).foregroundStyle(Palette.muted)
            LazyVGrid(columns: typeSize.isAccessibilitySize ? [GridItem(.flexible())] : [GridItem(.adaptive(minimum: 140), spacing: 10)], spacing: 10) {
                ForEach(destinations) { target in
                    Button {
                        selected = target.id; preferred = target.id; openFailed = false
                    } label: {
                        HStack(spacing: 8) {
                            Text(target.name).font(.body.weight(.medium)).fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                            Image(systemName: destination?.id == target.id ? "checkmark.circle.fill" : "circle")
                                .font(.body).accessibilityHidden(true)
                        }
                        .padding(.horizontal, 16).padding(.vertical, 14).frame(maxWidth: .infinity, minHeight: 54)
                        .foregroundStyle(destination?.id == target.id ? Palette.accent : Palette.ink)
                        .background(destination?.id == target.id ? Palette.soft : Color.clear, in: RoundedRectangle(cornerRadius: 18))
                        .overlay { RoundedRectangle(cornerRadius: 18).strokeBorder(destination?.id == target.id ? Palette.accent.opacity(0.35) : Palette.line, lineWidth: 1) }
                        .contentShape(RoundedRectangle(cornerRadius: 18))
                    }.buttonStyle(.plain)
                        .accessibilityLabel(target.id == "v0" ? Prompt.localizedModel("v0 / 网站生成工具") : target.name)
                        .accessibilityValue(target.url.host ?? "")
                        .accessibilityIdentifier("destination-\(target.id)")
                        .accessibilityAddTraits(destination?.id == target.id ? .isSelected : [])
                }
            }
            if destination?.id == PromptDestination.claudeCode.id {
                Text(String(localized: "需要 Claude Code 权限，并在目标工具中选择你的项目。"))
                    .font(.subheadline).foregroundStyle(Palette.muted).accessibilityIdentifier("codeAccessGuidance")
            }
        }
    }

    private var guidance: some View {
        Group {
            if item.isSkill {
                Text(command == nil ? String(localized: "在电脑上的编程助手中安装。安装时会询问目标工具；完整文件夹会一并获取。") : String(localized: "复制安装命令到编程助手，或在手机上的 Claude Code 中继续。完整文件夹会一并获取。"))
            } else if PromptDestination.requiresDesktop(for: item) {
                Text(String(localized: "此工作流需要电脑上的代码工具。复制或分享内容，在电脑中继续。"))
                    .accessibilityIdentifier("desktopWorkflowGuidance")
            } else if prepared?.includesPrompt == true {
                Text(String(localized: "内容将填入目标工具，由你确认发送。参考图片和文件需另行添加。"))
                    .accessibilityIdentifier("prefillGuidance")
            } else if destination?.supportsPrefill == true && canTransfer {
                Text(String(localized: "内容较长，将复制全文；打开工具后粘贴即可。"))
                    .accessibilityIdentifier("prefillFallbackGuidance")
            } else {
                Text(String(localized: "选择工具，复制后即可粘贴使用。发送前请确认内容，参考图片和文件需在目标工具中添加。"))
            }
        }.font(.subheadline).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
    }

    private var contentPreview: some View {
        VStack(alignment: .leading, spacing: 16) {
            if hasAlternative {
                VStack(alignment: .leading, spacing: 8) {
                    Picker(String(localized: "version.label", table: "UsePrompt"), selection: Binding(get: { usingSource }, set: selectSource)) {
                        Text(String(localized: "version.reading", table: "UsePrompt")).tag(true)
                        Text(String(localized: "version.edited", table: "UsePrompt")).tag(false)
                    }.pickerStyle(.menu).disabled(saveFailed).accessibilityIdentifier("handoffVersion")
                    Text(String(localized: "version.note", table: "UsePrompt"))
                        .font(.caption).foregroundStyle(Palette.muted)
                }
            } else {
                Text(item.isSkill && command != nil ? String(localized: "安装命令") : String(localized: "准备好的内容"))
                    .font(.subheadline).foregroundStyle(Palette.muted)
            }
            if !previewExpanded {
                Text(String(transferText.prefix(360)))
                    .font(item.isSkill ? .subheadline.monospaced() : .body)
                    .foregroundStyle(Palette.ink).lineSpacing(5).lineLimit(4)
                    .accessibilityIdentifier("handoffExcerpt")
            }
            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { previewExpanded.toggle() }
            } label: {
                HStack {
                    Text(previewExpanded ? String(localized: "收起正文") : String(localized: "查看完整内容"))
                        .contentTransition(.identity)
                    Spacer()
                    Image(systemName: "chevron.right").rotationEffect(.degrees(previewExpanded ? 90 : 0)).accessibilityHidden(true)
                }.frame(minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).font(.subheadline).accessibilityIdentifier("handoffPreview")
            if previewExpanded {
                Text(transferText).font(.body.monospaced()).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("handoffText")
            }
            if !item.isSkill {
                if typeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 4) { editingActions }
                } else {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 20) { editingActions }
                        VStack(alignment: .leading, spacing: 4) { editingActions }
                    }
                }
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 24) { transferActions }
                VStack(alignment: .leading, spacing: 4) { transferActions }
            }
        }
    }

    @ViewBuilder private var editingActions: some View {
        Button {
            if let onEdit, !usingSource { onEdit(text) } else { editorPresented = true }
        } label: {
            Label(String(localized: "编辑 Prompt"), systemImage: "square.and.pencil").fixedSize(horizontal: false, vertical: true).frame(minHeight: 44)
        }.accessibilityIdentifier("editPreparedPrompt")
        if !template.fields.isEmpty {
            Button { variablesPresented = true } label: {
                Label(String(localized: "填写变量"), systemImage: "text.cursor").fixedSize(horizontal: false, vertical: true).frame(minHeight: 44)
            }.accessibilityIdentifier("preparePromptVariables")
        }
    }

    @ViewBuilder private var transferActions: some View {
        Button {
            UIPasteboard.general.string = transferText; copied = true
        } label: {
            Label(copied ? String(localized: "已复制") : String(localized: "复制"), systemImage: copied ? "checkmark" : "doc.on.doc").frame(minHeight: 44)
        }.accessibilityIdentifier("handoffCopy").disabled(!canTransfer)
        ShareLink(item: transferText) {
            Label(String(localized: "分享"), systemImage: "square.and.arrow.up").frame(minHeight: 44)
        }.accessibilityIdentifier("handoffShare").disabled(!canTransfer)
    }

    @ViewBuilder private var primaryAction: some View {
        if let destination {
            let action = String(format: String(localized: prepared?.includesPrompt == true ? "action.prefill" : "action.copyOpen", table: "UsePrompt"), locale: .current, destination.name)
            Button {
                preferred = destination.id
                open(destination.transfer(text))
            } label: {
                PrimaryActionLabel(title: action, compactTitle: prepared?.includesPrompt == true ? String(localized: "打开并填入") : String(localized: "复制并打开"), symbol: "arrow.up.right")
            }.buttonStyle(.plain).accessibilityLabel(action).accessibilityIdentifier("handoffOpen").disabled(!canTransfer)
        } else if PromptDestination.requiresDesktop(for: item) {
            Button {
                UIPasteboard.general.string = text; copied = true
            } label: {
                PrimaryActionLabel(title: copied ? String(localized: "已复制") : String(localized: "复制完整内容"), compactTitle: String(localized: "复制"), symbol: copied ? "checkmark" : "doc.on.doc")
            }.buttonStyle(.plain).accessibilityIdentifier("copyDesktopWorkflow").disabled(!canTransfer)
        } else if item.isSkill, command != nil {
            Button {
                UIPasteboard.general.string = transferText; copied = true
            } label: {
                PrimaryActionLabel(title: copied ? String(localized: "已复制") : String(localized: "复制安装命令"), compactTitle: String(localized: "复制"), symbol: copied ? "checkmark" : "terminal")
            }.buttonStyle(.plain).accessibilityIdentifier("copyInstallCommand")
        }
    }
}
