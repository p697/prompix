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
    @State private var fallbackQuery: FeedQuery?
    @Environment(Library.self) private var library
    var body: some View {
        let matches = store.query == ((try? query.validated()) ?? query)
        let waiting = !matches || (store.failure == nil && (store.release == nil || (store.items.isEmpty && store.isLoading)))
        let hasPage = matches && store.release != nil
        let items = (hasPage ? store.items : previews).filter { $0.id != excludingID && !library.isRemoved(id: $0.id) && (query.sort != "recommended" || library.recommendations.allowsRecommended($0)) }
        let offlineItems = fallback.filter { $0.id != excludingID && !library.isRemoved($0) }
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
                PromptGrid(items: offlineItems).padding(.horizontal, 12)
            }
            if !showsFallback {
                // Keep measured column geometry mounted through cold loads.
                ZStack(alignment: .top) {
                    PreviewMasonryGrid(items: items, preview: ContentPreview.init, cell: { FeedPromptCard(card: $0) }, suppliedLayout: layout)
                    if waiting && items.isEmpty { FeedLoadingGrid() }
                }.padding(.horizontal, 12)
            }
            if waiting {
                if !items.isEmpty && !showsFallback { ContentActivityLabel(size: 48).frame(maxWidth: .infinity) }
            } else if matches && store.failure != nil {
                if !showsFallback { recovery(message: String(localized: "暂时无法连接")) }
            } else if items.isEmpty && !store.isLoading {
                ContentUnavailableView(String(localized: "暂无匹配内容"), systemImage: "sparkle",
                                       description: Text(String(localized: "试试其他分类，或清除筛选条件。")))
            }
            if matches && store.nextCursor != nil && store.failure == nil {
                FeedNextPageButton(isLoading: store.isLoading, enabled: true) {
                    Task { await store.loadMore() }
                }.accessibilityIdentifier("loadMoreFeed")
            }
        }
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
                else { await store.load(query, force: true) }
            }
        }.padding(.horizontal, 16)
    }
}

struct PromptCardFace: View {
    let preview: ContentPreview
    @Environment(\.dynamicTypeSize) private var typeSize
    private var titleIsInArtwork: Bool { preview.usesTextArtwork }
    var body: some View {
        VStack(alignment: .leading, spacing: PromptCardGeometry.titleSpacing) {
            if typeSize.isAccessibilitySize && titleIsInArtwork {
                VStack(alignment: .leading, spacing: 12) {
                    Text(preview.displayTitle).font(.headline).foregroundStyle(.primary)
                    Text(preview.displaySummary).font(.subheadline).foregroundStyle(Palette.muted)
                }.fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(20).background(Palette.soft, in: RoundedRectangle(cornerRadius: 6))
            } else {
                Artwork(preview: preview, fillsFrame: true).aspectRatio(PromptCardGeometry.aspectRatio(for: preview), contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: titleIsInArtwork ? 6 : 4, style: .continuous))
            }
            if !titleIsInArtwork {
                Text(preview.displayTitle).font(.footnote).foregroundStyle(Palette.ink)
                    .lineLimit(typeSize.isAccessibilitySize ? nil : 2).multilineTextAlignment(.leading).padding(.horizontal, 2)
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
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { library.recommendations.record(.open, card: card); detailPresented = true } label: {
                PromptCardFace(preview: ContentPreview(card)).promptTransitionSource(id: card.id, in: transition)
                    .overlay(alignment: .bottomTrailing) {
                        if actionID != nil { ContentActivityLabel(size: 40).padding(8).background(.regularMaterial, in: Capsule()).padding(8) }
                    }
            }.buttonStyle(.plain).accessibilityLabel(card.title).accessibilityIdentifier("prompt-\(card.id)")
                .contextMenu {
                    Button { library.recommendations.record(.dismiss, card: card) } label: {
                        Label(RecommendationCopy.text("feedback.less"), systemImage: "minus.circle")
                    }
                    Button { perform(save: false) } label: {
                        Label(card.contentType == "skill" ? String(localized: "复制 Skill") : String(localized: "复制 Prompt"), systemImage: "doc.on.doc")
                    }.disabled(actionID != nil)
                    Button { perform(save: true) } label: {
                        Label(library.savedIDs.contains(card.id) ? String(localized: "取消收藏") : String(localized: "收藏 Prompt"),
                              systemImage: library.savedIDs.contains(card.id) ? "bookmark.slash" : "bookmark")
                    }.disabled(actionID != nil)
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
        .recommendationExposure(card, enabled: !detailPresented)
        .fullScreenCover(isPresented: $detailPresented) {
            FeedReadingPresentation(card: card).preferredColorScheme(colorScheme)
                .promptTransitionDestination(id: card.id, in: transition)
        }
        .onDisappear { action?.cancel(); action = nil; actionID = nil }
    }
    private func perform(save: Bool) {
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
                else { UIPasteboard.general.string = item.displayContent.prompt; library.recommendations.record(.use, card: card); copiedFeedback.toggle() }
            } catch is CancellationError { }
            catch { if !Task.isCancelled, actionID == owner { library.reportContentFailure(error) } }
        }
    }
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
                        Button { dismiss() } label: { Image(systemName: "chevron.left").frame(minWidth: 44, minHeight: 44) }
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
    var excludingID: String?
    init(repository: FeedRepository, query: FeedQuery, fallback: [Prompt] = [], excludingID: String? = nil) {
        _store = State(initialValue: repository.makeStore()); self.repository = repository
        self.query = query; self.fallback = fallback; self.excludingID = excludingID
    }
    var body: some View {
        FeedResults(store: store, query: query, fallback: fallback,
                    previews: repository.previewCards(for: query), excludingID: excludingID)
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
    @State private var selectedID: String?
    @Environment(Library.self) private var library
    @Environment(\.dynamicTypeSize) private var typeSize
    init(item: Prompt, repository: FeedRepository) {
        self.item = item; self.repository = repository; _store = State(initialValue: repository.makeStore())
    }
    private var paths: [FeedExplorationPath] { FeedExplorationPath.paths(for: item) }
    private var selected: FeedExplorationPath? { paths.first { $0.id == selectedID } ?? paths.first }
    var body: some View {
        if let path = selected {
            let matches = store.query == path.query
            let waiting = !matches || (store.failure == nil && (store.release == nil || (store.items.isEmpty && store.isLoading)))
            let source = matches && store.release != nil ? store.items : repository.previewCards(for: path.query)
            let cards = Array(source.filter { $0.id != item.id && !library.isRemoved(id: $0.id) }.prefix(4))
            VStack(alignment: .leading, spacing: 18) {
                Divider()
                HStack {
                    Text(String(localized: "继续探索")).font(.headline).accessibilityAddTraits(.isHeader)
                    Spacer()
                    NavigationLink {
                        FeedExplorationView(path: path, excludingID: item.id, repository: repository)
                    } label: {
                        Label(String(localized: "查看全部"), systemImage: "arrow.right").font(.footnote).frame(minHeight: 44)
                    }.accessibilityIdentifier("allExplorationResults")
                }
                if typeSize.isAccessibilitySize {
                    VStack(spacing: 8) { pathButtons }
                } else {
                    ScrollView(.horizontal) { HStack(spacing: 8) { pathButtons } }.scrollIndicators(.hidden)
                }
                if !cards.isEmpty {
                    PreviewMasonryGrid(items: cards, preview: ContentPreview.init) { FeedPromptCard(card: $0) }
                        .accessibilityIdentifier("relatedFeed")
                }
                if waiting && cards.isEmpty {
                    FeedLoadingGrid()
                } else if matches && store.failure != nil {
                    ContentRecoveryRow(retryAt: store.retryAt, retryID: "retryExploration") {
                        Task { await store.load(path.query, force: true) }
                    }
                } else if !waiting && cards.isEmpty && !store.isLoading {
                    Text(String(localized: "暂无匹配内容")).font(.subheadline).foregroundStyle(Palette.muted).padding(.vertical, 12)
                }
            }.task(id: path.query) { await store.load(path.query) }.onDisappear { store.cancel() }
        }
    }
    private var pathButtons: some View {
        ForEach(paths) { path in
            let active = path.id == selected?.id
            Button { selectedID = path.id } label: {
                VStack(alignment: .leading, spacing: 5) {
                    Text(path.label).font(.caption).opacity(active ? 0.85 : 0.7)
                    Text(path.title).font(.subheadline.weight(.medium)).lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                }
                .frame(minWidth: 100, maxWidth: typeSize.isAccessibilitySize ? .infinity : 230, minHeight: 44, alignment: .leading)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .foregroundStyle(active ? Palette.paper : Palette.ink)
                .background(active ? Palette.accent : Palette.soft, in: RoundedRectangle(cornerRadius: 12))
                .contentShape(RoundedRectangle(cornerRadius: 12))
            }.buttonStyle(.plain).accessibilityAddTraits(active ? .isSelected : [])
                .accessibilityIdentifier("explore-\(path.id)")
        }
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
