import SwiftUI

struct FeedCreatorResults: View {
    @State private var store: FeedCreatorStore
    let query: String
    init(repository: FeedRepository, query: String) {
        _store = State(initialValue: repository.makeCreatorStore()); self.query = query
    }
    var body: some View {
        LazyVStack(spacing: 0) {
            ForEach(store.items) { item in
                NavigationLink { CreatorDetail(creator: item.creator) } label: {
                    CreatorRow(entry: CreatorEntry(creator: item.creator, count: item.count)).padding(.vertical, 14)
                }.buttonStyle(.plain).accessibilityIdentifier("creator-\(item.id)")
                if item.id != store.items.last?.id { Rectangle().fill(Palette.line).frame(height: 0.5).padding(.leading, 64) }
            }
            if (store.isLoading && store.nextCursor == nil) || store.query == nil {
                ProgressView(String(localized: "正在加载内容…")).padding(20)
            } else if store.failure != nil {
                Text(String(localized: "内容更新未完成")).font(.footnote).foregroundStyle(Palette.muted)
                FeedRetryButton(retryAt: store.retryAt) {
                    Task {
                        if store.nextCursor != nil, !store.isCached, store.failure as? FeedError != .snapshotExpired { await store.loadMore() }
                        else { await store.load(query, force: true) }
                    }
                }.accessibilityIdentifier("retryCreators")
            } else if store.items.isEmpty && !store.isLoading {
                if query.isEmpty { ContentUnavailableView(String(localized: "暂无创作者"), systemImage: "person.crop.circle") }
                else { ContentUnavailableView.search(text: query) }
            }
            if store.nextCursor != nil {
                FeedNextPageButton(isLoading: store.isLoading, enabled: store.failure == nil) {
                    Task { await store.loadMore() }
                }.accessibilityIdentifier("loadMoreCreators")
            }
        }.padding(.horizontal, 20).padding(.bottom, 24)
            .task(id: query) {
                do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
                await store.load(query)
            }
            .onDisappear { store.cancel() }
            .refreshable { await store.load(query, force: true) }
    }
}

struct FeedCreatorSearch: View {
    @State private var store: FeedCreatorStore
    let query: String
    init(repository: FeedRepository, query: String) {
        _store = State(initialValue: repository.makeCreatorStore()); self.query = query
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !store.items.isEmpty {
                HStack {
                    Text(String(localized: "创作者")).font(.subheadline.weight(.medium)).accessibilityAddTraits(.isHeader)
                    Spacer()
                    NavigationLink { CreatorsView(query: query) } label: {
                        Text(String(localized: "查看全部")).font(.footnote).frame(minHeight: 44)
                    }.accessibilityIdentifier("allSearchCreators")
                }
                ForEach(store.items.prefix(3)) { item in
                    NavigationLink { CreatorDetail(creator: item.creator) } label: {
                        CreatorRow(entry: CreatorEntry(creator: item.creator, count: item.count))
                    }.buttonStyle(.plain).accessibilityIdentifier("creator-\(item.id)")
                }
            } else if store.failure != nil {
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
            .onDisappear { store.cancel() }
    }
}
