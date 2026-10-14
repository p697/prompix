import SwiftUI
import AVKit
import Combine
import Observation

struct PromptDetail: View {
    private let snapshot: Prompt
    private let origin: PromptDetailOrigin
    @Environment(Library.self) private var library
    @State private var editorContext: EditorContext?
    @State private var useContext: UseContext?
    @State private var imagePresented = false
    @Namespace private var imageTransition
    @State private var playerPresented = false
    @State private var copied = false
    @State private var webPresented = false
    @State private var language: String?
    @State private var hasChosenLanguage = false
    @State private var pendingLanguage: String?
    @State private var failedLanguage: String?
    @State private var languageRequestID: UUID?
    @State private var languageTask: Task<Void, Never>?
    @State private var actionsCollapsed = false
    @Namespace private var actionTransition
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.colorScheme) private var colorScheme
    private struct UseContext: Identifiable {
        let id = UUID()
        let item: Prompt
        let text: String
        let title: String
        let language: String?
    }
    private struct EditorContext: Identifiable {
        let id = UUID()
        let item: Prompt
        let language: String?
    }
    private var item: Prompt { library.resolvedDetail(snapshot, origin: origin) }
    private var effectiveLanguage: String? { language.flatMap { item.availableLanguages.contains($0) ? $0 : nil } }
    private var content: Prompt.TranslatedContent { item.content(in: effectiveLanguage) }
    private var displaysOriginalContent: Bool { content == item.content(in: nil) }
    private var spokenLicense: String {
        // Give the common abbreviation a pronounceable name for VoiceOver.
        item.source.license == "CC0-1.0" ? "Creative Commons Zero" : item.source.license
    }
    init(item: Prompt, origin: PromptDetailOrigin = .catalog) {
        snapshot = item
        self.origin = origin
        _language = State(initialValue: item.preferredTranslation)
    }
    private var related: [Prompt] {
        RelatedPrompts.select(for: item, from: library.prompts)
    }
    var body: some View {
        detailLayout
        .background(Palette.paper).foregroundStyle(Palette.ink)
        .toolbarBackground(.hidden, for: .navigationBar)
        .toolbarColorScheme(colorScheme, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: "\(content.title)\n\n\(content.prompt)\n\n\(String(localized: "来自")) \(item.source.author ?? item.source.name) · \(item.source.license)\n\(item.source.url?.absoluteString ?? "https://prompix.dev")") { Label(String(localized: "分享"), systemImage: "square.and.arrow.up").frame(minWidth: 44, minHeight: 44) }
                    .accessibilityIdentifier("sharePrompt")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { library.toggle(item) } label: {
                    Label(library.isSaved(item) ? String(localized: "取消收藏") : String(localized: "收藏 Prompt"), systemImage: library.isSaved(item) ? "bookmark.fill" : "bookmark")
                        .frame(minWidth: 44, minHeight: 44)
                }
                    .accessibilityLabel(library.isSaved(item) ? String(localized: "取消收藏") : String(localized: "收藏 Prompt")).accessibilityIdentifier("detailFavorite")
                    .disabled(library.isRemoved(item))
            }
        }
        .promptActionBar { readingActions }
        .onChange(of: content) { _, _ in copied = false }
        .onChange(of: item.preferredTranslation, initial: true) { _, preferred in
            if !hasChosenLanguage { language = preferred }
        }
        .onChange(of: library.isRemoved(item)) { _, removed in
            if removed { cancelLanguageSelection(); failedLanguage = nil }
        }
        .onDisappear { if languageRequestID != nil { cancelLanguageSelection() } }
        .sheet(item: $useContext) { context in
            PromptUseSheet(item: context.item, text: context.text, title: context.title, language: context.language, onPrepared: { prepared in
                let saved = library.saveDraft(prepared, for: context.item, language: context.language)
                if !saved { library.dismissError() }
                return saved
            })
        }
        .sheet(item: $editorContext) { context in PromptEditor(item: context.item, language: context.language) }
        .fullScreenCover(isPresented: $imagePresented) {
            ImageViewer(name: item.media?.image ?? item.artwork, urls: item.media?.galleryURLs ?? [])
                .promptTransitionDestination(id: "image-\(item.id)", in: imageTransition)
        }
        .sheet(isPresented: $webPresented) {
            if let filename = WebsiteExamples.files[item.id] { WebExample(filename: filename) }
        }
        .sheet(isPresented: $playerPresented) { MovieView(filename: item.media?.video, remoteURL: item.media?.videoURL, caption: content.previewLabel) }
    }
    private var hasMediaPreview: Bool {
        WebsiteExamples.files[item.id] != nil || item.kind == .video || item.media?.image != nil || item.media?.imageURL != nil
    }
    private var previewTitle: String {
        WebsiteExamples.files[item.id] != nil ? String(localized: "打开网页作品") : item.kind == .video ? String(localized: "播放视频") : String(localized: "放大图片")
    }
    private func openPreview() {
        if WebsiteExamples.files[item.id] != nil { webPresented = true }
        else if item.kind == .video { playerPresented = true }
        else { imagePresented = true }
    }
    @ViewBuilder private var detailLayout: some View {
        if #available(iOS 27.1, *), hasMediaPreview {
            ArrangementView {
                ScrollView {
                    readingContent.padding(.bottom, 28).frame(maxWidth: 700).frame(maxWidth: .infinity)
                }.readingChrome($actionsCollapsed).accessibilityIdentifier("detailReadingPane")
            } secondary: {
                ScrollView {
                    largePreview.padding(.bottom, 24).frame(maxWidth: 600).frame(maxWidth: .infinity)
                }.accessibilityIdentifier("detailMediaPane")
            }.arrangementViewStyle(.split.axes(.horizontal))
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 25) {
                    largePreview
                    readingContent
                }.padding(.bottom, 28).frame(maxWidth: 700).frame(maxWidth: .infinity)
            }.readingChrome($actionsCollapsed).accessibilityIdentifier("detailReadingPane")
        }
    }
    private var compactPreview: some View {
        Button(action: openPreview) {
            HStack(spacing: 14) {
                Artwork(item: item).frame(width: 76, height: 86).clipped()
                    .clipShape(RoundedRectangle(cornerRadius: 10)).accessibilityHidden(true)
                Label(previewTitle, systemImage: item.kind == .video ? "play.circle" : WebsiteExamples.files[item.id] != nil ? "safari" : "arrow.up.left.and.arrow.down.right")
                    .font(.subheadline.weight(.medium)).multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }.padding(10).background(Palette.surface, in: RoundedRectangle(cornerRadius: 14))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityLabel(previewTitle).accessibilityIdentifier("compactPreviewButton")
    }
    @ViewBuilder private var largePreview: some View {
        if hasMediaPreview {
            Button(action: openPreview) {
                hero.overlay(alignment: .bottomTrailing) {
                    if WebsiteExamples.files[item.id] != nil {
                        Label(String(localized: "打开作品"), systemImage: "safari").font(.subheadline.weight(.medium))
                            .padding(.horizontal, 16).padding(.vertical, 12).background(.regularMaterial, in: Capsule()).padding(16)
                    } else {
                        Image(systemName: item.kind == .video ? "play.fill" : (item.media?.galleryURLs.count ?? 0) > 1 ? "square.stack" : "arrow.up.left.and.arrow.down.right")
                            .font(.body).padding(14).background(.regularMaterial, in: Circle()).padding(16)
                    }
                }
            }.buttonStyle(.plain).accessibilityLabel(previewTitle).accessibilityIdentifier("previewButton")
        }
    }
    private var readingContent: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 14) {
                Text(content.title).font(Typography.editorial(.title)).lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                if !content.summary.isEmpty {
                    Text(content.summary).font(.body).lineSpacing(4).foregroundStyle(Palette.muted)
                }
                if let creator = item.creator { CreatorByline(creator: creator) }
            }
            if #available(iOS 27.1, *), hasMediaPreview { compactPreview }
            languagePicker
            PromptMarkdown(content.prompt)
                .accessibilityIdentifier("promptBody")
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 20) {
                    Label("\(item.displayKind) · \(item.displayModel)", systemImage: item.displaySymbol)
                        .font(.footnote).foregroundStyle(Palette.muted)
                    if item.kind != .text { Text(content.previewLabel).font(.footnote).foregroundStyle(Palette.muted) }
                    Text(content.example).font(.body).lineSpacing(5).textSelection(.enabled)
                    if let skill = item.skill { SkillInformation(skill: skill) }
                    if WebsiteExamples.files[item.id] != nil {
                        Button { webPresented = true } label: {
                            Label(String(localized: "打开原创网页示例"), systemImage: "safari").frame(minHeight: 44)
                        }.accessibilityIdentifier("webExample")
                    }
                    if let demo = item.media?.demoURL {
                        Link(String(localized: "打开网页示例"), destination: demo).frame(minHeight: 44)
                    }
                    sourceInformation
                }.padding(.top, 16)
            } label: {
                Text(String(localized: "说明与来源")).font(.subheadline.weight(.medium)).frame(minHeight: 44)
                    .accessibilityIdentifier("promptInformation")
            }
            if !related.isEmpty {
                Divider()
                HStack { Text(String(localized: "相关 Prompt")).font(.headline).accessibilityAddTraits(.isHeader); Spacer(); Image(systemName: "arrow.down.right").foregroundStyle(Palette.muted).accessibilityHidden(true) }
                PromptGrid(items: related)
            }
        }.padding(.horizontal, 22).padding(.top, 12)
    }
    private var sourceInformation: some View {
            VStack(alignment: .leading, spacing: 8) {
                ViewThatFits(in: .horizontal) {
                    HStack { sourceAuthor; Spacer(); sourceKind }
                    VStack(alignment: .leading, spacing: 6) { sourceAuthor; sourceKind }
                }
                Text(item.source.license == "X-API-Terms" ? String(localized: "通过 X API 收录") : item.source.license).font(.footnote).foregroundStyle(Palette.muted)
                    .accessibilityLabel(String(localized: "内容许可：\(spokenLicense)"))
                if let post = item.source.post {
                    if let date = post.date {
                        Text(date, format: .dateTime.year().month().day().hour().minute())
                            .font(.caption).foregroundStyle(Palette.muted)
                    }
                    DisclosureGroup(String(localized: "查看 X 原帖")) {
                        Text(post.text).font(.subheadline).lineSpacing(5).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 10)
                    }.font(.subheadline).accessibilityIdentifier("originalXPost")
                }
                if let context = item.source.context {
                    ForEach(context, id: \.id) { source in
                        DisclosureGroup(source.id == item.source.mediaPostID ? String(localized: "作品原帖") : String(localized: "上下文原帖")) {
                            VStack(alignment: .leading, spacing: 10) {
                                if let date = source.date { Text(date, format: .dateTime.year().month().day().hour().minute()).foregroundStyle(Palette.muted) }
                                Text(source.text).textSelection(.enabled).lineSpacing(5)
                                if let url = URL(string: "https://x.com/i/web/status/\(source.id)") {
                                    Link(String(localized: "在 X 查看"), destination: url).frame(minHeight: 44)
                                }
                            }.font(.subheadline).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 10)
                        }.font(.subheadline).accessibilityIdentifier("sourceContext-\(source.id)")
                    }
                }
                if let repository = item.source.repository { Link(destination: repository) { Text(String(localized: "收录于 \(item.source.name)")).font(.footnote).frame(minHeight: 44).contentShape(Rectangle()) } }
                if let source = item.source.url { Link(destination: source) { Text(String(localized: "查看原始来源 ↗")).font(.footnote).frame(minHeight: 44).contentShape(Rectangle()) } }
                Link(destination: SupportLinks.url(.report, contentID: item.id)) { Text(String(localized: "反馈这条内容")).font(.footnote).frame(minHeight: 44).contentShape(Rectangle()) }.accessibilityIdentifier("reportContent")
            }
    }
    private var readingActions: some View {
        Group {
            if #available(iOS 26, *) {
                GlassEffectContainer(spacing: 12) { actionButtons }
            } else { actionButtons }
        }
        .padding(.horizontal, 20).padding(.vertical, 8)
        .frame(maxWidth: 600).frame(maxWidth: .infinity)
        .animation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.86), value: actionsCollapsed)
        .accessibilityElement(children: .contain).accessibilityIdentifier(actionsCollapsed ? "readingActionsCompact" : "readingActionsExpanded")
    }
    private var actionButtons: some View {
        HStack(spacing: 10) {
            Button(action: openEditor) {
                Image(systemName: "square.and.pencil").font(.body).frame(width: 50, height: 50)
            }.buttonStyle(.plain).readingGlass().actionGlassIdentity("edit", in: actionTransition)
                .accessibilityLabel(String(localized: "编辑后使用")).accessibilityIdentifier("editPromptAction")
            Button {
                UIPasteboard.general.string = content.prompt; copied = true
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.body).frame(width: 50, height: 50)
            }.buttonStyle(.plain).readingGlass().actionGlassIdentity("copy", in: actionTransition)
                .accessibilityLabel(copied ? String(localized: "已复制") : String(localized: "复制 Prompt"))
                .accessibilityIdentifier("copyPrompt").sensoryFeedback(.success, trigger: copied)
            Button(action: openUseSheet) {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.up.right")
                    if !actionsCollapsed {
                        Text(typeSize.isAccessibilitySize ? String(localized: "使用") : item.isSkill ? String(localized: "使用这个 Skill") : String(localized: "使用 Prompt"))
                            .lineLimit(1).minimumScaleFactor(0.8)
                    }
                }.font(.body.weight(.semibold)).frame(minWidth: 50, maxWidth: actionsCollapsed ? 50 : .infinity, minHeight: 50)
                    .foregroundStyle(colorScheme == .dark ? Color(red: 26 / 255, green: 30 / 255, blue: 24 / 255) : Color(red: 252 / 255, green: 252 / 255, blue: 249 / 255))
            }.buttonStyle(.plain).readingGlass(prominent: true).actionGlassIdentity("use", in: actionTransition)
                .accessibilityLabel(item.isSkill ? String(localized: "使用这个 Skill") : String(localized: "使用 Prompt"))
                .accessibilityIdentifier("usePrompt")
        }.dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }
    private func openUseSheet() {
        let prepared = library.draft(for: item, language: effectiveLanguage)
        guard !prepared.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { openEditor(); return }
        useContext = UseContext(item: item, text: prepared, title: content.title, language: effectiveLanguage)
    }
    private var sourceAuthor: some View {
        Text(item.source.author ?? item.source.name).font(.footnote.weight(.medium))
    }
    private var sourceKind: some View {
        Text(item.source.name == "Prompix Studio" ? String(localized: "原创内容") : String(localized: "社区收录"))
            .font(.footnote).foregroundStyle(Palette.muted)
    }
    private var languagePicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 12) { languageSummary; Spacer(minLength: 4); languageMenu }
                VStack(alignment: .leading, spacing: 10) { languageSummary; languageMenu }
            }
            if library.isRemoved(item) {
                Text(String(localized: "这条内容已被移除，无法再保存。你仍可复制当前文字。"))
                    .font(.footnote).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            } else if let pendingLanguage {
                HStack(alignment: .top, spacing: 10) {
                    ProgressView().controlSize(.small)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(ContentLanguage.name(pendingLanguage)).font(.footnote.weight(.medium))
                        Text(String(localized: "正在下载此语言，当前内容仍可使用。"))
                            .font(.caption).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                    }
                }.accessibilityElement(children: .combine).accessibilityIdentifier("languageDownloadProgress")
            } else if let failedLanguage {
                VStack(alignment: .leading, spacing: 4) {
                    Text(ContentLanguage.name(failedLanguage)).font(.footnote.weight(.medium))
                    Text(String(localized: "此语言暂时无法下载，当前内容已保留。"))
                        .font(.caption).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                    Button(String(localized: "重试")) { selectLanguage(failedLanguage) }
                        .font(.footnote.weight(.medium)).frame(minHeight: 44).accessibilityIdentifier("retryLanguageDownload")
                }.accessibilityElement(children: .contain).accessibilityIdentifier("languageDownloadFailure")
            }
        }
    }
    private var languageSummary: some View {
        Text(displaysOriginalContent ? String(localized: "当前显示原文") : String(localized: "AI 译文"))
            .font(.caption).foregroundStyle(Palette.muted)
    }
    @ViewBuilder private var languageMenu: some View {
            if !library.isRemoved(item), !library.advertisedLanguages(for: item).isEmpty {
                Menu {
                    Button { selectOriginal() } label: {
                        if effectiveLanguage == nil { Label(String(localized: "原文"), systemImage: "checkmark") }
                        else { Text(String(localized: "原文")) }
                    }.accessibilityIdentifier("contentLanguage-original")
                    ForEach(library.advertisedLanguages(for: item), id: \.self) { code in
                        Button { selectLanguage(code) } label: {
                            if effectiveLanguage == code { Label(ContentLanguage.name(code), systemImage: "checkmark") }
                            else if !item.availableLanguages.contains(code) { Label(ContentLanguage.name(code), systemImage: "arrow.down.circle") }
                            else { Text(ContentLanguage.name(code)) }
                        }.accessibilityIdentifier("contentLanguage-\(code)")
                            .accessibilityHint(item.availableLanguages.contains(code) ? "" : String(localized: "下载后切换到此语言"))
                    }
                } label: {
                    Label(effectiveLanguage.map(ContentLanguage.name) ?? String(localized: "原文"), systemImage: "globe")
                        .font(.subheadline).frame(minHeight: 44)
                }.accessibilityIdentifier("contentLanguage")
            }
    }
    private func openEditor() {
        // Capture both together: a catalog or locale install must not change an open editor's baseline.
        editorContext = EditorContext(item: item, language: effectiveLanguage)
    }
    private func cancelLanguageSelection() {
        languageRequestID = nil
        languageTask?.cancel(); languageTask = nil; pendingLanguage = nil
        // Cancelling this caller propagates to its owned Library task. A detail
        // disappearing late must not cancel a newer detail's language request.
    }
    private func selectOriginal() {
        hasChosenLanguage = true
        cancelLanguageSelection(); failedLanguage = nil; language = nil
    }
    private func selectLanguage(_ code: String) {
        hasChosenLanguage = true
        cancelLanguageSelection(); failedLanguage = nil
        let request = UUID(), requestedItem = item
        languageRequestID = request; pendingLanguage = code
        languageTask = Task { @MainActor in
            let available = await library.ensureLanguage(code, for: requestedItem)
            guard !Task.isCancelled, languageRequestID == request else { return }
            languageRequestID = nil; languageTask = nil; pendingLanguage = nil
            if available && item.availableLanguages.contains(code) && !library.isRemoved(item) { language = code }
            else { failedLanguage = code }
        }
    }
    private var hero: some View {
        Artwork(item: item).aspectRatio(item.media?.aspectRatio.map { max(0.65, min(1.8, $0)) } ?? (item.kind == .image ? 0.95 : 1.15), contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .promptTransitionSource(id: "image-\(item.id)", in: imageTransition)
            .padding(.horizontal, 12).padding(.top, 8)
    }

}

private struct StablePromptEditor: View {
    @Binding var text: String
    @FocusState.Binding var focused: Bool

    var body: some View {
        // Preserve the editing task while UIKit manages selection and marked input.
        TextEditor(text: $text)
            .focused($focused)
    }
}

struct PromptEditor: View {
    let item: Prompt
    let language: String?
    private let initialText: String?
    private let onSave: ((String) -> Bool)?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(Library.self) private var library
    @State private var text: String
    @State private var copied = false
    @State private var initialized = false
    @State private var saved = true
    @State private var saveError: String?
    @State private var restorePresented = false
    @State private var usePresented = false
    @State private var leavePresented = false
    @State private var leavingWithoutSaving = false
    @State private var variablesPresented = false
    @State private var headerHeight: CGFloat?
    @FocusState private var editorFocused: Bool
    init(item: Prompt, language: String? = nil, initialText: String? = nil, onSave: ((String) -> Bool)? = nil) {
        self.item = item; self.language = language; self.initialText = initialText; self.onSave = onSave
        _text = State(initialValue: initialText ?? item.content(in: language).prompt)
    }
    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                VStack(alignment: .leading, spacing: 12) {
                    ScrollView {
                        editorHeader.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                            if height > 0 { headerHeight = height }
                        }
                    }
                    .frame(height: min(headerHeight ?? geometry.size.height * 0.45, max(0, geometry.size.height * 0.45)))
                    .accessibilityIdentifier("draftStatusScroll")
                    StablePromptEditor(text: $text, focused: $editorFocused)
                        .font(.body).scrollContentBackground(.hidden).padding(.horizontal, 16)
                        .frame(maxHeight: .infinity).accessibilityIdentifier("promptEditor")
                }
            }.paperScreen().navigationTitle(String(localized: "编辑 Prompt")).navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if #available(iOS 27.1, *) {
                        ToolbarItem(placement: .primaryAction) {
                            Button(action: copyEdits) {
                                Label(copied ? String(localized: "已复制修改后的 Prompt") : String(localized: "复制修改后的 Prompt"),
                                      systemImage: copied ? "checkmark" : "doc.on.doc")
                            }.accessibilityIdentifier("copyEditedPrompt")
                                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                .sensoryFeedback(.success, trigger: copied)
                        }
                    }
                    ToolbarItem(placement: .cancellationAction) {
                        Button(String(localized: "完成")) { if save() { dismiss() } }.accessibilityIdentifier("finishPromptEditing")
                    }
                    ToolbarItem(placement: .primaryAction) {
                        Menu {
                            ShareLink(item: text) { Label(String(localized: "分享"), systemImage: "square.and.arrow.up") }
                                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            Button(language == nil ? String(localized: "恢复原始 Prompt") : String(localized: "恢复当前语言的内容"), systemImage: "arrow.counterclockwise", role: .destructive) { restorePresented = true }
                                .disabled(text == item.content(in: language).prompt)
                        } label: { Label(String(localized: "编辑选项"), systemImage: "ellipsis.circle") }
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        if onSave == nil {
                            Button { usePresented = true } label: { Label(String(localized: "使用"), systemImage: "arrow.up.right") }
                                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).accessibilityIdentifier("useEditedPrompt")
                        }
                    }
                }
                .sheet(isPresented: $usePresented) {
                    PromptUseSheet(item: item, text: text, title: item.content(in: language).title, language: language, onEdit: { prepared in
                        // An explicit return to editing carries unsaved variable input too.
                        text = prepared; saved = prepared == library.draft(for: item, language: language)
                        usePresented = false
                    }, onPrepared: { prepared in
                        // Keep failed child edits out of this editor's autosave buffer.
                        let committed = library.saveDraft(prepared, for: item, language: language)
                        if committed { text = prepared; saved = true; saveError = nil }
                        else { library.dismissError() }
                        return committed
                    })
                }
                .sheet(isPresented: $variablesPresented) {
                    PromptVariablesSheet(template: PromptTemplate(text, enabled: !item.isSkill)) { prepared in
                        text = prepared; save()
                    }
                }
                .promptActionBar {
                    if #unavailable(iOS 27.1) {
                        Button(action: copyEdits) {
                            PrimaryActionLabel(title: copied ? String(localized: "已复制修改后的 Prompt") : String(localized: "复制修改后的 Prompt"),
                                compactTitle: copied ? String(localized: "已复制") : String(localized: "复制"), symbol: copied ? "checkmark" : "doc.on.doc")
                        }.buttonStyle(.plain).accessibilityIdentifier("copyEditedPrompt")
                            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .padding().background(Palette.paper).sensoryFeedback(.success, trigger: copied)
                    }
                }
                .onAppear {
                    guard !initialized else { return }
                    text = initialText ?? library.draft(for: item, language: language)
                    saved = text == library.draft(for: item, language: language); initialized = true
                }
                .onChange(of: text) { _, _ in copied = false; saved = text == library.draft(for: item, language: language); saveError = nil }
                .task(id: text) {
                    guard initialized else { return }
                    do { try await Task.sleep(for: .milliseconds(400)) } catch { return }
                    save()
                }
                .onDisappear { if initialized { save() } }
                .onChange(of: scenePhase) { _, phase in
                    if phase != .active, initialized { save() }
                }
                .confirmationDialog(language == nil ? String(localized: "恢复原始 Prompt？") : String(localized: "恢复当前语言的内容？"), isPresented: $restorePresented, titleVisibility: .visible) {
                    Button(language == nil ? String(localized: "恢复原文") : String(localized: "恢复译文"), role: .destructive) { text = item.content(in: language).prompt; save() }
                    Button(String(localized: "取消"), role: .cancel) {}
                } message: { Text(String(localized: "这会替换你在此设备上保存的修改。")) }
                .alert(String(localized: "本次修改尚未保存"), isPresented: $leavePresented) {
                    Button(String(localized: "复制并退出")) {
                        UIPasteboard.general.string = text
                        leaveWithoutSaving()
                    }.accessibilityIdentifier("copyDraftAndLeave")
                    Button(String(localized: "放弃本次修改并退出"), role: .destructive) { leaveWithoutSaving() }
                        .accessibilityIdentifier("discardDraftAndLeave")
                    Button(String(localized: "继续编辑"), role: .cancel) {}
                }
        }
        .promptSheet()
        .interactiveDismissDisabled(!saved || text != library.draft(for: item, language: language))
    }
    private var editorHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let saveError {
                ViewThatFits(in: .horizontal) {
                    HStack { saveRecoveryActions }
                    VStack(alignment: .leading) { saveRecoveryActions }
                }
                Text(saveError).font(.footnote).foregroundStyle(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("draftSaveError")
            }
            if let language { Text(ContentLanguage.name(language)).font(.footnote.weight(.medium)).foregroundStyle(Palette.accent) }
            Text(typeSize.isAccessibilitySize ? String(localized: "原文会保留。") : String(localized: "修改会保存到此设备，原始 Prompt 会保留。"))
                .font(.footnote).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            HStack {
                Label(saved ? String(localized: "已保存到此设备") : saveError != nil ? String(localized: "尚未保存，可先复制保留") : String(localized: "正在保存…"), systemImage: saved ? "checkmark.circle" : "circle.dotted")
                    .font(.footnote).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("draftStatus")
                if !typeSize.isAccessibilitySize {
                    Spacer()
                    Text(String(localized: "\(text.count) 字符")).font(.footnote.monospacedDigit()).foregroundStyle(Palette.muted)
                }
            }
            if !PromptTemplate(text, enabled: !item.isSkill).fields.isEmpty {
                Button(String(localized: "填写变量"), systemImage: "square.and.pencil") { variablesPresented = true }
                    .frame(minHeight: 44).accessibilityIdentifier("editPromptVariables")
            }
        }.padding(.horizontal, 20).padding(.top, 14)
            .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
    }
    private var saveRecoveryActions: some View {
        Group {
            Button(String(localized: "重试保存")) { save() }.accessibilityIdentifier("retryDraftSave")
            Button(String(localized: "退出编辑")) {
                editorFocused = false
                leavePresented = true
            }.accessibilityIdentifier("leaveUnsavedDraft")
        }.buttonStyle(.bordered).controlSize(.large)
    }
    private func copyEdits() {
        UIPasteboard.general.string = text
        copied = true
        save()
    }
    @discardableResult private func save() -> Bool {
        guard !leavingWithoutSaving else { return false }
        saved = onSave?(text) ?? library.saveDraft(text, for: item, language: language)
        saveError = saved ? nil : library.error ?? String(localized: "尚未保存，可先复制保留")
        // Present draft failures here: a root alert can dismiss this editor sheet.
        if !saved { library.dismissError() }
        return saved
    }
    private func leaveWithoutSaving() {
        // Explicitly abandoning edits must also stop pending lifecycle saves.
        leavingWithoutSaving = true
        dismiss()
    }
}

@MainActor @Observable final class MoviePlayback {
    private(set) var player: AVPlayer?
    private(set) var failed = false
    private(set) var loading = true
    private(set) var hasPlayed = false
    @ObservationIgnored private var timeObserver: Any?
    private(set) var aspectRatio: CGFloat = 16 / 9
    @ObservationIgnored private var subscriptions = Set<AnyCancellable>()
    @ObservationIgnored private var timeout: Task<Void, Never>?
    private let bufferingTimeout: Duration

    init(bufferingTimeout: Duration = .seconds(25)) { self.bufferingTimeout = bufferingTimeout }

    func start(url: URL?) {
        stop()
        failed = false; loading = true; hasPlayed = false; aspectRatio = 16 / 9
        guard let url, !url.isFileURL || FileManager.default.isReadableFile(atPath: url.path) else { fail(); return }
        let item = AVPlayerItem(url: url)
        let player = AVPlayer(playerItem: item)
        self.player = player
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self, weak player] time in
            Task { @MainActor in
                guard let self, let player, self.player === player, time.seconds > 0.25, player.rate > 0 else { return }
                self.hasPlayed = true
            }
        }
        item.publisher(for: \.status).receive(on: RunLoop.main).sink { [weak self] status in
            guard let self, self.player?.currentItem === item else { return }
            if status == .failed { self.fail() }
            // Item readiness does not mean the transport has enough buffered data.
            // The time-control observer owns the loading state and its deadline.
        }.store(in: &subscriptions)
        item.publisher(for: \.presentationSize).receive(on: RunLoop.main).sink { [weak self] size in
            guard let self, self.player?.currentItem === item, size.width > 0, size.height > 0 else { return }
            self.aspectRatio = size.width / size.height
        }.store(in: &subscriptions)
        player.publisher(for: \.timeControlStatus).receive(on: RunLoop.main).sink { [weak self] status in
            guard let self, self.player === player, !self.failed else { return }
            if status == .waitingToPlayAtSpecifiedRate { self.loading = true; self.armTimeout() }
            else if status == .playing { self.loading = false; self.timeout?.cancel() }
            else if status == .paused { self.loading = false; self.timeout?.cancel() }
        }.store(in: &subscriptions)
        NotificationCenter.default.publisher(for: AVPlayerItem.failedToPlayToEndTimeNotification, object: item)
            .receive(on: RunLoop.main).sink { [weak self] _ in
                guard let self, self.player?.currentItem === item else { return }; self.fail()
            }.store(in: &subscriptions)
        armTimeout()
        player.play()
    }
    private func armTimeout() {
        timeout?.cancel()
        let duration = bufferingTimeout
        timeout = Task { [weak self] in
            do { try await Task.sleep(for: duration) } catch { return }
            guard let self, self.loading else { return }
            self.fail()
        }
    }
    private func fail() {
        failed = true; loading = false; timeout?.cancel(); player?.pause()
    }
    func pause() { player?.pause(); timeout?.cancel(); loading = false }
    func stop() {
        timeout?.cancel(); timeout = nil; subscriptions.removeAll()
        if let timeObserver { player?.removeTimeObserver(timeObserver) }
        timeObserver = nil
        player?.pause(); player?.replaceCurrentItem(with: nil); player = nil; loading = false; hasPlayed = false
    }
}

struct MovieView: View {
    let filename: String?
    let remoteURL: URL?
    let caption: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var playback = MoviePlayback()
    private var url: URL? { remoteURL ?? filename.flatMap { Bundle.main.url(forResource: $0, withExtension: "mp4") } }
    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                if playback.failed {
                    ContentUnavailableView {
                        Label(String(localized: "视频暂不可用"), systemImage: "video.slash")
                    } description: {
                        Text(String(localized: "检查网络后再试。完整 Prompt 仍可复制使用。"))
                    } actions: {
                        Button(String(localized: "重新加载")) { playback.start(url: url) }.buttonStyle(.bordered).accessibilityIdentifier("retryVideo")
                    }
                } else if let player = playback.player {
                    VideoPlayer(player: player).aspectRatio(playback.aspectRatio, contentMode: .fit)
                        .accessibilityIdentifier(playback.hasPlayed ? "playingVideo" : "loadingVideo")
                        .overlay { if playback.loading { ProgressView(String(localized: "正在加载视频…")).padding(16).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14)).allowsHitTesting(false) } }
                }
                Text(caption).font(.footnote).foregroundStyle(Palette.muted).padding(.horizontal, 20)
            }.frame(maxWidth: .infinity, maxHeight: .infinity).background(.black).navigationTitle(String(localized: "视频预览")).navigationBarTitleDisplayMode(.inline)
                .toolbarColorScheme(.dark, for: .navigationBar)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { dismiss() } } }
                .onAppear { playback.start(url: url) }
                .onDisappear { playback.stop() }
                .onChange(of: scenePhase) { _, phase in if phase != .active { playback.pause() } }
        }.environment(\.colorScheme, .dark)
    }
}

struct ImageViewer: View {
    let name: String
    let urls: [URL]
    @State private var selection = 0
    @State private var zoomedPages: Set<Int> = []
    @State private var dragOffset: CGFloat = 0
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var count: Int { max(1, urls.count) }
    private var isZoomed: Bool { zoomedPages.contains(selection) }
    private var usesNativeTransition: Bool {
        if #available(iOS 18, *) { return !reduceMotion }
        return false
    }
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            pages
                .offset(y: reduceMotion ? 0 : dragOffset)
                .scaleEffect(reduceMotion ? 1 : 1 - min(dragOffset / 1800, 0.12))
                .opacity(reduceMotion ? 1 - min(dragOffset / 600, 0.3) : 1)
            VStack {
                HStack {
                    if count > 1 {
                        Text("\(selection + 1) / \(count)")
                            .font(.subheadline.monospacedDigit()).foregroundStyle(.white)
                            .padding(.horizontal, 16).padding(.vertical, 10)
                            .background(.black.opacity(0.45), in: Capsule())
                            .accessibilityIdentifier("imagePageCounter")
                    }
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark").font(.body.weight(.semibold))
                            .foregroundStyle(.white).frame(width: 44, height: 44)
                            .background(.ultraThinMaterial, in: Circle())
                    }.buttonStyle(.plain).accessibilityLabel(String(localized: "完成"))
                        .accessibilityIdentifier("closeImageViewer")
                }
                Spacer()
                if count > 1 {
                    HStack(spacing: 28) {
                        Button { selection -= 1 } label: {
                            Image(systemName: "chevron.left").frame(width: 44, height: 44)
                        }.disabled(selection == 0)
                            .accessibilityLabel(String(localized: "上一张")).accessibilityIdentifier("previousImage")
                        Button { selection += 1 } label: {
                            Image(systemName: "chevron.right").frame(width: 44, height: 44)
                        }.disabled(selection == count - 1)
                            .accessibilityLabel(String(localized: "下一张")).accessibilityIdentifier("nextImage")
                    }.font(.body.weight(.medium)).buttonStyle(.plain)
                        .foregroundStyle(.white).padding(.horizontal, 8)
                        .background(.ultraThinMaterial, in: Capsule())
                }
            }.padding(.horizontal, 18).padding(.vertical, 12)
                .opacity(1 - min(dragOffset / 150, 0.8))
        }
        .environment(\.colorScheme, .dark)
        .interactiveDismissDisabled(isZoomed)
        .accessibilityAction(.escape) { dismiss() }
        .onChange(of: selection) { _, _ in dragOffset = 0 }
    }
    @ViewBuilder private var pages: some View {
        if usesNativeTransition { gallery }
        else { gallery.simultaneousGesture(fallbackDismissGesture) }
    }
    private var gallery: some View {
        TabView(selection: $selection) {
            ForEach(0..<count, id: \.self) { index in
                ImagePage(name: name, url: urls.isEmpty ? nil : urls[index], active: selection == index,
                          index: index, showsPageIndicator: count > 1) { zoomed in
                    if zoomed { zoomedPages.insert(index) }
                    else { zoomedPages.remove(index) }
                }.tag(index)
            }
        }.tabViewStyle(.page(indexDisplayMode: .never))
    }
    // iOS 18 supplies the interactive return to the source image. Older systems
    // and Reduce Motion retain the same downward exit gesture without that zoom.
    private var fallbackDismissGesture: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                guard !isZoomed, value.translation.height > 0,
                      value.translation.height > abs(value.translation.width) else { return }
                dragOffset = value.translation.height
            }
            .onEnded { value in
                guard !isZoomed else { dragOffset = 0; return }
                if dragOffset > 110 || (dragOffset > 35 && value.predictedEndTranslation.height > 240) {
                    dismiss()
                } else {
                    withAnimation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.32, dampingFraction: 0.9)) {
                        dragOffset = 0
                    }
                }
            }
    }
}

private struct ImagePage: View {
    let name: String
    let url: URL?
    let active: Bool
    let index: Int
    let showsPageIndicator: Bool
    let onZoomChanged: (Bool) -> Void
    @State private var remoteImage: UIImage?
    @State private var failed = false
    @State private var offlinePreview = false
    @State private var loadingFullImage = false
    @State private var attempt = 0
    private var bundledImage: UIImage? { index == 0 ? UIImage(named: name) : nil }
    var body: some View {
        ZStack {
            Color.black
            if url == nil || remoteImage != nil || bundledImage != nil {
                ZoomImage(image: remoteImage ?? bundledImage, active: active, onZoomChanged: onZoomChanged)
                    .accessibilityIdentifier("loadedImage-\(index)")
            } else if failed {
                ContentUnavailableView {
                    Label(String(localized: "图片暂不可用"), systemImage: "photo")
                } description: { Text(String(localized: "检查网络后可以重新加载。")) }
                actions: { Button(String(localized: "重新加载")) { attempt += 1 }.buttonStyle(.bordered).accessibilityIdentifier("retryImage") }
            } else { ProgressView().tint(.white) }
        }.promptActionBar {
            if loadingFullImage, remoteImage != nil {
                ProgressView(String(localized: "正在加载清晰图片…"))
                    .font(.footnote).tint(.white).padding(12).foregroundStyle(.white)
                    .background(.black.opacity(0.7), in: Capsule()).padding(12)
                    .padding(.bottom, showsPageIndicator ? 28 : 0)
                    .accessibilityIdentifier("loadingFullImage")
            } else if offlinePreview {
                Button { attempt += 1 } label: {
                    Label(String(localized: "当前为离线预览 · 轻点加载清晰图片"), systemImage: "arrow.clockwise")
                        .font(.footnote).padding(12).foregroundStyle(.white).background(.black.opacity(0.7), in: Capsule())
                }.padding(12).padding(.bottom, showsPageIndicator ? 28 : 0).accessibilityIdentifier("loadFullImage")
            }
        }.task(id: "\(url?.absoluteString ?? name)-\(attempt)-\(active)") {
            guard active, let url else { return }
            if let bundledImage { remoteImage = bundledImage; offlinePreview = false; return }
            failed = false; loadingFullImage = true
            if remoteImage == nil { remoteImage = ImageStore.shared.offlineImage(for: url) }
            do {
                let result = try await ImageStore.shared.image(for: url, fullResolution: true)
                guard !Task.isCancelled else { return }
                remoteImage = result; offlinePreview = false; loadingFullImage = false
            } catch {
                guard !Task.isCancelled else { return }
                loadingFullImage = false
                offlinePreview = remoteImage != nil
                failed = remoteImage == nil
            }
        }
    }
}

struct ZoomImage: UIViewRepresentable {
    let image: UIImage?
    var active = true
    var onZoomChanged: (Bool) -> Void = { _ in }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.minimumZoomScale = 1; scroll.maximumZoomScale = 5
        scroll.delegate = context.coordinator
        scroll.backgroundColor = .clear
        scroll.showsHorizontalScrollIndicator = false
        scroll.showsVerticalScrollIndicator = false
        scroll.contentInsetAdjustmentBehavior = .never
        // At fitted size, let the native presentation/pager own one-finger drags.
        // Pinch zoom still belongs to this scroll view.
        scroll.panGestureRecognizer.isEnabled = false
        context.coordinator.onZoomChanged = onZoomChanged
        let image = UIImageView(image: self.image)
        image.contentMode = .scaleAspectFit
        image.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(image)
        NSLayoutConstraint.activate([
            image.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor), image.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            image.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor), image.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            image.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor), image.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor)
        ])
        context.coordinator.image = image
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:)))
        tap.numberOfTapsRequired = 2; scroll.addGestureRecognizer(tap)
        scroll.accessibilityLabel = String(localized: "图片预览，双指缩放或双击放大")
        scroll.accessibilityValue = 1.0.formatted(.percent)
        return scroll
    }
    func updateUIView(_ uiView: UIScrollView, context: Context) {
        context.coordinator.onZoomChanged = onZoomChanged
        if context.coordinator.image?.image !== image { context.coordinator.image?.image = image }
        if !active, uiView.zoomScale != uiView.minimumZoomScale {
            uiView.setZoomScale(uiView.minimumZoomScale, animated: false)
        }
    }
    class Coordinator: NSObject, UIScrollViewDelegate {
        weak var image: UIImageView?
        var onZoomChanged: (Bool) -> Void = { _ in }
        private var reportedZoom = false
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { image }
        func scrollViewWillBeginZooming(_ scrollView: UIScrollView, with view: UIView?) { reportZoom(true) }
        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            let zoomed = scrollView.zoomScale > scrollView.minimumZoomScale + 0.01
            scrollView.panGestureRecognizer.isEnabled = zoomed
            scrollView.accessibilityValue = Double(scrollView.zoomScale).formatted(.percent.precision(.fractionLength(0)))
            reportZoom(zoomed || scrollView.isZooming)
        }
        func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) {
            reportZoom(scale > scrollView.minimumZoomScale + 0.01)
        }
        private func reportZoom(_ zoomed: Bool) {
            guard zoomed != reportedZoom else { return }
            reportedZoom = zoomed
            // Also covers zoom resets caused by SwiftUI updating an inactive page.
            DispatchQueue.main.async { [weak self] in self?.onZoomChanged(zoomed) }
        }
        @objc func doubleTap(_ gesture: UITapGestureRecognizer) {
            guard let scroll = gesture.view as? UIScrollView else { return }
            if scroll.zoomScale > 1 { scroll.setZoomScale(1, animated: !UIAccessibility.isReduceMotionEnabled) }
            else {
                let point = gesture.location(in: image)
                scroll.zoom(to: CGRect(x: point.x - scroll.bounds.width / 4, y: point.y - scroll.bounds.height / 4, width: scroll.bounds.width / 2, height: scroll.bounds.height / 2), animated: !UIAccessibility.isReduceMotionEnabled)
            }
        }
    }
}
