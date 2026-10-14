import SwiftUI

/// Owns its navigation history so searches survive switching to another tab.
struct SearchView: View {
    @Environment(Library.self) private var library
    @Binding var query: String
    @Binding var focused: Bool
    @State private var kind: PromptKind?
    @State private var skillsOnly = false
    @State private var recent = UserDefaults.standard.stringArray(forKey: "recentSearches") ?? []

    private var normalizedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var isBrowsing: Bool { normalizedQuery.isEmpty && kind == nil && !skillsOnly }
    private var results: [Prompt] {
        PromptQuery(text: query, kind: kind, skillsOnly: skillsOnly).results(in: library.prompts)
    }
    private var creators: [CreatorEntry] {
        guard !normalizedQuery.isEmpty, kind == nil, !skillsOnly else { return [] }
        return CreatorDirectory.entries(in: library.prompts).filter { $0.creator.matchesSearch(normalizedQuery) }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    KindPicker(selection: $kind, skillsOnly: $skillsOnly)
                    if library.isRefreshing || library.syncMessage != nil {
                        CatalogUpdateStatus().padding(.horizontal, 20)
                    }
                    if isBrowsing {
                        Text(String(localized: "搜索全部已发布内容，联网时自动更新。"))
                            .font(.footnote).foregroundStyle(Palette.muted)
                            .fixedSize(horizontal: false, vertical: true).padding(.horizontal, 20)
                        browseSuggestions
                        CollectionRail()
                        CreatorRail()
                    } else {
                        searchResults
                    }
                }.padding(.bottom, 28)
            }
            .accessibilityIdentifier("searchResults")
            .scrollDismissesKeyboard(.interactively)
            .plainTopEdge().paperScreen()
            .navigationTitle(String(localized: "搜索"))
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, isPresented: $focused, prompt: String(localized: "搜索 Prompt、Skills 或创作者"))
            .autocorrectionDisabled().textInputAutocapitalization(.never)
            .onSubmit(of: .search) { rememberQuery() }
             .refreshable {
                await library.refresh(force: true)
                await library.feed?.search.load(FeedQuery(kind: skillsOnly ? "skill" : kind?.rawValue, q: query), force: true)
            }
            .task { await library.refresh() }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await library.refresh(force: true) }
                    } label: {
                        Label(String(localized: "更新内容"), systemImage: "arrow.clockwise")
                    }.disabled(library.isRefreshing).accessibilityIdentifier("refreshSearchCatalog")
                }
            }
        }
    }

    private var browseSuggestions: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !recent.isEmpty {
                HStack {
                    Text(String(localized: "最近搜索")).font(.subheadline.weight(.medium))
                        .accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button(String(localized: "清除")) {
                        recent = []
                        UserDefaults.standard.removeObject(forKey: "recentSearches")
                    }.font(.footnote).frame(minHeight: 44).accessibilityIdentifier("clearRecentSearches")
                }
                ForEach(recent, id: \.self) { term in
                    searchSuggestion(term, symbol: "clock")
                }
            } else {
                Text(String(localized: "试试这些用途")).font(.subheadline.weight(.medium))
                    .accessibilityAddTraits(.isHeader)
                ForEach(["塔罗", "网站", "电影"], id: \.self) { term in
                    searchSuggestion(NSLocalizedString(term, comment: "Suggested search"), symbol: "magnifyingglass")
                }
            }
        }.padding(.horizontal, 20)
    }

    private func searchSuggestion(_ term: String, symbol: String) -> some View {
        Button {
            query = term
            rememberQuery()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: symbol).font(.footnote).foregroundStyle(Palette.muted)
                Text(term).font(.body)
                Spacer(minLength: 12)
                Image(systemName: "arrow.up.left").font(.footnote).foregroundStyle(Palette.muted)
            }.frame(minHeight: 44).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("searchSuggestion-\(term)")
    }

    @ViewBuilder private var searchResults: some View {
        if let feed = library.feed {
            if kind == nil && !skillsOnly && !normalizedQuery.isEmpty { FeedCreatorSearch(repository: feed, query: normalizedQuery) }
            FeedResults(store: feed.search, query: FeedQuery(kind: skillsOnly ? "skill" : kind?.rawValue, q: query), debounce: true, fallback: results)
        } else { legacyResults }
    }
    @ViewBuilder private var legacyResults: some View {
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
            PromptGrid(items: matchedPrompts).padding(.horizontal, 16)
        }
    }

    private func rememberQuery() {
        guard !normalizedQuery.isEmpty else { return }
        recent = Array(([normalizedQuery] + recent.filter {
            $0.compare(normalizedQuery, options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive]) != .orderedSame
        }).prefix(6))
        UserDefaults.standard.set(recent, forKey: "recentSearches")
    }
}
