import SwiftUI
import AVKit
import Combine
import Observation

struct PromptDetail: View {
    private let snapshot: Prompt
    private let readingPosition: DetailReadingPosition?
    private let origin: PromptDetailOrigin
    @Environment(Library.self) private var library
    @State private var editorContext: EditorContext?
    /// The reader's own version on show; nil shows the work's prompt.
    @State private var selectedVersion: String?
    @State private var imagePresented = false
    @State private var imagePage = 0
    @State private var deckPickerPresented = false
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
    @State private var mediaPaneVisible = false
    /// Once the title scrolls away it returns, small, between the bar buttons over a paper veil.
    @State private var titleShown = false
    @State private var informationExpanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openURL) private var openURL
    private struct EditorContext: Identifiable {
        let id = UUID()
        let item: Prompt
        /// The version being edited; nil starts a new one from `text`.
        let version: String?
        let text: String
    }
    private var item: Prompt { library.resolvedDetail(snapshot, origin: origin) }
    private var effectiveLanguage: String? { language.flatMap { item.availableLanguages.contains($0) ? $0 : nil } }
    private var content: Prompt.TranslatedContent { item.content(in: effectiveLanguage) }
    private var displaysOriginalContent: Bool { content == item.content(in: nil) }
    private var versions: [PromptVersion] { library.versions(of: item) }
    /// What the copy button copies and the editor starts from.
    private var shownText: String { versions.first { $0.id == selectedVersion }?.text ?? content.prompt }
    private var spokenLicense: String {
        // Give the common abbreviation a pronounceable name for VoiceOver.
        item.source.license == "CC0-1.0" ? "Creative Commons Zero" : item.source.license
    }
    init(item: Prompt, origin: PromptDetailOrigin = .catalog, readingPosition: DetailReadingPosition? = nil) {
        snapshot = item
        self.origin = origin
        self.readingPosition = readingPosition
        _language = State(initialValue: item.preferredTranslation)
        _actionsCollapsed = State(initialValue: readingPosition?.actionsCollapsed ?? false)
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
                ShareLink(item: "\(content.title)\n\n\(content.prompt)\n\n\(String(localized: "来自")) \(item.source.author ?? item.source.name) · \(item.source.license)\n\(item.source.url?.absoluteString ?? "https://prompix.dev")") { Label { Text(String(localized: "分享")) } icon: { PrompixIcon.share.image }.frame(minWidth: 44, minHeight: 44) }
                    .accessibilityIdentifier("sharePrompt")
            }
            ToolbarItem(placement: .topBarTrailing) {
                // With decks of your own, saving asks where; otherwise it stays one tap.
                Button {
                    if library.decks.decks.isEmpty { library.toggle(item) }
                    else if library.isSaved(item) || library.toggle(item) { deckPickerPresented = true }
                } label: {
                    Label { Text(library.isSaved(item) ? String(localized: "取消收藏") : String(localized: "收藏 Prompt")) } icon: { (library.isSaved(item) ? PrompixIcon.savedFill : PrompixIcon.saved).image }
                        .frame(minWidth: 44, minHeight: 44)
                }
                    .accessibilityLabel(library.isSaved(item) ? String(localized: "取消收藏") : String(localized: "收藏 Prompt")).accessibilityIdentifier("detailFavorite")
                    .disabled(library.isRemoved(item))
            }
        }
        .overlay(alignment: .top) {
            // Over the picture only the status bar gets an edge; the title brings paper behind the bar.
            ZStack(alignment: .top) {
                EdgeVeil().opacity(hasMediaPreview && !titleShown ? 1 : 0)
                EdgeVeil(hold: 44, fade: 12).opacity(titleShown ? 1 : 0)
            }.animation(.easeOut(duration: 0.2), value: titleShown)
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(content.title).font(.subheadline.weight(.semibold)).lineLimit(1).frame(maxWidth: 200)
                    .opacity(titleShown ? 1 : 0).animation(.easeOut(duration: 0.2), value: titleShown)
                    .accessibilityHidden(!titleShown)
            }
        }
        .promptActionBar { readingActions }
        .onChange(of: content) { _, _ in copied = false }
        .onChange(of: selectedVersion) { _, _ in copied = false }
        .onChange(of: item.preferredTranslation, initial: true) { _, preferred in
            if !hasChosenLanguage { language = preferred }
        }
        .onChange(of: versions.map(\.id)) { _, ids in
            if let selectedVersion, !ids.contains(selectedVersion) { self.selectedVersion = nil }
        }
        .onChange(of: library.isRemoved(item)) { _, removed in
            if removed { cancelLanguageSelection(); failedLanguage = nil }
        }
        .onDisappear { if languageRequestID != nil { cancelLanguageSelection() } }
        .sheet(item: $editorContext) { context in
            PromptEditor(item: context.item, version: context.version, text: context.text) { selectedVersion = $0 }
        }
        .sheet(isPresented: $deckPickerPresented) { DeckPicker(item: item) }
        .fullScreenCover(isPresented: $imagePresented) {
            ImageViewer(name: item.media?.image ?? item.artwork, urls: item.media?.galleryURLs ?? [], selection: imagePage)
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
    private func openPreview(page: Int = 0) {
        if WebsiteExamples.files[item.id] != nil { webPresented = true }
        else if item.kind == .video { playerPresented = true }
        else { imagePage = page; imagePresented = true }
    }
    @ViewBuilder private var detailLayout: some View {
        if #available(iOS 27.1, *), hasMediaPreview {
            ArrangementView {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if !mediaPaneVisible { largePreview }
                        readingContent
                    }.padding(.bottom, 28).frame(maxWidth: 700).frame(maxWidth: .infinity)
                }.ignoresSafeArea(edges: mediaPaneVisible ? [] : .top).hidesTopEdgeEffect()
                    .tracksTitle($titleShown, after: mediaPaneVisible ? 60 : 340)
                    .preservingReadingPosition(readingPosition).readingChrome($actionsCollapsed).readingBottomEdge().accessibilityIdentifier("detailReadingPane")
            } secondary: {
                ScrollView {
                    largePreview.padding(.bottom, 24).frame(maxWidth: 600).frame(maxWidth: .infinity)
                }.ignoresSafeArea(edges: .top)
                    .preservingReadingPosition(readingPosition, media: true).reportsPaneVisibility($mediaPaneVisible).accessibilityIdentifier("detailMediaPane")
            }.arrangementViewStyle(.split.axes(.horizontal))
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    largePreview
                    readingContent
                }.padding(.bottom, 28).frame(maxWidth: 700).frame(maxWidth: .infinity)
            }.ignoresSafeArea(edges: hasMediaPreview ? .top : []).hidesTopEdgeEffect()
                .tracksTitle($titleShown, after: hasMediaPreview ? 340 : 60)
                .preservingReadingPosition(readingPosition).readingChrome($actionsCollapsed).readingBottomEdge().accessibilityIdentifier("detailReadingPane")
        }
    }
    private var compactPreview: some View {
        Button { openPreview() } label: {
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
            DetailHero(preview: ContentPreview(item), title: previewTitle) { page in openPreview(page: page) }
                .accessibilityIdentifier("previewButton")
                .promptTransitionSource(id: "image-\(item.id)", in: imageTransition)
                .overlay(alignment: .bottomTrailing) {
                    if WebsiteExamples.files[item.id] != nil {
                        Label(String(localized: "打开作品"), systemImage: "safari").font(.subheadline.weight(.medium))
                            .padding(.horizontal, 16).padding(.vertical, 12).background(.regularMaterial, in: Capsule()).padding(16)
                            .allowsHitTesting(false).accessibilityHidden(true)
                    } else if item.kind == .video {
                        PrompixIcon.play.image(size: 20).padding(14).background(.regularMaterial, in: Circle()).padding(16)
                            .allowsHitTesting(false).accessibilityHidden(true)
                    }
                }
        }
    }
    private var readingContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            PromptDetailHeading(preview: ContentPreview(item), title: content.title)
            if #available(iOS 27.1, *), hasMediaPreview, mediaPaneVisible { compactPreview }
            VStack(alignment: .leading, spacing: 10) {
                languagePicker
                if !versions.isEmpty { versionPicker }
                // A multi-shot video reads as its shots; the same words are not shown twice.
                if let shots = item.shots, selectedVersion == nil { PromptShots(shots: shots).accessibilityIdentifier("promptBody") }
                else { FoldedPrompt(text: shownText).accessibilityIdentifier("promptBody") }
            }
            DisclosureGroup(isExpanded: $informationExpanded) {
                VStack(alignment: .leading, spacing: 0) {
                    if let creator = item.creator { CreatorByline(creator: creator).padding(.bottom, 6) }
                    infoRow(String(localized: "语言"), displaysOriginalContent ? String(localized: "原文") : String(localized: "AI 译文"))
                    if let link = item.source.url ?? item.source.repository {
                        Link(destination: link) {
                            infoRow(String(localized: "原帖"), (item.source.post != nil ? "X" : item.source.name) + " ↗")
                        }.accessibilityIdentifier("originalSource")
                    }
                    infoRow(String(localized: "许可"), licenseText)
                        .accessibilityLabel(String(localized: "内容许可：\(spokenLicense)"))
                    if let date = item.source.post?.date {
                        infoRow(String(localized: "发布"), date.formatted(.dateTime.year().month().day()), mono: true)
                    }
                    if let skill = item.skill { SkillInformation(skill: skill).padding(.top, 16) }
                    if WebsiteExamples.files[item.id] != nil {
                        Button { webPresented = true } label: {
                            Text(String(localized: "打开原创网页示例")).font(.subheadline).frame(minHeight: 44)
                        }.accessibilityIdentifier("webExample")
                    }
                    if let demo = item.media?.demoURL {
                        Link(String(localized: "打开网页示例"), destination: demo).font(.subheadline).frame(minHeight: 44)
                    }
                    Link(destination: SupportLinks.url(.report, contentID: item.id)) {
                        Text(String(localized: "报告问题或申请下架")).font(.footnote).foregroundStyle(Palette.muted).frame(minHeight: 44)
                    }.accessibilityIdentifier("reportContent")
                }.padding(.top, 8)
            } label: {
                moreInformationLabel.accessibilityIdentifier("promptInformation")
            }
            if let feed = library.feed {
                FeedRelatedResults(item: item, repository: feed)
            } else if !related.isEmpty {
                Divider()
                HStack { Text(String(localized: "相关 Prompt")).font(.headline).accessibilityAddTraits(.isHeader); Spacer(); Image(systemName: "arrow.down.right").foregroundStyle(Palette.muted).accessibilityHidden(true) }
                PromptGrid(items: related)
            }
        }.padding(.horizontal, 22).padding(.top, 12)
    }
    /// Licence codes from the pipeline, in words a reader understands.
    private var licenseText: String {
        switch item.source.license {
        // X posts are the author's own work, whichever way they were collected.
        case "X-API-Terms", "Source-author-rights": String(localized: "版权归原作者")
        case "CC0-1.0": "CC0"
        default: item.source.license
        }
    }
    /// Only licenses a reader recognises at a glance; the full terms stay inside.
    private var shortLicense: String? {
        return item.source.license.hasPrefix("CC") ? item.source.license.replacingOccurrences(of: "-1.0", with: "") : nil
    }
    /// Who and under what terms, in one quiet line; everything else waits inside.
    private var moreInformationLabel: some View {
        HStack(spacing: 8) {
            if !informationExpanded {
                if let creator = item.creator { CreatorAvatar(creator: creator, size: 20) }
                Text([item.creator?.displayName ?? item.source.author ?? item.source.name, shortLicense].compactMap { $0 }.joined(separator: " · "))
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(informationExpanded ? String(localized: "收起") : String(localized: "更多信息"))
        }.font(.footnote).foregroundStyle(Palette.muted).frame(minHeight: 44)
            .accessibilityElement(children: .combine)
    }
    private func infoRow(_ label: String, _ value: String, mono: Bool = false) -> some View {
        HStack(spacing: 12) {
            Text(label).foregroundStyle(Palette.muted)
            Spacer(minLength: 8)
            Text(value).font(mono ? Typography.meta(size: 12) : .subheadline).foregroundStyle(Palette.ink).lineLimit(1)
        }.font(.subheadline).frame(minHeight: 44)
            .overlay(alignment: .bottom) { Rectangle().fill(Palette.line).frame(height: 0.5) }
            .accessibilityElement(children: .combine)
    }
    private var readingActions: some View {
        ReadingActionBar(isSkill: item.isSkill, collapsed: actionsCollapsed, copied: copied,
                         copyTitle: item.isSkill && SkillInstall.command(for: item) != nil ? String(localized: "复制安装命令") : nil,
                         canEdit: !item.isSkill, edit: openEditor, copy: copyShown)
    }
    private func copyShown() {
        UIPasteboard.general.string = item.isSkill && selectedVersion == nil ? SkillInstall.command(for: item) ?? shownText : shownText
        library.recommendations.record(.use, prompt: item)
        copied = true
    }
    /// 原版 first, then the reader's own versions, newest first.
    private var versionPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                versionChip(String(localized: "原版"), id: nil)
                ForEach(Array(versions.enumerated()), id: \.element.id) { index, version in
                    versionChip(String(localized: "我的 \(versions.count - index)"), id: version.id)
                }
            }
        }.scrollClipDisabled().accessibilityIdentifier("promptVersions")
    }
    private func versionChip(_ title: String, id: String?) -> some View {
        let selected = selectedVersion == id
        return Button { selectedVersion = id } label: {
            Text(title).font(.subheadline.weight(selected ? .semibold : .regular))
                .foregroundStyle(selected ? Palette.paper : Palette.muted)
                .padding(.horizontal, 12).frame(height: 30)
                .background(selected ? Palette.ink : .clear, in: Capsule())
                .frame(minHeight: 44).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
            .accessibilityIdentifier(id.map { "version-\($0)" } ?? "version-original")
    }
    private var languagePicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(verbatim: "PROMPT").font(Typography.meta(size: 11)).tracking(1.4).foregroundStyle(Palette.muted)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 4)
                if selectedVersion == nil { languageMenu }
            }
            if library.isRemoved(item) {
                Text(String(localized: "这条内容已被移除，无法再保存。你仍可复制当前文字。"))
                    .font(.footnote).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            } else if let pendingLanguage {
                HStack(alignment: .top, spacing: 10) {
                    ContentActivityLabel(size: 32)
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
                    FeedRetryButton { selectLanguage(failedLanguage) }
                        .font(.footnote.weight(.medium)).frame(minHeight: 44).accessibilityIdentifier("retryLanguageDownload")
                }.accessibilityElement(children: .contain).accessibilityIdentifier("languageDownloadFailure")
            }
        }
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
                    HStack(spacing: 4) {
                        Text(effectiveLanguage.map(ContentLanguage.name) ?? String(localized: "原文"))
                        PrompixIcon.chevronDown.image(size: 12)
                    }.font(Typography.meta(size: 11)).tracking(1.2).foregroundStyle(Palette.muted)
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }.accessibilityLabel(String(localized: "语言")).accessibilityValue(effectiveLanguage.map(ContentLanguage.name) ?? String(localized: "原文"))
                    .accessibilityIdentifier("contentLanguage")
            }
    }
    private func openEditor() {
        // Capture the starting text now: a catalog or locale install must not change an open editor's baseline.
        editorContext = EditorContext(item: item, version: selectedVersion, text: shownText)
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

/// The reader's own version of a prompt. Edits save as they are typed; starting
/// from the original or another version makes a new version on the first change.
struct PromptEditor: View {
    let item: Prompt
    private let onSaved: (String?) -> Void
    private let baseline: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(Library.self) private var library
    @State private var version: String?
    @State private var text: String
    @State private var copied = false
    @State private var saveError: String?
    @State private var deletePresented = false
    @State private var leavePresented = false
    @State private var discarded = false
    @FocusState private var editorFocused: Bool
    init(item: Prompt, version: String?, text: String, onSaved: @escaping (String?) -> Void = { _ in }) {
        self.item = item; self.onSaved = onSaved; baseline = text
        _version = State(initialValue: version); _text = State(initialValue: text)
    }
    private var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var unsaved: Bool {
        guard let version else { return text != baseline }
        return library.versions(of: item).first { $0.id == version }?.text != text
    }
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 8) {
                if let saveError {
                    Text(saveError).font(.footnote).foregroundStyle(Palette.muted)
                        .fixedSize(horizontal: false, vertical: true).padding(.horizontal, 20)
                        .accessibilityIdentifier("draftSaveError")
                }
                StablePromptEditor(text: $text, focused: $editorFocused)
                    .font(Typography.prompt(size: 17)).lineSpacing(5)
                    .scrollContentBackground(.hidden).padding(.horizontal, 16)
                    .frame(maxHeight: .infinity).accessibilityIdentifier("promptEditor")
            }.paperScreen()
                .navigationTitle(version == nil ? String(localized: "新版本") : String(localized: "我的版本"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(String(localized: "完成")) { if save() { dismiss() } else { leavePresented = true } }
                            .accessibilityIdentifier("finishPromptEditing")
                    }
                    ToolbarItem(placement: .primaryAction) {
                        Button(action: copy) {
                            Label(copied ? String(localized: "已复制") : String(localized: "复制"), systemImage: copied ? "checkmark" : "doc.on.doc")
                        }.disabled(isEmpty).accessibilityIdentifier("copyEditedPrompt").sensoryFeedback(.success, trigger: copied)
                    }
                    if version != nil {
                        ToolbarItem(placement: .primaryAction) {
                            Menu {
                                Button(String(localized: "删除这个版本"), systemImage: "trash", role: .destructive) { deletePresented = true }
                            } label: { Label { Text(String(localized: "更多")) } icon: { PrompixIcon.more.image } }
                                .accessibilityIdentifier("versionActions")
                        }
                    }
                }
                .onAppear { editorFocused = true }
                .onChange(of: text) { _, _ in copied = false; saveError = nil }
                .task(id: text) {
                    do { try await Task.sleep(for: .milliseconds(400)) } catch { return }
                    save()
                }
                .onDisappear { if !discarded { save() } }
                .onChange(of: scenePhase) { _, phase in if phase != .active { save() } }
                .confirmationDialog(String(localized: "删除这个版本？"), isPresented: $deletePresented, titleVisibility: .visible) {
                    Button(String(localized: "删除"), role: .destructive) {
                        if let version, library.deleteVersion(version) { discarded = true; onSaved(nil); dismiss() }
                    }
                    Button(String(localized: "取消"), role: .cancel) {}
                } message: { Text(String(localized: "原版和其他版本不受影响。")) }
                .alert(String(localized: "本次修改尚未保存"), isPresented: $leavePresented) {
                    Button(String(localized: "复制并退出")) { UIPasteboard.general.string = text; discarded = true; dismiss() }
                        .accessibilityIdentifier("copyDraftAndLeave")
                    Button(String(localized: "放弃本次修改并退出"), role: .destructive) { discarded = true; dismiss() }
                        .accessibilityIdentifier("discardDraftAndLeave")
                    Button(String(localized: "继续编辑"), role: .cancel) {}
                }
        }
        .promptSheet()
        .interactiveDismissDisabled(unsaved)
    }
    private func copy() {
        UIPasteboard.general.string = text
        library.recommendations.record(.use, prompt: item)
        copied = true
        save()
    }
    /// Nothing is stored until the text differs from where it started, or is empty.
    @discardableResult private func save() -> Bool {
        guard !discarded, unsaved else { return true }
        guard !isEmpty else { return version == nil }
        guard let saved = library.saveVersion(text, id: version, for: item) else {
            saveError = library.error ?? String(localized: "尚未保存，可先复制保留")
            library.dismissError()
            return false
        }
        if version == nil { version = saved }
        onSaved(saved)
        return true
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
                        FeedRetryButton(title: String(localized: "重新加载")) { playback.start(url: url) }.accessibilityIdentifier("retryVideo")
                    }
                } else if let player = playback.player {
                    VideoPlayer(player: player).aspectRatio(playback.aspectRatio, contentMode: .fit)
                        .accessibilityIdentifier(playback.hasPlayed ? "playingVideo" : "loadingVideo")
                        .overlay { if playback.loading { ContentActivityLabel(size: 80).padding(8).background(.regularMaterial, in: Capsule()).allowsHitTesting(false) } }
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
    @State private var selection: Int
    @State private var zoomedPages: Set<Int> = []
    @State private var dragOffset: CGFloat = 0
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    init(name: String, urls: [URL], selection: Int = 0) {
        self.name = name; self.urls = urls
        _selection = State(initialValue: min(max(0, selection), max(0, urls.count - 1)))
    }
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
            // Swipe between images, pull down to close; the system dots say where you are.
            VStack {
                HStack {
                    Spacer()
                    Button { dismiss() } label: {
                        PrompixIcon.close.image(size: 20)
                            .foregroundStyle(.white).frame(width: 44, height: 44)
                            .background(.ultraThinMaterial, in: Circle())
                    }.buttonStyle(.plain).accessibilityLabel(String(localized: "完成"))
                        .accessibilityIdentifier("closeImageViewer")
                }
                Spacer()
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
        }.tabViewStyle(.page(indexDisplayMode: count > 1 ? .always : .never))
            .accessibilityValue(count > 1 ? "\(selection + 1) / \(count)" : "")
            .accessibilityIdentifier("imagePages")
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
                actions: { FeedRetryButton(title: String(localized: "重新加载")) { attempt += 1 }.accessibilityIdentifier("retryImage") }
            } else { ContentActivityLabel(size: 88) }
        }.promptActionBar {
            if loadingFullImage, remoteImage != nil {
                ContentActivityLabel(size: 44)
                    .accessibilityLabel(String(localized: "正在加载清晰图片…"))
                    .padding(8)
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

/// The prompt itself, folded to about seven lines until the reader asks for all of it.
private struct FoldedPrompt: View {
    let text: String
    @State private var expanded = false
    @State private var fullHeight: CGFloat = 0
    @ScaledMetric(relativeTo: .body) private var foldHeight = 188.0
    var body: some View {
        let folds = !expanded && fullHeight > foldHeight + 40
        VStack(alignment: .leading, spacing: 2) {
            PromptMarkdown(text)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { fullHeight = $0 }
                .frame(maxHeight: folds ? foldHeight : nil, alignment: .top)
                .clipped()
                .overlay(alignment: .bottom) {
                    if folds {
                        LinearGradient(colors: [Palette.paper.opacity(0), Palette.paper], startPoint: .top, endPoint: .bottom)
                            .frame(height: 52).allowsHitTesting(false).accessibilityHidden(true)
                    }
                }
            if folds {
                Button(String(localized: "展开全文")) { expanded = true }
                    .font(.subheadline.weight(.medium)).foregroundStyle(Palette.ink).frame(minHeight: 36)
                    .accessibilityIdentifier("expandPrompt")
            }
        }.onChange(of: text) { _, _ in expanded = false }
    }
}

/// Multi-shot video prompts, one shot per row with its time range.
private struct PromptShots: View {
    let shots: [Prompt.Shot]
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(shots, id: \.index) { shot in
                VStack(alignment: .leading, spacing: 4) {
                    Text(label(shot)).font(Typography.meta(size: 11)).tracking(1).foregroundStyle(Palette.muted)
                    Text(shot.text).font(Typography.prompt(size: 16)).lineSpacing(4).textSelection(.enabled)
                }
            }
        }.accessibilityIdentifier("promptShots")
    }
    private func label(_ shot: Prompt.Shot) -> String {
        let number = String(format: "%02d", shot.index)
        guard let start = shot.startSec, let end = shot.endSec else { return number }
        return "\(number) ▸ \(start.formatted(.number.precision(.fractionLength(0...1))))–\(end.formatted(.number.precision(.fractionLength(0...1))))s"
    }
}

private extension View {
    @ViewBuilder func tracksTitle(_ shown: Binding<Bool>, after offset: CGFloat) -> some View {
        if #available(iOS 18, *) {
            onScrollGeometryChange(for: Bool.self) { $0.contentOffset.y + $0.contentInsets.top > offset } action: { _, value in shown.wrappedValue = value }
        } else { self }
    }
}
