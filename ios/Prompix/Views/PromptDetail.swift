import SwiftUI
import AVKit
import Combine
import Observation

struct PromptDetail: View {
    let item: Prompt
    @Environment(Library.self) private var library
    @State private var editorPresented = false
    @State private var imagePresented = false
    @State private var playerPresented = false
    @State private var copied = false
    @State private var webPresented = false
    private var related: [Prompt] {
        RelatedPrompts.select(for: item, from: library.prompts)
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 25) {
                if WebsiteExamples.files[item.id] != nil {
                    Button { webPresented = true } label: {
                        hero.overlay(alignment: .bottomTrailing) {
                            Label(String(localized: "打开作品"), systemImage: "safari").font(.subheadline.weight(.medium))
                                .padding(.horizontal, 16).padding(.vertical, 12).background(.regularMaterial, in: Capsule()).padding(16)
                        }
                    }.buttonStyle(.plain).accessibilityLabel(String(localized: "打开网页作品")).accessibilityIdentifier("previewButton")
                } else if item.kind == .video || item.media?.image != nil || item.media?.imageURL != nil {
                    Button {
                        if item.kind == .video { playerPresented = true } else { imagePresented = true }
                    } label: {
                        hero.overlay(alignment: .bottomTrailing) {
                            Image(systemName: item.kind == .video ? "play.fill" : (item.media?.galleryURLs.count ?? 0) > 1 ? "square.stack" : "arrow.up.left.and.arrow.down.right")
                                .font(.body).padding(14).background(.regularMaterial, in: Circle()).padding(16)
                        }
                    }.buttonStyle(.plain)
                        .accessibilityLabel(item.kind == .video ? String(localized: "播放视频") : String(localized: "放大图片"))
                        .accessibilityIdentifier("previewButton")
                } else { hero }
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 12) {
                        ViewThatFits(in: .horizontal) {
                            HStack {
                                Label(item.kind.title, systemImage: item.kind.symbol)
                                Text("·").accessibilityHidden(true)
                                Text(item.model)
                            }.fixedSize()
                            VStack(alignment: .leading, spacing: 6) {
                                Label(item.kind.title, systemImage: item.kind.symbol)
                                Text(item.model).fixedSize(horizontal: false, vertical: true)
                            }
                        }.font(.footnote).foregroundStyle(Palette.muted)
                        Text(item.title).font(.title2.weight(.semibold)).lineSpacing(5).fixedSize(horizontal: false, vertical: true)
                        Text(item.summary).font(.subheadline).lineSpacing(5).foregroundStyle(Palette.muted)
                        Text(item.previewLabel).font(.footnote).foregroundStyle(Palette.muted)
                    }
                    Divider()
                    VStack(alignment: .leading, spacing: 10) {
                        Eyebrow(text: "THE IDEA")
                        Text(item.kind == .text ? String(localized: "你会得到什么") : String(localized: "创作思路")).font(.headline)
                        Text(item.example).font(.subheadline).lineSpacing(6).textSelection(.enabled)
                    }
                    VStack(alignment: .leading, spacing: 14) {
                        HStack {
                            Eyebrow(text: "THE PROMPT")
                            Spacer()
                            Button { editorPresented = true } label: { Label(String(localized: "编辑"), systemImage: "square.and.pencil").frame(minWidth: 44, minHeight: 44).contentShape(Rectangle()) }.font(.subheadline)
                                .accessibilityIdentifier("editPrompt")
                        }
                        Text(item.prompt).font(.system(.subheadline)).lineSpacing(6).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }.padding(20).background(Palette.soft, in: RoundedRectangle(cornerRadius: 18))
                    if WebsiteExamples.files[item.id] != nil {
                        Button { webPresented = true } label: { Label(String(localized: "打开原创网页示例"), systemImage: "safari").frame(minHeight: 44).contentShape(Rectangle()) }.accessibilityIdentifier("webExample")
                    }
                    if let toolURL = item.toolURL {
                        Link(destination: toolURL) {
                            HStack {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(String(localized: "带着灵感，去试试")).font(.subheadline.weight(.medium))
                                    Text(String(localized: "复制后打开工具，粘贴使用")).font(.footnote).foregroundStyle(Palette.muted)
                                }; Spacer(); Image(systemName: "arrow.up.right")
                            }.padding(.vertical, 5)
                        }
                    }
                    if let demo = item.media?.demoURL { Link(destination: demo) { Text(String(localized: "打开网页示例")).font(.subheadline).frame(minHeight: 44).contentShape(Rectangle()) } }
                    VStack(alignment: .leading, spacing: 8) {
                        HStack { Text(item.source.author ?? item.source.name).font(.footnote.weight(.medium)); Spacer(); Text(item.source.method).font(.footnote).foregroundStyle(Palette.muted) }
                        Text("\(item.source.license) · \(item.previewLabel)").font(.footnote).foregroundStyle(Palette.muted)
                        if let repository = item.source.repository { Link(destination: repository) { Text(String(localized: "收录于 \(item.source.name)")).font(.footnote).frame(minHeight: 44).contentShape(Rectangle()) } }
                        if let source = item.source.url { Link(destination: source) { Text(String(localized: "查看原始来源 ↗")).font(.footnote).frame(minHeight: 44).contentShape(Rectangle()) } }
                        Link(destination: SupportLinks.url(.report, contentID: item.id)) { Text(String(localized: "反馈这条内容")).font(.footnote).frame(minHeight: 44).contentShape(Rectangle()) }.accessibilityIdentifier("reportContent")
                    }
                    if !related.isEmpty {
                        Divider()
                        HStack { Text(String(localized: "顺着灵感，再逛一点")).font(.headline); Spacer(); Image(systemName: "arrow.down.right").foregroundStyle(Palette.muted) }
                        PromptGrid(items: related)
                    }
                }.padding(.horizontal, 22)
            }.padding(.bottom, 28)
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: "\(item.title)\n\n\(item.prompt)\n\n\(String(localized: "来自")) \(item.source.author ?? item.source.name) · \(item.source.license)\n\(item.source.url?.absoluteString ?? "https://prompix.dev")") { Label(String(localized: "分享"), systemImage: "square.and.arrow.up").frame(minWidth: 44, minHeight: 44) }
                    .accessibilityIdentifier("sharePrompt")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { library.toggle(item) } label: { Image(systemName: library.isSaved(item) ? "bookmark.fill" : "bookmark").frame(minWidth: 44, minHeight: 44) }
                    .accessibilityLabel(library.isSaved(item) ? String(localized: "取消收藏") : String(localized: "收藏 Prompt")).accessibilityIdentifier("detailFavorite")
            }
        }
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 12) {
                Button { editorPresented = true } label: { Image(systemName: "slider.horizontal.3").font(.system(size: 20)).frame(width: 50, height: 50) }
                    .buttonStyle(.plain).background(Palette.soft, in: RoundedRectangle(cornerRadius: 16)).accessibilityLabel(String(localized: "编辑后使用"))
                Button {
                    UIPasteboard.general.string = item.prompt
                    copied = true
                } label: {
                    PrimaryActionLabel(title: copied ? String(localized: "已复制，去创造吧") : String(localized: "复制 Prompt"),
                        compactTitle: copied ? String(localized: "已复制") : String(localized: "复制"), symbol: copied ? "checkmark" : "doc.on.doc")
                }.buttonStyle(.plain).accessibilityIdentifier("copyPrompt").sensoryFeedback(.success, trigger: copied)
            }.padding(.horizontal, 20).padding(.vertical, 10).background(.bar)
        }
        .sheet(isPresented: $editorPresented) { PromptEditor(item: item) }
        .fullScreenCover(isPresented: $imagePresented) { ImageViewer(name: item.media?.image ?? item.artwork, urls: item.media?.galleryURLs ?? []) }
        .sheet(isPresented: $webPresented) {
            if let filename = WebsiteExamples.files[item.id] { WebExample(filename: filename) }
        }
        .sheet(isPresented: $playerPresented) { MovieView(filename: item.media?.video, remoteURL: item.media?.videoURL, caption: item.previewLabel) }
    }
    private var hero: some View {
        Artwork(item: item).aspectRatio(item.media?.aspectRatio.map { max(0.9, min(1.8, $0)) } ?? (item.kind == .image ? 0.95 : 1.15), contentMode: .fit)
    }

}

struct PromptEditor: View {
    let item: Prompt
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
    @State private var leavePresented = false
    @State private var leavingWithoutSaving = false
    @State private var headerHeight: CGFloat?
    init(item: Prompt) { self.item = item; _text = State(initialValue: item.prompt) }
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
                    TextEditor(text: $text).font(.body).scrollContentBackground(.hidden).padding(.horizontal, 16)
                        .frame(maxHeight: .infinity).accessibilityIdentifier("promptEditor")
                }
            }.navigationTitle(String(localized: "让它更像你")).navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(String(localized: "完成")) { if save() { dismiss() } } }
                    ToolbarItem(placement: .primaryAction) {
                        Menu {
                            Button(String(localized: "恢复原始 Prompt"), systemImage: "arrow.counterclockwise", role: .destructive) { restorePresented = true }
                                .disabled(text == item.prompt)
                        } label: { Label(String(localized: "编辑选项"), systemImage: "ellipsis.circle") }
                    }
                    ToolbarItem(placement: .primaryAction) { ShareLink(item: text) { Label(String(localized: "分享"), systemImage: "square.and.arrow.up").frame(minWidth: 44, minHeight: 44) }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
                }
                .safeAreaInset(edge: .bottom) {
                    Button {
                        UIPasteboard.general.string = text; copied = true
                        save()
                    } label: {
                        PrimaryActionLabel(title: copied ? String(localized: "已复制修改后的 Prompt") : String(localized: "复制修改后的 Prompt"),
                            compactTitle: copied ? String(localized: "已复制") : String(localized: "复制"), symbol: copied ? "checkmark" : "doc.on.doc")
                    }.buttonStyle(.plain).accessibilityIdentifier("copyEditedPrompt")
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .padding().background(.bar).sensoryFeedback(.success, trigger: copied)
                }
                .onAppear {
                    guard !initialized else { return }
                    text = library.draft(for: item); initialized = true
                }
                .onChange(of: text) { _, _ in copied = false; saved = text == library.draft(for: item); saveError = nil }
                .task(id: text) {
                    guard initialized else { return }
                    do { try await Task.sleep(for: .milliseconds(400)) } catch { return }
                    save()
                }
                .onDisappear { if initialized { save() } }
                .onChange(of: scenePhase) { _, phase in
                    if phase != .active, initialized { save() }
                }
                .confirmationDialog(String(localized: "恢复原始 Prompt？"), isPresented: $restorePresented, titleVisibility: .visible) {
                    Button(String(localized: "恢复原文"), role: .destructive) { text = item.prompt; save() }
                    Button(String(localized: "取消"), role: .cancel) {}
                } message: { Text(String(localized: "这会替换你在此设备上保存的修改。")) }
                .confirmationDialog(String(localized: "本次修改尚未保存"), isPresented: $leavePresented, titleVisibility: .visible) {
                    Button(String(localized: "复制并退出")) {
                        UIPasteboard.general.string = text
                        leaveWithoutSaving()
                    }.accessibilityIdentifier("copyDraftAndLeave")
                    Button(String(localized: "放弃本次修改并退出"), role: .destructive) { leaveWithoutSaving() }
                        .accessibilityIdentifier("discardDraftAndLeave")
                    Button(String(localized: "继续编辑"), role: .cancel) {}
                } message: {
                    Text(String(localized: "退出后将保留上一次成功保存的草稿。你可以先复制本次修改，再离开编辑器。"))
                }
        }
        .interactiveDismissDisabled(!saved || text != library.draft(for: item))
    }
    private var editorHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(typeSize.isAccessibilitySize ? String(localized: "原文会保留。") : String(localized: "写进你的想法，变成自己的版本。原始 Prompt 会保留。"))
                .font(.footnote).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            HStack {
                Label(saved ? String(localized: "已保存到此设备") : saveError != nil ? String(localized: "尚未保存，可先复制保留") : String(localized: "正在保存…"), systemImage: saved ? "checkmark.circle" : "circle.dotted")
                    .font(.footnote).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("draftStatus")
                if !typeSize.isAccessibilitySize {
                    Spacer()
                    Text(String(localized: "\(text.count) 字符")).font(.footnote.monospacedDigit()).foregroundStyle(Palette.muted)
                }
            }
            if let saveError {
                Text(saveError).font(.footnote).foregroundStyle(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("draftSaveError")
                ViewThatFits(in: .horizontal) {
                    HStack { saveRecoveryActions }
                    VStack(alignment: .leading) { saveRecoveryActions }
                }
            }
        }.padding(.horizontal, 20).padding(.top, 14)
            .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
    }
    private var saveRecoveryActions: some View {
        Group {
            Button(String(localized: "重试保存")) { save() }.accessibilityIdentifier("retryDraftSave")
            Button(String(localized: "退出编辑")) { leavePresented = true }.accessibilityIdentifier("leaveUnsavedDraft")
        }.buttonStyle(.bordered).controlSize(.large)
    }
    @discardableResult private func save() -> Bool {
        guard !leavingWithoutSaving else { return false }
        saved = library.saveDraft(text, for: item)
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
            else if status == .readyToPlay { self.loading = false }
        }.store(in: &subscriptions)
        item.publisher(for: \.presentationSize).receive(on: RunLoop.main).sink { [weak self] size in
            guard let self, self.player?.currentItem === item, size.width > 0, size.height > 0 else { return }
            self.aspectRatio = size.width / size.height
        }.store(in: &subscriptions)
        player.publisher(for: \.timeControlStatus).receive(on: RunLoop.main).sink { [weak self] status in
            guard let self, self.player === player, !self.failed else { return }
            if status == .waitingToPlayAtSpecifiedRate { self.loading = true; self.armTimeout() }
            else if status == .playing { self.loading = false; self.timeout?.cancel() }
            else if item.status == .readyToPlay { self.loading = false; self.timeout?.cancel() }
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
            }.frame(maxWidth: .infinity, maxHeight: .infinity).background(.black).navigationTitle(String(localized: "动态灵感")).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { dismiss() } } }
                .onAppear { playback.start(url: url) }
                .onDisappear { playback.stop() }
                .onChange(of: scenePhase) { _, phase in if phase != .active { playback.pause() } }
        }.preferredColorScheme(.dark)
    }
}

struct ImageViewer: View {
    let name: String
    let urls: [URL]
    @State private var selection = 0
    @Environment(\.dismiss) private var dismiss
    private var count: Int { max(1, urls.count) }
    var body: some View {
        NavigationStack {
            TabView(selection: $selection) {
                ForEach(0..<count, id: \.self) { index in
                    ImagePage(name: name, url: urls.isEmpty ? nil : urls[index], active: selection == index, index: index)
                        .tag(index)
                }
            }.tabViewStyle(.page(indexDisplayMode: count > 1 ? .always : .never))
                .background(.black)
                .navigationTitle(count > 1 ? "\(selection + 1) / \(count)" : "")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { dismiss() } }
                    if count > 1 {
                        ToolbarItemGroup(placement: .bottomBar) {
                            Button(String(localized: "上一张"), systemImage: "chevron.left") { selection -= 1 }
                                .disabled(selection == 0).accessibilityIdentifier("previousImage")
                            Spacer()
                            Button(String(localized: "下一张"), systemImage: "chevron.right") { selection += 1 }
                                .disabled(selection == count - 1).accessibilityIdentifier("nextImage")
                        }
                    }
                }
                .toolbarBackground(.visible, for: .navigationBar, .bottomBar)
                .toolbarBackground(.black, for: .navigationBar, .bottomBar)
                .toolbarColorScheme(.dark, for: .navigationBar, .bottomBar)
        }.preferredColorScheme(.dark)
    }
}

private struct ImagePage: View {
    let name: String
    let url: URL?
    let active: Bool
    let index: Int
    @State private var remoteImage: UIImage?
    @State private var failed = false
    @State private var offlinePreview = false
    @State private var attempt = 0
    private var bundledImage: UIImage? { index == 0 ? UIImage(named: name) : nil }
    var body: some View {
        ZStack {
            Color.black
            if url == nil || remoteImage != nil || bundledImage != nil {
                ZoomImage(image: remoteImage ?? bundledImage)
                    .accessibilityIdentifier("loadedImage-\(index)")
            } else if failed {
                ContentUnavailableView {
                    Label(String(localized: "图片暂不可用"), systemImage: "photo")
                } description: { Text(String(localized: "检查网络后可以重新加载。")) }
                actions: { Button(String(localized: "重新加载")) { attempt += 1 }.buttonStyle(.bordered).accessibilityIdentifier("retryImage") }
            } else { ProgressView().tint(.white) }
        }.overlay(alignment: .bottom) {
            if offlinePreview {
                Button { attempt += 1 } label: {
                    Label(String(localized: "当前为离线预览 · 轻点加载清晰图片"), systemImage: "arrow.clockwise")
                        .font(.footnote).padding(12).foregroundStyle(.white).background(.black.opacity(0.7), in: Capsule())
                }.padding(.bottom, 40).accessibilityIdentifier("loadFullImage")
            }
        }.task(id: "\(url?.absoluteString ?? name)-\(attempt)-\(active)") {
            guard active, let url else { return }
            if let bundledImage { remoteImage = bundledImage; offlinePreview = false; return }
            failed = false
            if remoteImage == nil { remoteImage = ImageStore.shared.offlineImage(for: url) }
            do {
                let result = try await ImageStore.shared.image(for: url, fullResolution: true)
                guard !Task.isCancelled else { return }
                remoteImage = result; offlinePreview = false
            } catch {
                guard !Task.isCancelled else { return }
                offlinePreview = remoteImage != nil
                failed = remoteImage == nil
            }
        }
    }
}

struct ZoomImage: UIViewRepresentable {
    let image: UIImage?
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.minimumZoomScale = 1; scroll.maximumZoomScale = 5
        scroll.delegate = context.coordinator
        scroll.backgroundColor = .black
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
        return scroll
    }
    func updateUIView(_ uiView: UIScrollView, context: Context) {
        if context.coordinator.image?.image !== image { context.coordinator.image?.image = image }
    }
    class Coordinator: NSObject, UIScrollViewDelegate {
        weak var image: UIImageView?
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { image }
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
