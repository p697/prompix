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
                            Image(systemName: item.kind == .video ? "play.fill" : "arrow.up.left.and.arrow.down.right")
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
                                Text("·")
                                Text(item.model)
                            }.fixedSize()
                            VStack(alignment: .leading, spacing: 6) {
                                Label(item.kind.title, systemImage: item.kind.symbol)
                                Text(item.model).fixedSize(horizontal: false, vertical: true)
                            }
                        }.font(.caption).foregroundStyle(.secondary)
                        Text(item.title).font(.title2.weight(.semibold)).lineSpacing(5).fixedSize(horizontal: false, vertical: true)
                        Text(item.summary).font(.subheadline).lineSpacing(5).foregroundStyle(.secondary)
                        Text(item.previewLabel).font(.caption2).foregroundStyle(.tertiary)
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
                            Button(String(localized: "编辑"), systemImage: "square.and.pencil") { editorPresented = true }.font(.subheadline)
                                .accessibilityIdentifier("editPrompt")
                        }
                        Text(item.prompt).font(.system(.subheadline)).lineSpacing(6).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }.padding(20).background(Palette.soft, in: RoundedRectangle(cornerRadius: 18))
                    if WebsiteExamples.files[item.id] != nil {
                        Button(String(localized: "打开原创网页示例"), systemImage: "safari") { webPresented = true }.accessibilityIdentifier("webExample")
                    }
                    if let toolURL = item.toolURL {
                        Link(destination: toolURL) {
                            HStack {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(String(localized: "带着灵感，去试试")).font(.subheadline.weight(.medium))
                                    Text(String(localized: "复制后打开工具，粘贴使用")).font(.caption).foregroundStyle(.secondary)
                                }; Spacer(); Image(systemName: "arrow.up.right")
                            }.padding(.vertical, 5)
                        }
                    }
                    if let demo = item.media?.demoURL { Link(String(localized: "打开网页示例"), destination: demo).font(.subheadline) }
                    VStack(alignment: .leading, spacing: 8) {
                        HStack { Text(item.source.author ?? item.source.name).font(.caption.weight(.medium)); Spacer(); Text(item.source.method).font(.caption).foregroundStyle(.secondary) }
                        Text("\(item.source.license) · \(item.previewLabel)").font(.caption2).foregroundStyle(.secondary)
                        if let repository = item.source.repository { Link(String(localized: "收录于 \(item.source.name)"), destination: repository).font(.caption) }
                        if let source = item.source.url { Link(String(localized: "查看原始来源 ↗"), destination: source).font(.caption) }
                    }
                    if !related.isEmpty {
                        Divider()
                        HStack { Text(String(localized: "顺着灵感，再逛一点")).font(.headline); Spacer(); Image(systemName: "arrow.down.right").foregroundStyle(.secondary) }
                        PromptGrid(items: related)
                    }
                }.padding(.horizontal, 22)
            }.padding(.bottom, 28)
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: "\(item.title)\n\n\(item.prompt)\n\n\(String(localized: "来自")) \(item.source.author ?? item.source.name) · \(item.source.license)\n\(item.source.url?.absoluteString ?? "https://prompix.dev")") { Label(String(localized: "分享"), systemImage: "square.and.arrow.up") }
                    .accessibilityIdentifier("sharePrompt")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { library.toggle(item) } label: { Image(systemName: library.isSaved(item) ? "bookmark.fill" : "bookmark") }
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
        .fullScreenCover(isPresented: $imagePresented) { ImageViewer(name: item.media?.image ?? item.artwork, url: item.media?.imageURL) }
        .sheet(isPresented: $webPresented) {
            if let filename = WebsiteExamples.files[item.id] { WebExample(filename: filename) }
        }
        .sheet(isPresented: $playerPresented) { MovieView(filename: item.media?.video, remoteURL: item.media?.videoURL, caption: item.previewLabel) }
    }
    private var hero: some View {
        Artwork(item: item).aspectRatio(item.media?.aspectRatio.map { max(0.6, min(1.8, $0)) } ?? (item.kind == .image ? 0.95 : 1.15), contentMode: .fit)
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
    @State private var restorePresented = false
    init(item: Prompt) { self.item = item; _text = State(initialValue: item.prompt) }
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(typeSize.isAccessibilitySize ? String(localized: "原文会保留。") : String(localized: "写进你的想法，变成自己的版本。原始 Prompt 会保留。"))
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Label(saved ? String(localized: "已保存到此设备") : library.error == nil ? String(localized: "正在保存…") : String(localized: "尚未保存，可先复制保留"), systemImage: saved ? "checkmark.circle" : "circle.dotted")
                            .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("draftStatus")
                        if !typeSize.isAccessibilitySize {
                            Spacer()
                            Text(String(localized: "\(text.count) 字符")).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                }.padding(.horizontal, 20).padding(.top, 14)
                TextEditor(text: $text).font(.body).scrollContentBackground(.hidden).padding(.horizontal, 16)
                    .accessibilityIdentifier("promptEditor")
            }.navigationTitle(String(localized: "让它更像你")).navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(String(localized: "完成")) { if library.saveDraft(text, for: item) { dismiss() } } }
                    ToolbarItem(placement: .primaryAction) {
                        Menu {
                            Button(String(localized: "恢复原始 Prompt"), systemImage: "arrow.counterclockwise", role: .destructive) { restorePresented = true }
                                .disabled(text == item.prompt)
                        } label: { Label(String(localized: "编辑选项"), systemImage: "ellipsis.circle") }
                    }
                    ToolbarItem(placement: .primaryAction) { ShareLink(item: text) { Label(String(localized: "分享"), systemImage: "square.and.arrow.up") }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
                }
                .safeAreaInset(edge: .bottom) {
                    Button {
                        UIPasteboard.general.string = text; copied = true
                        saved = library.saveDraft(text, for: item)
                    } label: {
                        PrimaryActionLabel(title: copied ? String(localized: "已复制修改后的 Prompt") : String(localized: "复制修改后的 Prompt"),
                            compactTitle: copied ? String(localized: "已复制") : String(localized: "复制"), symbol: copied ? "checkmark" : "doc.on.doc")
                    }.buttonStyle(.plain).accessibilityIdentifier("copyEditedPrompt")
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .padding().background(.bar).sensoryFeedback(.success, trigger: copied)
                }
                .onAppear { text = library.draft(for: item); initialized = true }
                .onChange(of: text) { _, _ in copied = false; saved = false }
                .task(id: text) {
                    guard initialized else { return }
                    do { try await Task.sleep(for: .milliseconds(400)) } catch { return }
                    saved = library.saveDraft(text, for: item)
                }
                .onDisappear { if initialized { library.saveDraft(text, for: item) } }
                .onChange(of: scenePhase) { _, phase in
                    if phase != .active, initialized { saved = library.saveDraft(text, for: item) }
                }
                .confirmationDialog(String(localized: "恢复原始 Prompt？"), isPresented: $restorePresented, titleVisibility: .visible) {
                    Button(String(localized: "恢复原文"), role: .destructive) { text = item.prompt; saved = library.saveDraft(text, for: item) }
                    Button(String(localized: "取消"), role: .cancel) {}
                } message: { Text(String(localized: "这会替换你在此设备上保存的修改。")) }
        }
    }
}

@MainActor @Observable final class MoviePlayback {
    private(set) var player: AVPlayer?
    private(set) var failed = false
    private(set) var loading = true
    private(set) var aspectRatio: CGFloat = 16 / 9
    @ObservationIgnored private var subscriptions = Set<AnyCancellable>()
    @ObservationIgnored private var timeout: Task<Void, Never>?

    func start(url: URL?) {
        stop()
        failed = false; loading = true; aspectRatio = 16 / 9
        guard let url else { fail(); return }
        let item = AVPlayerItem(url: url)
        let player = AVPlayer(playerItem: item)
        self.player = player
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
        timeout = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(25)) } catch { return }
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
        player?.pause(); player?.replaceCurrentItem(with: nil); player = nil; loading = false
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
                        .overlay { if playback.loading { ProgressView(String(localized: "正在加载视频…")).padding(16).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14)).allowsHitTesting(false) } }
                }
                Text(caption).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 20)
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
    let url: URL?
    @State private var remoteImage: UIImage?
    @State private var failed = false
    @State private var offlinePreview = false
    @State private var attempt = 0
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ZStack {
                Color.black
                if url == nil || remoteImage != nil { ZoomImage(image: remoteImage ?? UIImage(named: name)).ignoresSafeArea(edges: .bottom) }
                else if failed {
                    ContentUnavailableView {
                        Label(String(localized: "图片暂不可用"), systemImage: "photo")
                    } description: { Text(String(localized: "检查网络后可以重新加载。")) }
                    actions: { Button(String(localized: "重新加载")) { attempt += 1 }.buttonStyle(.bordered).accessibilityIdentifier("retryImage") }
                    .environment(\.colorScheme, .dark)
                }
                else { ProgressView().tint(.white) }
            }.overlay(alignment: .bottom) {
                if offlinePreview {
                    Button { attempt += 1 } label: {
                        Label(String(localized: "当前为离线预览 · 轻点加载清晰图片"), systemImage: "arrow.clockwise")
                            .font(.caption).padding(12).foregroundStyle(.white).background(.black.opacity(0.7), in: Capsule())
                    }.padding().accessibilityIdentifier("loadFullImage")
                }
            }.task(id: "\(url?.absoluteString ?? name)-\(attempt)") {
                guard let url else { return }
                failed = false
                if remoteImage == nil { remoteImage = ImageStore.shared.offlineImage(for: url) }
                do {
                    remoteImage = try await ImageStore.shared.image(for: url, fullResolution: true)
                    offlinePreview = false
                } catch {
                    guard !Task.isCancelled else { return }
                    offlinePreview = remoteImage != nil
                    failed = remoteImage == nil
                }
            }
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { dismiss() } } }
                .toolbarBackground(.visible, for: .navigationBar).toolbarBackground(.black, for: .navigationBar).toolbarColorScheme(.dark, for: .navigationBar)
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
