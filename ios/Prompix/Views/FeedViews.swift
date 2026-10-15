import SwiftUI

struct FeedResults: View {
    let store: FeedStore
    let query: FeedQuery
    var debounce = false
    var fallback: [Prompt] = []
    @Environment(Library.self) private var library
    var body: some View {
        let items = store.items.filter { !library.isRemoved(id: $0.id) }
        LazyVStack(spacing: 18) {
            if !items.isEmpty {
                PreviewMasonryGrid(items: items, preview: ContentPreview.init) { FeedPromptCard(card: $0) }
                    .padding(.horizontal, 12)
            }
            if items.isEmpty && (store.isLoading || store.query == nil) {
                ProgressView(String(localized: "正在加载内容…")).padding(20).accessibilityIdentifier("feedLoading")
            } else if store.failure != nil {
                VStack(spacing: 10) {
                    Text(String(localized: "内容更新未完成")).font(.subheadline)
                    if !items.isEmpty { Text(String(localized: "已下载内容仍可浏览，轻点重试。")).font(.footnote).foregroundStyle(Palette.muted) }
                    FeedRetryButton(retryAt: store.retryAt) {
                        Task {
                            if !store.failedFirstPage, store.nextCursor != nil, !store.isCached, store.failure as? FeedError != .snapshotExpired { await store.loadMore() }
                            else { await store.load(query, force: true) }
                        }
                    }.accessibilityIdentifier("retryFeed")
                }.padding(20)
            } else if items.isEmpty && !store.isLoading {
                ContentUnavailableView(String(localized: "暂无匹配内容"), systemImage: "sparkle",
                                       description: Text(String(localized: "试试其他分类，或清除筛选条件。")))
            }
            if items.isEmpty, store.failure != nil, !fallback.isEmpty {
                Text(String(localized: "离线可用的内容")).font(.subheadline).foregroundStyle(Palette.muted)
                PromptGrid(items: fallback).padding(.horizontal, 12)
            }
            if store.nextCursor != nil {
                FeedNextPageButton(isLoading: store.isLoading, enabled: store.failure == nil) {
                    Task { await store.loadMore() }
                }.accessibilityIdentifier("loadMoreFeed")
            }
        }
        // SwiftUI cancels this task when it leaves the hierarchy. Do not cancel
        // the entire store on disappearance: overscroll can hide this lazy child
        // while its parent owns a separate, user-initiated refresh.
        .task(id: query) {
            if debounce {
                do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            }
            guard !Task.isCancelled else { return }
            await store.load(query)
        }
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
            Button { detailPresented = true } label: {
                PromptCardFace(preview: ContentPreview(card)).promptTransitionSource(id: card.id, in: transition)
                    .overlay(alignment: .bottomTrailing) {
                        if actionID != nil { ProgressView().padding(12).background(.regularMaterial, in: Circle()).padding(8) }
                    }
            }.buttonStyle(.plain).accessibilityLabel(card.title).accessibilityIdentifier("prompt-\(card.id)")
                .contextMenu {
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
                else { UIPasteboard.general.string = item.displayContent.prompt; copiedFeedback.toggle() }
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
    let retryAt: Date?
    let action: () -> Void
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Button(String(localized: "重试"), action: action).buttonStyle(.bordered)
                .disabled(retryAt.map { context.date < $0 } ?? false)
        }
    }
}


/// Owns a query surface independently of discovery/search and preserves it on redraw.
struct OwnedFeedResults: View {
    @State private var store: FeedStore
    let query: FeedQuery
    var fallback: [Prompt] = []
    init(repository: FeedRepository, query: FeedQuery, fallback: [Prompt] = []) {
        _store = State(initialValue: repository.makeStore()); self.query = query; self.fallback = fallback
    }
    var body: some View { FeedResults(store: store, query: query, fallback: fallback) }
}

/// Recommendations fetch one small page from the full catalog. They never drain
/// the feed or depend on whichever cards discovery happened to load first.
struct FeedRelatedResults: View {
    let item: Prompt
    @State private var store: FeedStore
    @Environment(Library.self) private var library
    init(item: Prompt, repository: FeedRepository) {
        self.item = item; _store = State(initialValue: repository.makeStore())
    }
    private var query: FeedQuery {
        let broad: Set<String> = ["好玩一点", "创作灵感", "日常有用", "文本", "图片", "视频", "网页"]
        return FeedQuery(kind: item.isSkill ? "skill" : item.kind.rawValue, tag: item.tags.first { !broad.contains($0) })
    }
    var body: some View {
        let cards = Array(store.items.filter { $0.id != item.id && !library.isRemoved(id: $0.id) }.prefix(4))
        VStack(alignment: .leading, spacing: 24) {
            if store.query == nil || store.isLoading { ProgressView().frame(maxWidth: .infinity) }
            if !cards.isEmpty {
                Divider()
                HStack {
                    Text(String(localized: "相关 Prompt")).font(.headline).accessibilityAddTraits(.isHeader)
                    Spacer(); Image(systemName: "arrow.down.right").foregroundStyle(Palette.muted).accessibilityHidden(true)
                }
                PreviewMasonryGrid(items: cards, preview: ContentPreview.init) { FeedPromptCard(card: $0) }
                    .accessibilityIdentifier("relatedFeed")
            }
        }.task(id: query) { await store.load(query) }.onDisappear { store.cancel() }
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
                if isLoading { ProgressView() }
                Text(String(localized: "加载更多"))
            }.frame(minHeight: 44)
        }.disabled(isLoading || !enabled)
    }
}
