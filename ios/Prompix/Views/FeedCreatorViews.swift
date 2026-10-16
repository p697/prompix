import SwiftUI

struct FeedCreatorResults: View {
    @State private var store: CreatorDiscoveryStore
    let repository: FeedRepository
    let query: CreatorQuery
    init(repository: FeedRepository, query: CreatorQuery) {
        _store = State(initialValue: repository.makeCreatorDiscoveryStore()); self.repository = repository; self.query = query
    }
    var body: some View {
        let normalized = (try? CreatorDiscoverySource.validate(query)) ?? query
        let matches = store.query == normalized
        let waiting = !matches || (store.failure == nil && (store.release == nil || (store.items.isEmpty && store.isLoading)))
        let items = matches && store.release != nil ? store.items : (normalized == repository.creatorDiscovery.query ? repository.creatorDiscovery.items : [])
        ScrollView {
        LazyVStack(spacing: 0) {
            ForEach(items) { item in
                NavigationLink { CreatorDetail(creator: item.creator, initialKind: query.kind) } label: {
                    CreatorRow(entry: CreatorEntry(creator: item.creator, count: item.count, preview: repository.creatorPreview(item))).padding(.vertical, 14)
                }.buttonStyle(.plain).accessibilityIdentifier("creator-\(item.id)")
                if item.id != items.last?.id { Rectangle().fill(Palette.line).frame(height: 0.5).padding(.leading, 64) }
            }
            if waiting && items.isEmpty {
                CreatorLoadingRows()
            } else if matches && store.failure != nil {
                ContentRecoveryRow(retryAt: store.retryAt, retryID: "retryCreators") {
                    Task {
                        if !store.failedFirstPage, store.nextCursor != nil, !store.isCached, store.failure as? FeedError != .snapshotExpired { await store.loadMore() }
                        else { await store.load(query, force: true) }
                    }
                }
            } else if items.isEmpty && !waiting && !store.isLoading {
                if query.q.isEmpty { ContentUnavailableView(String(localized: "暂无创作者"), systemImage: "person.crop.circle") }
                else { ContentUnavailableView.search(text: query.q) }
            }
            if matches && store.nextCursor != nil {
                FeedNextPageButton(isLoading: store.isLoading, enabled: store.failure == nil) {
                    Task { await store.loadMore() }
                }.accessibilityIdentifier("loadMoreCreators")
            }
        }.padding(.horizontal, 20).padding(.bottom, 24)
            .feedLookahead(cursor: store.nextCursor, generation: store.firstPageGeneration, enabled: matches && !store.isLoading && store.failure == nil && !store.isCached) {
                Task { await store.loadMore() }
            }
        }
            .refreshable { await store.load(query, force: true) }
            .task(id: query) {
                if !query.q.isEmpty { do { try await Task.sleep(for: .milliseconds(300)) } catch { return } }
                guard !Task.isCancelled else { return }
                await store.load(query)
            }

    }
}

struct FeedCreatorSearch: View {
    @State private var store: FeedCreatorStore
    let query: String
    init(repository: FeedRepository, query: String) {
        _store = State(initialValue: repository.makeCreatorStore()); self.query = query
    }
    var body: some View {
        let matches = store.query == ((try? FeedCreatorsSource.validate(query)) ?? query)
        let items = matches ? store.items : []
        VStack(alignment: .leading, spacing: 8) {
            if !items.isEmpty {
                HStack {
                    Text(String(localized: "创作者")).font(.subheadline.weight(.medium)).accessibilityAddTraits(.isHeader)
                    Spacer()
                    NavigationLink { CreatorsView(query: query) } label: {
                        Text(String(localized: "查看全部")).font(.footnote).frame(minHeight: 44)
                    }.accessibilityIdentifier("allSearchCreators")
                }
                ForEach(items.prefix(3)) { item in
                    NavigationLink { CreatorDetail(creator: item.creator) } label: {
                        CreatorRow(entry: CreatorEntry(creator: item.creator, count: item.count))
                    }.buttonStyle(.plain).accessibilityIdentifier("creator-\(item.id)")
                }
            } else if matches && store.failure != nil {
                NavigationLink { CreatorsView(query: query) } label: {
                    Label(String(localized: "搜索创作者"), systemImage: "person.crop.circle")
                        .font(.footnote).frame(minHeight: 44)
                }
            }
        }.padding(.horizontal, 20).accessibilityIdentifier("searchCreators")
            .task(id: query) {
                do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
                await store.load(query)
            }
    }
}
