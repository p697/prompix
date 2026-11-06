import SwiftUI

/// Owns its navigation history so searches survive switching to another tab.
struct SearchView: View {
    @Environment(Library.self) private var library
    let isSelected: Bool
    let activation: Int
    @State private var query = ""
    @State private var searchPresented = false
    @State private var suspendingLegacySearch = false
    @FocusState private var searchFocused: Bool
    @State private var handledActivation: Int?
    @State private var kind: PromptKind?
    @State private var skillsOnly = false
    @State private var recent = UserDefaults.standard.stringArray(forKey: "recentSearches") ?? []
    @State private var completedSearch: LocalSearchRequest?
    @State private var matchedPrompts: [Prompt] = []
    @State private var matchedCreators: [CreatorEntry] = []

    private var normalizedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var isBrowsing: Bool { normalizedQuery.isEmpty && kind == nil && !skillsOnly }
    private var localSearch: LocalSearchRequest? {
        guard !isBrowsing else { return nil }
        if let store = library.feed?.search {
            // Server results are primary. Scan local full text only when the
            // current request failed without a usable cached page.
            let feedQuery = FeedQuery(kind: skillsOnly ? "skill" : kind?.rawValue, q: query)
            guard let normalized = try? feedQuery.validated(), store.query == normalized,
                  store.failure != nil, store.items.isEmpty else { return nil }
        }
        return LocalSearchRequest(query: PromptQuery(text: query, kind: kind, skillsOnly: skillsOnly),
                                  catalog: library.prompts, includesCreators: library.feed == nil && kind == nil && !skillsOnly && !normalizedQuery.isEmpty)
    }
    private var results: [Prompt] { completedSearch == localSearch ? matchedPrompts : [] }
    private var creators: [CreatorEntry] { completedSearch == localSearch ? matchedCreators : [] }
    private var searchText: Binding<String> {
        Binding(get: { query }, set: { value in
            if !suspendingLegacySearch { query = value }
        })
    }

    @ViewBuilder private func searchableContent<Content: View>(_ content: Content) -> some View {
        if #available(iOS 18, *) {
            content.searchFocused($searchFocused)
        } else { content }
    }

    var body: some View {
        NavigationStack {
            searchableContent(ScrollView {
                LazyVStack(alignment: .leading, spacing: 20, pinnedViews: [.sectionHeaders]) {
                    if isBrowsing {
                        if !recent.isEmpty { recentSearches }
                        SearchUseTiles()
                    } else {
                        // Kinds narrow a search, so they appear once there is one and stay pinned while results scroll.
                        Section {
                            searchResults
                        } header: {
                            KindPicker(selection: $kind, skillsOnly: $skillsOnly).padding(.bottom, 4)
                                .background(Palette.paper)
                        }
                    }
                }.padding(.top, 8).padding(.bottom, 28)
            }
            .accessibilityIdentifier("searchResults")
            .scrollDismissesKeyboard(.interactively)
            .background(Palette.paper).foregroundStyle(Palette.ink)
            .navigationTitle(String(localized: "搜索"))
            .navigationBarTitleDisplayMode(.large)
            .searchable(text: searchText, isPresented: $searchPresented, prompt: String(localized: "搜索 Prompt、Skills 或创作者"))
            .autocorrectionDisabled().textInputAutocapitalization(.never)
            .onSubmit(of: .search) { rememberQuery() }
            .pageRefreshable {
                await library.refresh(force: true)
                await library.feed?.search.load(FeedQuery(kind: skillsOnly ? "skill" : kind?.rawValue, q: query), force: true)
            }
            .task { await library.refresh() })
        }
        .task(id: isSelected ? activation : nil) {
            guard isSelected, handledActivation != activation else { return }
            // Let the selected destination mount before asking its search field
            // for focus. A presentation binding alone can remain true after the
            // keyboard was dismissed and cannot express another focus request.
            await Task.yield()
            guard !Task.isCancelled, isSelected else { return }
            handledActivation = activation
            suspendingLegacySearch = false
            searchPresented = true
            searchFocused = true
        }
        .onChange(of: isSelected) { _, selected in
            if !selected {
                searchFocused = false
                if #unavailable(iOS 18) {
                    // iOS 17 has no searchFocused API. Re-arm presentation for
                    // the next visit without accepting its automatic text reset.
                    suspendingLegacySearch = true
                    searchPresented = false
                }
            }
        }
        .task(id: isSelected ? localSearch : nil) {
            guard isSelected, let request = localSearch, completedSearch != request else { return }
            do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
            let worker = Task.detached(priority: .userInitiated) {
                let prompts = request.query.results(in: request.catalog, isCancelled: { Task.isCancelled })
                let creators = request.includesCreators && !Task.isCancelled
                    ? CreatorDirectory.entries(in: request.catalog).filter { $0.creator.matchesSearch(request.query.text) } : []
                return (prompts, creators)
            }
            let matches = await withTaskCancellationHandler { await worker.value } onCancel: { worker.cancel() }
            guard !Task.isCancelled else { return }
            matchedPrompts = matches.0; matchedCreators = matches.1; completedSearch = request
        }
    }

    private var recentSearches: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(String(localized: "最近")).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.muted)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Button(String(localized: "清除")) {
                    recent = []
                    UserDefaults.standard.removeObject(forKey: "recentSearches")
                }.font(.footnote).foregroundStyle(Palette.muted).frame(minHeight: 44).accessibilityIdentifier("clearRecentSearches")
            }.padding(.horizontal, 20)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(recent, id: \.self) { term in
                        Button { query = term; rememberQuery() } label: {
                            Text(term).font(.subheadline).padding(.horizontal, 14).frame(minHeight: 34)
                                .background(Palette.soft, in: Capsule()).frame(minHeight: 44).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("searchSuggestion-\(term)")
                    }
                }.padding(.horizontal, 20)
            }
        }
    }

    @ViewBuilder private var searchResults: some View {
        if let feed = library.feed {
            // One stack, so an empty creator section adds no gap above the works.
            VStack(alignment: .leading, spacing: 0) {
                if kind == nil && !skillsOnly && !normalizedQuery.isEmpty { FeedCreatorSearch(repository: feed, query: normalizedQuery) }
                FeedResults(store: feed.search, query: FeedQuery(kind: skillsOnly ? "skill" : kind?.rawValue, q: query), debounce: true, fallback: results)
                    .environment(\.cardShowsTitle, true)
            }
        } else { legacyResults }
    }
    @ViewBuilder private var legacyResults: some View {
        if completedSearch != localSearch {
            ContentActivityLabel().frame(maxWidth: .infinity).padding()
        } else { legacyMatches }
    }

    @ViewBuilder private var legacyMatches: some View {
        let matchedCreators = creators
        let matchedPrompts = results
        if !matchedCreators.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text(String(localized: "创作者")).font(.subheadline.weight(.medium))
                    .accessibilityAddTraits(.isHeader).padding(.horizontal, 20)
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: 12) {
                        ForEach(matchedCreators) { entry in
                            NavigationLink { CreatorDetail(creator: entry.creator) } label: {
                                VStack(spacing: 7) {
                                    CreatorAvatar(creator: entry.creator, size: 48)
                                    Text(entry.creator.displayName).font(.caption).lineLimit(2)
                                        .multilineTextAlignment(.center)
                                }.frame(width: 82, alignment: .top).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                                .accessibilityLabel(entry.creator.displayName)
                                .accessibilityValue(String(localized: "\(entry.count) 条内容"))
                                .accessibilityIdentifier("creator-\(entry.id)")
                        }
                    }.padding(.horizontal, 16)
                }.accessibilityIdentifier("searchCreators")
            }
        }
        if matchedPrompts.isEmpty && matchedCreators.isEmpty {
            ContentUnavailableView {
                Label(String(localized: "没有找到相关内容"), systemImage: "magnifyingglass")
            } description: {
                Text(String(localized: "试试更少的关键词，或更新内容后再搜索。"))
            } actions: {
                Button(String(localized: "更新内容")) {
                    Task { await library.refresh(force: true) }
                }.disabled(library.isRefreshing).accessibilityIdentifier("refreshEmptySearch")
            }
        } else if !matchedPrompts.isEmpty {
            Text(String(localized: "\(matchedPrompts.count) 条内容")).font(.footnote)
                .foregroundStyle(Palette.muted).padding(.horizontal, 20)
                .accessibilityIdentifier("searchResultCount")
            PromptGrid(items: matchedPrompts).padding(.horizontal, 16).environment(\.cardShowsTitle, true)
        }
    }

    private func rememberQuery() {
        guard !normalizedQuery.isEmpty else { return }
        // A term that extends or shortens another replaces it: typing island, then islands, keeps one.
        let key = normalizedQuery.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
        recent = Array(([normalizedQuery] + recent.filter {
            let other = $0.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
            return !other.hasPrefix(key) && !key.hasPrefix(other)
        }).prefix(6))
        UserDefaults.standard.set(recent, forKey: "recentSearches")
    }
}

private struct LocalSearchRequest: Equatable {
    let query: PromptQuery
    let catalog: [Prompt]
    let includesCreators: Bool
}

/// Four uses as photo tiles; the full list sits behind "查看全部".
private struct SearchUseTiles: View {
    @Environment(Library.self) private var library
    private var collections: [Collection] {
        ["portraits", "graphics", "video", "web"].compactMap { id in Collection.all.first { $0.id == id } }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(String(localized: "按用途")).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.muted)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                NavigationLink { CollectionsDirectory() } label: {
                    Text(String(localized: "查看全部")).font(.footnote).foregroundStyle(Palette.muted).frame(minHeight: 44)
                }.accessibilityIdentifier("searchAllCollections")
            }
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                ForEach(collections) { collection in
                    NavigationLink { CollectionDetail(collection: collection) } label: { tile(collection) }
                        .buttonStyle(.cardPress).accessibilityIdentifier("searchUse-\(collection.id)")
                }
            }
        }.padding(.horizontal, 20)
    }
    /// The service's browse covers first, then the bundled catalog.
    private func cover(_ collection: Collection) -> ContentPreview? {
        let served = library.feed?.browse.value?.collections.first { $0.id == collection.id }?.covers.map(ContentPreview.init) ?? []
        return (served + collection.previews(in: library)).first { !$0.usesTextArtwork && !library.isRemoved(id: $0.id) }
    }
    private func tile(_ collection: Collection) -> some View {
        ZStack(alignment: .bottomLeading) {
            Palette.soft
            if let cover = cover(collection) {
                Artwork(preview: cover, compact: true, fillsFrame: true, showsVideoBadge: false)
                LinearGradient(colors: [.black.opacity(0), .black.opacity(0.6)], startPoint: .top, endPoint: .bottom)
            }
            Text(collection.title).font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                .lineLimit(2).multilineTextAlignment(.leading).padding(12)
        }.frame(height: 84).clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous)).contentShape(Rectangle())
    }
}
