import SwiftUI
import AVKit

struct PromptDetail: View {
    let item: Prompt
    @Environment(Library.self) private var library
    @State private var editorPresented = false
    @State private var imagePresented = false
    @State private var playerPresented = false
    @State private var copied = false
    @State private var webPresented = false
    private var related: [Prompt] {
        Array(library.prompts.filter { $0.id != item.id && !$0.tags.filter(item.tags.contains).isEmpty }.prefix(4))
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 25) {
                if item.kind == .video || item.media?.image != nil || item.media?.imageURL != nil {
                    Button {
                        if item.kind == .video { playerPresented = true } else { imagePresented = true }
                    } label: {
                        hero.overlay(alignment: .bottomTrailing) {
                            Image(systemName: item.kind == .video ? "play.fill" : "arrow.up.left.and.arrow.down.right")
                                .font(.body).padding(14).background(.regularMaterial, in: Circle()).padding(16)
                        }
                    }.buttonStyle(.plain)
                        .accessibilityLabel(item.kind == .video ? "播放视频" : "放大图片")
                        .accessibilityIdentifier("previewButton")
                } else { hero }
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Label(item.kind.title, systemImage: item.kind.symbol)
                            Text("·")
                            Text(item.model)
                        }.font(.caption).foregroundStyle(.secondary)
                        Text(item.title).font(.title2.weight(.semibold)).lineSpacing(5).fixedSize(horizontal: false, vertical: true)
                        Text(item.summary).font(.subheadline).lineSpacing(5).foregroundStyle(.secondary)
                        Text(item.previewLabel).font(.caption2).foregroundStyle(.tertiary)
                    }
                    Divider()
                    VStack(alignment: .leading, spacing: 10) {
                        Eyebrow(text: "THE IDEA")
                        Text(item.kind == .text ? "你会得到什么" : "创作思路").font(.headline)
                        Text(item.example).font(.subheadline).lineSpacing(6).textSelection(.enabled)
                    }
                    VStack(alignment: .leading, spacing: 14) {
                        HStack {
                            Eyebrow(text: "THE PROMPT")
                            Spacer()
                            Button("编辑", systemImage: "square.and.pencil") { editorPresented = true }.font(.subheadline)
                                .accessibilityIdentifier("editPrompt")
                        }
                        Text(item.prompt).font(.system(.subheadline)).lineSpacing(6).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }.padding(20).background(Palette.soft, in: RoundedRectangle(cornerRadius: 18))
                    if item.id == "quiet-portfolio" {
                        Button("打开原创网页示例", systemImage: "safari") { webPresented = true }.accessibilityIdentifier("webExample")
                    }
                    if let toolURL = item.toolURL {
                        Link(destination: toolURL) {
                            HStack {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text("带着灵感，去试试").font(.subheadline.weight(.medium))
                                    Text("复制后打开工具，粘贴使用").font(.caption).foregroundStyle(.secondary)
                                }; Spacer(); Image(systemName: "arrow.up.right")
                            }.padding(.vertical, 5)
                        }
                    }
                    if let demo = item.media?.demoURL { Link("打开网页示例", destination: demo).font(.subheadline) }
                    VStack(alignment: .leading, spacing: 8) {
                        HStack { Text(item.source.author ?? item.source.name).font(.caption.weight(.medium)); Spacer(); Text(item.source.method).font(.caption).foregroundStyle(.secondary) }
                        Text("\(item.source.license) · \(item.previewLabel)").font(.caption2).foregroundStyle(.secondary)
                        if let repository = item.source.repository { Link("收录于 \(item.source.name)", destination: repository).font(.caption) }
                        if let source = item.source.url { Link("查看原始来源 ↗", destination: source).font(.caption) }
                    }
                    if !related.isEmpty {
                        Divider()
                        HStack { Text("顺着灵感，再逛一点").font(.headline); Spacer(); Image(systemName: "arrow.down.right").foregroundStyle(.secondary) }
                        PromptGrid(items: related)
                    }
                }.padding(.horizontal, 22)
            }.padding(.bottom, 28)
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: "\(item.title)\n\n\(item.prompt)\n\n来自 \(item.source.author ?? item.source.name) · \(item.source.license)\n\(item.source.url?.absoluteString ?? "https://prompix.dev")") { Label("分享", systemImage: "square.and.arrow.up") }
                    .accessibilityIdentifier("sharePrompt")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { library.toggle(item) } label: { Image(systemName: library.isSaved(item) ? "bookmark.fill" : "bookmark") }
                    .accessibilityLabel(library.isSaved(item) ? "取消收藏" : "收藏 Prompt").accessibilityIdentifier("detailFavorite")
            }
        }
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 12) {
                Button { editorPresented = true } label: { Image(systemName: "slider.horizontal.3").frame(width: 50, height: 48) }
                    .buttonStyle(.plain).background(Palette.soft, in: RoundedRectangle(cornerRadius: 16)).accessibilityLabel("编辑后使用")
                Button {
                    UIPasteboard.general.string = item.prompt
                    copied = true
                } label: {
                    Label(copied ? "已复制，去创造吧" : "复制 Prompt", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity).frame(height: 48)
                        .foregroundStyle(Color(uiColor: .systemBackground)).background(Color.primary, in: RoundedRectangle(cornerRadius: 16))
                }.buttonStyle(.plain).accessibilityIdentifier("copyPrompt").sensoryFeedback(.success, trigger: copied)
            }.padding(.horizontal, 20).padding(.vertical, 10).background(.bar)
        }
        .sheet(isPresented: $editorPresented) { PromptEditor(item: item) }
        .fullScreenCover(isPresented: $imagePresented) { ImageViewer(name: item.media?.image ?? item.artwork, url: item.media?.imageURL) }
        .sheet(isPresented: $webPresented) { WebExample() }
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
                    Text("写进你的想法，变成自己的版本。原始 Prompt 会保留。").font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Label(saved ? "已保存到此设备" : library.error == nil ? "正在保存…" : "尚未保存，可先复制保留", systemImage: saved ? "checkmark.circle" : "circle.dotted")
                            .font(.caption2).foregroundStyle(.secondary).accessibilityIdentifier("draftStatus")
                        Spacer()
                        Text("\(text.count) 字符").font(.caption2.monospacedDigit()).foregroundStyle(.tertiary)
                    }
                }.padding(.horizontal, 20).padding(.top, 14)
                TextEditor(text: $text).font(.body).scrollContentBackground(.hidden).padding(.horizontal, 16)
                    .accessibilityIdentifier("promptEditor")
            }.navigationTitle("让它更像你").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("完成") { if library.saveDraft(text, for: item) { dismiss() } } }
                    ToolbarItem(placement: .primaryAction) {
                        Menu {
                            Button("恢复原始 Prompt", systemImage: "arrow.counterclockwise", role: .destructive) { restorePresented = true }
                                .disabled(text == item.prompt)
                        } label: { Label("编辑选项", systemImage: "ellipsis.circle") }
                    }
                    ToolbarItem(placement: .primaryAction) { ShareLink(item: text) { Label("分享", systemImage: "square.and.arrow.up") }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
                }
                .safeAreaInset(edge: .bottom) {
                    Button {
                        UIPasteboard.general.string = text; copied = true
                        saved = library.saveDraft(text, for: item)
                    } label: { Label(copied ? "已复制修改后的 Prompt" : "复制修改后的 Prompt", systemImage: copied ? "checkmark" : "doc.on.doc").frame(maxWidth: .infinity).padding(10) }
                        .buttonStyle(.borderedProminent).disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
                .confirmationDialog("恢复原始 Prompt？", isPresented: $restorePresented, titleVisibility: .visible) {
                    Button("恢复原文", role: .destructive) { text = item.prompt; saved = library.saveDraft(text, for: item) }
                    Button("取消", role: .cancel) {}
                } message: { Text("这会替换你在此设备上保存的修改。") }
        }
    }
}

struct MovieView: View {
    let filename: String?
    let remoteURL: URL?
    let caption: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var player: AVPlayer?
    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                if let player { VideoPlayer(player: player).aspectRatio(16/9, contentMode: .fit) }
                else { ContentUnavailableView("视频暂不可用", systemImage: "video.slash", description: Text("你仍可以复制完整 Prompt，去创作自己的版本。")) }
                Text(caption).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 20)
            }.navigationTitle("动态灵感").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
                .onAppear {
                    if let remoteURL { player = AVPlayer(url: remoteURL); player?.play() }
                    else if let filename, let url = Bundle.main.url(forResource: filename, withExtension: "mp4") { player = AVPlayer(url: url); player?.play() }
                }.onDisappear { player?.pause(); player = nil }
                .onChange(of: scenePhase) { _, phase in if phase != .active { player?.pause() } }
        }
    }
}

struct ImageViewer: View {
    let name: String
    let url: URL?
    @State private var remoteImage: UIImage?
    @State private var failed = false
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ZStack {
                Color.black
                if url == nil || remoteImage != nil { ZoomImage(image: remoteImage ?? UIImage(named: name)).ignoresSafeArea(edges: .bottom) }
                else if failed { ContentUnavailableView("图片暂不可用", systemImage: "photo", description: Text("关闭后可以重新尝试。")) }
                else { ProgressView().tint(.white) }
            }.task(id: url) { if let url { do { remoteImage = try await ImageStore.shared.image(for: url) } catch { failed = true } } }
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
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
        scroll.accessibilityLabel = "图片预览，双指缩放或双击放大"
        return scroll
    }
    func updateUIView(_ uiView: UIScrollView, context: Context) {}
    class Coordinator: NSObject, UIScrollViewDelegate {
        weak var image: UIImageView?
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { image }
        @objc func doubleTap(_ gesture: UITapGestureRecognizer) {
            guard let scroll = gesture.view as? UIScrollView else { return }
            if scroll.zoomScale > 1 { scroll.setZoomScale(1, animated: true) }
            else {
                let point = gesture.location(in: image)
                scroll.zoom(to: CGRect(x: point.x - scroll.bounds.width / 4, y: point.y - scroll.bounds.height / 4, width: scroll.bounds.width / 2, height: scroll.bounds.height / 2), animated: true)
            }
        }
    }
}
