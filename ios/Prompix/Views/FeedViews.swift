import SwiftUI

struct FeedResults: View {
    let store: FeedStore
    let query: FeedQuery
    var loadsOnAppear = true
    var debounce = false
    var fallback: [Prompt] = []
    var previews: [FeedCard] = []
    var excludingID: String?
    var layout: PromptGridLayout? = nil
    /// Full-width modules placed a little way into the feed rather than above it.
    var interlude: AnyView? = nil
    @State private var fallbackQuery: FeedQuery?
    @Environment(Library.self) private var library
    var body: some View {
        let matches = store.query == ((try? query.validated()) ?? query)
        let waiting = !matches || (store.failure == nil && (store.release == nil || (store.items.isEmpty && store.isLoading)))
        let hasPage = matches && store.release != nil
        let items = (hasPage ? store.items : previews).filter { $0.id != excludingID && !library.isRemoved(id: $0.id) && (query.sort != "recommended" || library.recommendations.allowsRecommended($0)) }
        let offlineItems = fallback.filter { $0.id != excludingID && !library.isRemoved($0) && (query.sort != "recommended" || library.recommendations.allowsRecommended($0)) }
        let showsFallback = items.isEmpty && matches && !offlineItems.isEmpty &&
            (store.failure != nil || (store.isLoading && fallbackQuery == query))
        LazyVStack(spacing: 12) {
            if showsFallback {
                if store.failure != nil {
                    recovery(message: String(localized: "离线可用的内容"))
                } else {
                    HStack {
                        Text(String(localized: "离线可用的内容")).font(.footnote).foregroundStyle(Palette.muted)
                        Spacer()
                        ContentActivityLabel(size: 40)
                    }.frame(minHeight: 44).padding(.horizontal, 16)
                }
                PromptGrid(items: offlineItems).padding(.horizontal, PromptGridLayout.inset)
            }
            if !showsFallback {
                // Keep measured column geometry mounted through cold loads.
                ZStack(alignment: .top) {
                    FeedInterleave(items: items, interlude: interlude) { part in
                        PreviewMasonryGrid(items: part, preview: ContentPreview.init, cell: { FeedPromptCard(card: $0) }, suppliedLayout: layout)
                            .padding(.horizontal, PromptGridLayout.inset)
                    }
                    if waiting && items.isEmpty { FeedLoadingGrid().padding(.horizontal, PromptGridLayout.inset) }
                }
            }
            if waiting {
                if !items.isEmpty && !showsFallback { ContentActivityLabel(size: 48).frame(maxWidth: .infinity) }
            } else if matches && store.failure != nil {
                if !showsFallback { recovery(message: String(localized: "暂时无法连接")) }
            } else if items.isEmpty && !store.isLoading {
                if query.q.isEmpty { QuietEmpty(title: String(localized: "这里还没有作品")) }
                else { QuietEmpty(title: String(localized: "没有找到「\(query.q)」"), message: String(localized: "换个说法，或者少用几个词。")) }
            }
            if matches && store.nextCursor != nil && store.failure == nil {
                FeedNextPageButton(isLoading: store.isLoading, enabled: true) {
                    Task { await store.loadMore() }
                }.accessibilityIdentifier("loadMoreFeed")
            }
        }
        .feedDetailHost()
        .onChange(of: matches && store.failure != nil && items.isEmpty) { _, failed in
            if failed { fallbackQuery = query }
        }
        .feedLookahead(cursor: store.nextCursor, generation: store.firstPageGeneration, enabled: matches && !store.isLoading && store.failure == nil && !store.isCached) {
            Task { await store.loadMore() }
        }
        // SwiftUI cancels this task when it leaves the hierarchy. Do not cancel
        // the entire store on disappearance: overscroll can hide this lazy child
        // while its parent owns a separate, user-initiated refresh.
        .task(id: query) {
            guard loadsOnAppear else { return }
            if debounce {
                do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            }
            guard !Task.isCancelled else { return }
            await store.load(query)
        }
    }
    private func recovery(message: String) -> some View {
        ContentRecoveryRow(message: message, retryAt: store.retryAt, retryID: "retryFeed") {
            Task {
                if !store.failedFirstPage, store.nextCursor != nil, !store.isCached, store.failure as? FeedError != .snapshotExpired { await store.loadMore() }
                else { await store.load(query) } // keeps any cards already read
            }
        }.padding(.horizontal, 16)
    }
}

/// Splits a feed around one full-width interlude. The leading part is fixed at
/// a screen or two of works, so later pages never move the interlude.
struct FeedInterleave<Item: Identifiable, Grid: View>: View {
    static var leadingCount: Int { 12 }
    let items: [Item]
    let interlude: AnyView?
    @ViewBuilder let grid: ([Item]) -> Grid
    var body: some View {
        if let interlude, items.count > Self.leadingCount {
            VStack(alignment: .leading, spacing: 20) {
                grid(Array(items.prefix(Self.leadingCount)))
                interlude
                grid(Array(items.dropFirst(Self.leadingCount)))
            }
        } else { grid(items) }
    }
}

extension EnvironmentValues {
    /// Search results name each visual work in one line; the feed shows only the work.
    @Entry var cardShowsTitle = false
    /// A fixed frame for every card, such as squares on a deck's contact sheet.
    @Entry var cardAspectRatio: CGFloat? = nil
}

struct PromptCardFace: View {
    let preview: ContentPreview
    @Environment(\.cardAspectRatio) private var fixedRatio
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.cardShowsTitle) private var titled
    private var titleIsInArtwork: Bool { preview.usesTextArtwork }
    var body: some View {
        VStack(alignment: .leading, spacing: PromptCardGeometry.titleSpacing) {
            if typeSize.isAccessibilitySize && titleIsInArtwork {
                VStack(alignment: .leading, spacing: 12) {
                    Text(preview.displayTitle).font(.headline).foregroundStyle(.primary)
                    Text(preview.displaySummary).font(.subheadline).foregroundStyle(Palette.muted)
                }.fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(20).background(Palette.soft, in: RoundedRectangle(cornerRadius: PromptCardGeometry.cornerRadius, style: .continuous))
            } else {
                Artwork(preview: preview, compact: fixedRatio != nil, fillsFrame: true).aspectRatio(fixedRatio ?? PromptCardGeometry.aspectRatio(for: preview), contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: fixedRatio == nil ? PromptCardGeometry.cornerRadius : 4, style: .continuous))
            }
            if titled && !titleIsInArtwork && !typeSize.isAccessibilitySize {
                Text(preview.displayTitle).font(.subheadline).foregroundStyle(Palette.ink).lineLimit(1).padding(.horizontal, 2)
            }
        }.contentShape(Rectangle())
    }
}

struct FeedPromptCard: View {
    let card: FeedCard
    @Environment(Library.self) private var library
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    @State private var detailPresented = false
    @State private var action: Task<Void, Never>?
    @State private var actionID: UUID?
    @State private var savedFeedback = false
    @State private var copiedFeedback = false
    @Namespace private var transition
    @Environment(\.feedDetailHost) private var host
    private enum Action { case copy, save }
    private var isPresenting: Bool { host.map { $0.presentedID == card.id } ?? detailPresented }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                library.recommendations.record(.open, card: card)
                if let host { host.open(card) } else { detailPresented = true }
            } label: {
                PromptCardFace(preview: ContentPreview(card)).promptTransitionSource(id: card.id, in: host?.namespace ?? transition)
                    .overlay(alignment: .bottomTrailing) {
                        if actionID != nil { ContentActivityLabel(size: 40).padding(8).background(.regularMaterial, in: Capsule()).padding(8) }
                    }
            }.buttonStyle(.cardPress).accessibilityLabel(card.title).accessibilityIdentifier("prompt-\(card.id)")
                .contextMenu {
                    Button { perform(.copy) } label: {
                        Label { Text(String(localized: "复制 Prompt")) } icon: { PrompixIcon.copy.image }
                    }.disabled(actionID != nil)
                    Button { perform(.save) } label: {
                        Label(library.savedIDs.contains(card.id) ? String(localized: "取消收藏") : String(localized: "收藏 Prompt"),
                              systemImage: library.savedIDs.contains(card.id) ? "bookmark.slash" : "bookmark")
                    }.disabled(actionID != nil)
                    Button { library.recommendations.record(.dismiss, card: card) } label: {
                        Label { Text(RecommendationCopy.text("feedback.less")) } icon: { PrompixIcon.less.image }
                    }
                } preview: {
                    WorkPeek(preview: ContentPreview(card), title: card.title,
                             text: library.feed?.cachedDetail(for: card)?.displayContent.prompt ?? card.summary)
                }
                .sensoryFeedback(.success, trigger: copiedFeedback).sensoryFeedback(.selection, trigger: savedFeedback)
            if typeSize.isAccessibilitySize || voiceOverEnabled, let creator = card.creator {
                NavigationLink { CreatorDetail(creator: creator) } label: {
                    HStack(spacing: 5) {
                        CreatorAvatar(creator: creator, size: 18)
                        Text(creator.displayName).font(.caption).lineLimit(1)
                        Spacer(minLength: 0)
                    }.frame(minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).foregroundStyle(Palette.muted).accessibilityLabel(creator.displayName)
            }
        }
        .recommendationExposure(card, enabled: !isPresenting)
        .fullScreenCover(isPresented: $detailPresented) {
            FeedReadingPresentation(card: card).preferredColorScheme(colorScheme)
                .promptTransitionDestination(id: card.id, in: transition)
        }
        .onDisappear { action?.cancel(); action = nil; actionID = nil }
    }
    private func perform(_ kind: Action) {
        let save = kind == .save
        guard actionID == nil, let feed = library.feed else { return }
        if save, let saved = library.favorites.first(where: { $0.id == card.id }) {
            if library.toggle(saved) { savedFeedback.toggle() }; return
        }
        let owner = UUID(); actionID = owner
        action = Task {
            defer { if actionID == owner { actionID = nil; action = nil } }
            do {
                let item = try await feed.detail(for: card)
                try Task.checkCancellation()
                guard actionID == owner, !library.isRemoved(item) else { throw FeedError.removed }
                if save { if library.toggle(item) { savedFeedback.toggle() } }
                else {
                    UIPasteboard.general.string = item.displayContent.prompt
                    library.recommendations.record(.use, card: card); copiedFeedback.toggle()
                }
            } catch is CancellationError { }
            catch { if !Task.isCancelled, actionID == owner { library.reportContentFailure(error) } }
        }
    }
}

/// The long-press preview: the work large, its meta line, title and the first lines of text.
struct WorkPeek: View {
    let preview: ContentPreview
    let title: String
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !preview.usesTextArtwork {
                Artwork(preview: preview, fillsFrame: true).aspectRatio(PromptCardGeometry.aspectRatio(for: preview), contentMode: .fit)
            }
            VStack(alignment: .leading, spacing: 6) {
                let meta = preview.detailMeta
                if !meta.lead.isEmpty || !meta.rest.isEmpty {
                    (Text(meta.lead).foregroundStyle(Palette.ink).fontWeight(.semibold) + Text(meta.rest).foregroundStyle(Palette.muted))
                        .font(Typography.meta(size: 10)).tracking(1.2)
                }
                Text(title).font(.headline).lineLimit(2)
                Text(text.replacingOccurrences(of: "\n", with: " ")).font(Typography.prompt(size: 14, for: text)).foregroundStyle(Palette.muted).lineLimit(3)
            }.padding(.horizontal, 16).padding(.bottom, 16).padding(.top, preview.usesTextArtwork ? 16 : 0)
        }.frame(width: 320).background(Palette.surface).foregroundStyle(Palette.ink)
    }
}

/// Opens feed details from a list that outlives its cards. A served page that
/// replaces the tapped card (a cached first page, a refresh) never closes the
/// detail it just opened.
struct FeedDetailHost: Sendable {
    let namespace: Namespace.ID
    let presentedID: String?
    let open: @MainActor @Sendable (FeedCard) -> Void
}

private struct FeedDetailHostKey: EnvironmentKey {
    static let defaultValue: FeedDetailHost? = nil
}

extension EnvironmentValues {
    var feedDetailHost: FeedDetailHost? {
        get { self[FeedDetailHostKey.self] }
        set { self[FeedDetailHostKey.self] = newValue }
    }
}

private struct FeedDetailHosting: ViewModifier {
    @State private var presented: FeedCard?
    @Namespace private var transition
    @Environment(\.colorScheme) private var colorScheme
    func body(content: Content) -> some View {
        content
            .environment(\.feedDetailHost, FeedDetailHost(namespace: transition, presentedID: presented?.id) { presented = $0 })
            .fullScreenCover(item: $presented) { card in
                FeedReadingPresentation(card: card).preferredColorScheme(colorScheme)
                    .promptTransitionDestination(id: card.id, in: transition)
            }
    }
}

extension View {
    func feedDetailHost() -> some View { modifier(FeedDetailHosting()) }
}

struct FeedReadingPresentation: View {
    let card: FeedCard
    @Environment(Library.self) private var library
    @Environment(\.dismiss) private var dismiss
    @State private var item: Prompt?
    @State private var failure: (any Error)?
    @State private var retryAt: Date?
    @State private var retry = 0
    @State private var position = DetailReadingPosition()
    private var resolvedItem: Prompt? { item ?? library.feed?.cachedDetail(for: card) }
    private var removed: Bool { failure as? FeedError == .removed || library.isRemoved(id: card.id) }
    var body: some View {
        NavigationStack {
            Group {
                if removed {
                    ContentUnavailableView(String(localized: "内容已被移除"), systemImage: "doc.text.magnifyingglass")
                        .accessibilityIdentifier("feedDetailFailure")
                } else if let item = resolvedItem { PromptDetail(item: item, origin: .catalog, readingPosition: position) }
                else {
                    PendingPromptDetail(card: card, failure: failure, retryAt: retryAt, position: position) { retry += 1 }
                }
            }.paperScreen()
                .toolbarBackground(.hidden, for: .navigationBar)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { dismiss() } label: { PrompixIcon.back.image.frame(minWidth: 44, minHeight: 44) }
                            .accessibilityLabel(String(localized: "返回列表")).accessibilityIdentifier("closePromptDetail")
                    }
                }
                .task(id: retry) {
                    failure = nil; retryAt = nil
                    guard let feed = library.feed else { failure = FeedError.unavailable(5); return }
                    do {
                        let loaded = try await feed.detail(for: card)
                        try Task.checkCancellation(); item = loaded
                    } catch {
                        guard !Task.isCancelled else { return }
                        failure = error
                        if case let FeedError.rateLimited(seconds) = error { retryAt = Date().addingTimeInterval(seconds) }
                        if case let FeedError.unavailable(seconds) = error { retryAt = Date().addingTimeInterval(seconds) }
                    }
                }
        }.tint(Palette.accent)
    }
}

struct FeedRetryButton: View {
    var retryAt: Date? = nil
    var title = String(localized: "重试")
    let action: () -> Void
    @State private var clock = Date()
    var body: some View {
        button.disabled(retryAt.map { clock < $0 } ?? false)
            .task(id: retryAt) {
                clock = Date()
                guard let retryAt else { return }
                let delay = retryAt.timeIntervalSince(clock)
                guard delay > 0 else { return }
                do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                clock = Date()
            }
    }
    @ViewBuilder private var button: some View {
        if #available(iOS 26, *) { control.buttonStyle(.glass) }
        else { control.buttonStyle(.borderless) }
    }
    private var control: some View {
        Button(action: action) {
            Label(title, systemImage: "arrow.clockwise")
                .font(.footnote.weight(.medium)).padding(.horizontal, 4).frame(minHeight: 30)
        }.tint(Palette.accent)
    }
}


/// Owns a query surface independently of discovery/search and preserves it on redraw.
struct OwnedFeedResults: View {
    @State private var store: FeedStore
    let repository: FeedRepository
    let query: FeedQuery
    var fallback: [Prompt] = []
    var initialPreviews: [FeedCard] = []
    var excludingID: String?
    init(repository: FeedRepository, query: FeedQuery, fallback: [Prompt] = [], initialPreviews: [FeedCard] = [], excludingID: String? = nil) {
        _store = State(initialValue: repository.makeStore()); self.repository = repository
        self.query = query; self.fallback = fallback; self.initialPreviews = initialPreviews; self.excludingID = excludingID
    }
    var body: some View {
        FeedResults(store: store, query: query, fallback: fallback,
                    previews: repository.previewCards(for: query, including: initialPreviews), excludingID: excludingID)
    }
}

/// An explicit query explains why these items are connected. This is catalog
/// navigation, not a claim of visual similarity or personalized ranking.
struct FeedExplorationPath: Identifiable {
    let id: String
    let label: String
    let title: String
    let query: FeedQuery
    static func paths(for item: Prompt) -> [Self] {
        var paths: [Self] = []
        if let collection = Collection.all.first(where: { !$0.tags.isEmpty && $0.includes(item) }) {
            paths.append(.init(id: "topic", label: String(localized: "同用途"), title: collection.title,
                               query: FeedQuery(collection: collection.id, sort: "recommended")))
        }
        if !item.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            paths.append(.init(id: "model", label: String(localized: "同模型"), title: item.displayModel,
                               query: FeedQuery(model: item.model, sort: "recommended")))
        }
        if let creator = item.creator {
            paths.append(.init(id: "creator", label: String(localized: "同作者"), title: creator.displayName,
                               query: FeedQuery(creator: creator.id, sort: "recommended")))
        }
        return paths
    }
}

struct FeedRelatedResults: View {
    let item: Prompt
    let repository: FeedRepository
    @State private var store: FeedStore
    @Environment(Library.self) private var library
    init(item: Prompt, repository: FeedRepository) {
        self.item = item; self.repository = repository; _store = State(initialValue: repository.makeStore())
    }
    /// Works from the same use, else the same kind; one quiet heading, no chooser.
    private var path: FeedExplorationPath {
        FeedExplorationPath.paths(for: item).first { $0.id == "topic" }
            ?? FeedExplorationPath(id: "kind", label: "", title: item.displayKind,
                                   query: FeedQuery(kind: item.kind.rawValue, sort: "recommended"))
    }
    var body: some View {
        let path = path
        let matches = store.query == path.query
        let waiting = !matches || (store.failure == nil && (store.release == nil || (store.items.isEmpty && store.isLoading)))
        let source = matches && store.release != nil ? store.items : repository.previewCards(for: path.query)
        let cards = Array(source.filter { $0.id != item.id && !library.isRemoved(id: $0.id) }.prefix(6))
        VStack(alignment: .leading, spacing: 12) {
            if !cards.isEmpty || waiting {
                HStack(alignment: .firstTextBaseline) {
                    Text(String(localized: "相关")).font(.subheadline.weight(.semibold)).accessibilityAddTraits(.isHeader)
                    Spacer()
                    NavigationLink {
                        FeedExplorationView(path: path, excludingID: item.id, repository: repository)
                    } label: {
                        Text(String(localized: "查看全部")).font(.footnote).foregroundStyle(Palette.muted).frame(minHeight: 44)
                    }.accessibilityIdentifier("allExplorationResults")
                }
            }
            // The detail's text sits 22 pt in; works align with every other grid at 16 pt.
            Group {
                if !cards.isEmpty {
                    PreviewMasonryGrid(items: cards, preview: ContentPreview.init) { FeedPromptCard(card: $0) }
                        .feedDetailHost().accessibilityIdentifier("relatedFeed")
                } else if waiting {
                    FeedLoadingGrid(count: 6)
                }
            }.padding(.horizontal, -6)
        }.task(id: path.query) { await store.load(path.query) }.onDisappear { store.cancel() }
    }

}

private struct FeedExplorationView: View {
    let path: FeedExplorationPath
    let excludingID: String
    let repository: FeedRepository
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(path.label).font(.subheadline).foregroundStyle(Palette.muted)
                    Text(path.title).font(Typography.editorial(.title)).fixedSize(horizontal: false, vertical: true)
                }.padding(.horizontal, 20).padding(.top, 12)
                OwnedFeedResults(repository: repository, query: path.query, excludingID: excludingID)
            }.padding(.bottom, 28)
        }.background(Palette.paper).navigationTitle(path.title)
            .navigationBarTitleDisplayMode(.inline).accessibilityIdentifier("explorationResults")
    }
}


/// Keep one stable footer while a page is loading. Binding a task to each new
/// cursor can repeatedly execute before lazy layout moves the footer offscreen.
struct FeedNextPageButton: View {
    let isLoading: Bool
    let enabled: Bool
    let action: () -> Void
    var body: some View {
        if #available(iOS 18, *) {
            button.onScrollVisibilityChange(threshold: 0.5) { visible in
                if visible && enabled && !isLoading { action() }
            }
        } else { button }
    }
    private var button: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isLoading { ContentActivityLabel(size: 64) }
                else { Image(systemName: "arrow.down").font(.footnote); Text(String(localized: "加载更多")).font(.footnote) }
            }.frame(minHeight: 56).foregroundStyle(Palette.muted)
        }.buttonStyle(.plain).disabled(isLoading || !enabled)
            .accessibilityLabel(isLoading ? String(localized: "正在加载内容…") : String(localized: "加载更多"))
    }
}
