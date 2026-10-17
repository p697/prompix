import SwiftUI

struct CreatorAvatar: View {
    let creator: Prompt.Creator
    var size: CGFloat = 48
    @State private var image: UIImage?
    @State private var loadedURL: URL?

    var body: some View {
        ZStack {
            Circle().fill(Palette.soft)
            if let image = (loadedURL == creator.avatarURL ? image : nil) ?? creator.avatarURL.flatMap({ ImageStore.shared.cachedImage(for: $0) }) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Text(initials).font(.system(size: size * 0.34, weight: .medium))
                    .foregroundStyle(Palette.muted)
            }
        }
        .frame(width: size, height: size).clipShape(Circle())
        .accessibilityHidden(true)
        .task(id: creator.avatarURL) {
            if loadedURL != creator.avatarURL { image = nil; loadedURL = nil }
            guard let url = creator.avatarURL else { return }
            do {
                let loaded = try await ImageStore.shared.image(for: url)
                guard !Task.isCancelled else { return }
                image = loaded; loadedURL = url
            } catch {
                // Initials remain useful when an avatar is unavailable or offline.
            }
        }
    }

    private var initials: String {
        let words = creator.displayName.split(whereSeparator: { $0.isWhitespace })
        let letters = words.prefix(2).compactMap(\.first)
        return letters.isEmpty ? "?" : String(letters).uppercased()
    }
}

struct CreatorEntry: Identifiable {
    let creator: Prompt.Creator
    let count: Int
    var preview: FeedCard? = nil
    var id: String { creator.id }
}

enum CreatorDirectory {
    static func entries(in items: [Prompt]) -> [CreatorEntry] {
        struct Group {
            var creators: [Prompt.Creator]
            var count: Int
        }
        var verified: [String: Group] = [:]
        var legacy: [String: Group] = [:]
        for item in items {
            guard let creator = item.creator else { continue }
            if let identity = creator.platformIdentity {
                let key = creator.platform + ":" + identity
                verified[key, default: Group(creators: [], count: 0)].creators.append(creator)
                verified[key]!.count += 1
            } else {
                legacy[creator.identityKey, default: Group(creators: [], count: 0)].creators.append(creator)
                legacy[creator.identityKey]!.count += 1
            }
        }
        let verifiedAnchors = verified
        var unresolved: [Group] = []
        for key in legacy.keys.sorted() {
            let group = legacy[key]!
            let matches = verifiedAnchors.keys.filter { key in
                group.creators.contains { old in verifiedAnchors[key]!.creators.contains { Library.creatorsMatch(old, $0, in: items) } }
            }
            if matches.count == 1 {
                verified[matches[0]]!.creators += group.creators
                verified[matches[0]]!.count += group.count
            } else {
                // A recycled handle cannot bridge two known platform identities.
                // Keep an ambiguous legacy entry independent rather than counting
                // its works once under every account claiming that handle.
                if let index = unresolved.firstIndex(where: { existing in
                    group.creators.contains { old in existing.creators.contains { Library.creatorsMatch(old, $0, in: items) } }
                }) {
                    unresolved[index].creators += group.creators
                    unresolved[index].count += group.count
                } else { unresolved.append(group) }
            }
        }
        return (Array(verified.values) + unresolved).map { group in
            CreatorEntry(creator: group.creators.sorted(by: preferredCreator).first!, count: group.count)
        }
            .sorted { left, right in
                if left.count != right.count { return left.count > right.count }
                let order = left.creator.displayName.localizedStandardCompare(right.creator.displayName)
                if order != .orderedSame { return order == .orderedAscending }
                return left.id < right.id
            }
    }

    static func browse(in items: [Prompt], query: CreatorQuery) -> [CreatorEntry] {
        let matching = items.filter { item in
            query.kind == nil || (query.kind == "skill" ? item.isSkill : !item.isSkill && item.kind.rawValue == query.kind)
        }
        let entries = entries(in: matching).filter { $0.creator.matchesSearch(query.q) }
        let works = Dictionary(uniqueKeysWithValues: entries.map { entry in
            (entry.id, matching.filter { $0.creator.map { Library.creatorsMatch($0, entry.creator, in: items) } ?? false })
        })
        func visual(_ entry: CreatorEntry) -> Int { works[entry.id, default: []].filter { $0.kind != .text && !$0.isSkill }.count }
        func rotation(_ id: String) -> UInt64 {
            (query.day + ":" + id).utf8.reduce(UInt64(14695981039346656037)) { ($0 ^ UInt64($1)) &* 1099511628211 }
        }
        return entries.sorted { left, right in
            switch query.sort {
            case .recommended:
                if (visual(left) > 0) != (visual(right) > 0) { return visual(left) > 0 }
                if rotation(left.id) != rotation(right.id) { return rotation(left.id) < rotation(right.id) }
            case .latest:
                let a = matching.firstIndex { $0.id == works[left.id]?.first?.id } ?? Int.max
                let b = matching.firstIndex { $0.id == works[right.id]?.first?.id } ?? Int.max
                if a != b { return a < b }
            case .count: if left.count != right.count { return left.count > right.count }
            case .name:
                let order = left.creator.displayName.localizedStandardCompare(right.creator.displayName)
                if order != .orderedSame { return order == .orderedAscending }
            }
            return left.id < right.id
        }
    }

    private static func preferredCreator(_ left: Prompt.Creator, _ right: Prompt.Creator) -> Bool {
        if (left.platformIdentity != nil) != (right.platformIdentity != nil) { return left.platformIdentity != nil }
        let leftScore = completeness(left), rightScore = completeness(right)
        if leftScore != rightScore { return leftScore > rightScore }
        // Stable tie-breaking keeps profile choice independent of feed ordering.
        let leftKey = [left.id, left.displayName, left.username ?? "", left.profileURL.absoluteString,
                       left.avatarURL?.absoluteString ?? "", left.bio ?? ""].joined(separator: "\0")
        let rightKey = [right.id, right.displayName, right.username ?? "", right.profileURL.absoluteString,
                        right.avatarURL?.absoluteString ?? "", right.bio ?? ""].joined(separator: "\0")
        return leftKey < rightKey
    }

    private static func completeness(_ creator: Prompt.Creator) -> Int {
        (creator.avatarURL == nil ? 0 : 4) + (creator.bio == nil ? 0 : 2) + (creator.username == nil ? 0 : 1)
    }
}

struct CreatorRail: View {
    @Environment(Library.self) private var library
    @State private var localEntries: [CreatorEntry] = []
    @State private var completedLocalRequest: LocalCreatorRailRequest?
    private var localRequest: LocalCreatorRailRequest? {
        library.feed == nil ? LocalCreatorRailRequest(catalog: library.prompts, query: CreatorQuery()) : nil
    }
    private var entries: [CreatorEntry] {
        if let feed = library.feed { return Array(feed.creatorDiscovery.items.prefix(12)).map { CreatorEntry(creator: $0.creator, count: $0.count, preview: feed.creatorPreview($0)) } }
        return completedLocalRequest == localRequest ? localEntries : []
    }

    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        content.task { await library.feed?.creatorDiscovery.load(CreatorQuery()) }
            .task(id: localRequest) {
                guard let request = localRequest, completedLocalRequest != request else { return }
                let worker = Task.detached(priority: .userInitiated) {
                    Array(CreatorDirectory.browse(in: request.catalog, query: request.query).prefix(12))
                }
                let entries = await withTaskCancellationHandler { await worker.value } onCancel: { worker.cancel() }
                guard !Task.isCancelled else { return }
                localEntries = entries; completedLocalRequest = request
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await library.feed?.creatorDiscovery.load(CreatorQuery()) } }
            }
    }
    private var loading: Bool {
        guard let store = library.feed?.creatorDiscovery else { return completedLocalRequest != localRequest }
        return store.failure == nil && (store.query == nil || store.isLoading)
    }
    private var content: some View {
        let entries = entries
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(String(localized: "创作者")).font(.subheadline.weight(.medium)).accessibilityAddTraits(.isHeader)
                Spacer()
                NavigationLink { CreatorsView() } label: {
                    Text(String(localized: "查看全部")).font(.footnote).frame(minHeight: 44)
                }.foregroundStyle(Palette.muted).accessibilityIdentifier("allCreators")
            }.padding(.horizontal, 16)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 12) {
                    if entries.isEmpty {
                        ForEach(0..<4) { _ in CreatorRailCard(entry: nil) }
                    } else {
                        ForEach(entries) { entry in
                            NavigationLink { CreatorDetail(creator: entry.creator, initialPreview: entry.preview) } label: {
                                CreatorRailCard(entry: entry)
                            }.buttonStyle(.plain).foregroundStyle(Palette.ink)
                                .accessibilityLabel(entry.creator.displayName)
                                .accessibilityValue(String(localized: "\(entry.count) 条内容"))
                                .accessibilityIdentifier("creator-\(entry.id)")
                        }
                    }
                }.padding(.horizontal, 16).padding(.bottom, 4)
            }
            .scrollDisabled(entries.isEmpty)
            .accessibilityIdentifier("creatorRail")
            .overlay {
                if entries.isEmpty && !loading {
                    ContentRecoveryRow(retryAt: library.feed?.creatorDiscovery.retryAt, retryID: "loadCreators") {
                        Task { await library.feed?.creatorDiscovery.load(CreatorQuery(), force: true) }
                    }.padding(.horizontal, 16).frame(maxWidth: .infinity, maxHeight: .infinity).background(Palette.paper)
                }
            }
        }
    }
}

private struct LocalCreatorRailRequest: Equatable {
    let catalog: [Prompt]
    let query: CreatorQuery
}

/// Loading, image, and avatar-only states have identical geometry, including
/// scaled typography. A missing preview must never shorten the entire rail.
private struct CreatorRailCard: View {
    let entry: CreatorEntry?
    @ScaledMetric(relativeTo: .caption) private var width = 104.0
    @ScaledMetric(relativeTo: .caption) private var nameHeight = 18.0
    var body: some View {
        VStack(spacing: 7) {
            Group {
                if let entry {
                    if let preview = entry.preview { CreatorWorkPreview(card: preview) }
                    else { Palette.soft.overlay { CreatorAvatar(creator: entry.creator, size: 44) } }
                } else { LoadingSurface() }
            }.frame(width: width, height: 80).clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(alignment: .bottomLeading) {
                    if let entry, entry.preview != nil {
                        CreatorAvatar(creator: entry.creator, size: 28)
                            .overlay(Circle().stroke(Palette.paper, lineWidth: 2)).padding(5)
                    }
                }
            Text(entry?.creator.displayName ?? "Creator name").font(.caption).lineLimit(1)
                .frame(maxWidth: .infinity).frame(height: nameHeight)
                .redacted(reason: entry == nil ? .placeholder : [])
        }.frame(width: width, alignment: .top).contentShape(Rectangle())
            .accessibilityHidden(entry == nil)
    }
}

struct CreatorsView: View {
    @Environment(Library.self) private var library
    @State private var query: String
    @State private var filter = CreatorContentFilter.all
    @State private var sort = CreatorSort.recommended
    init(query: String = "") { _query = State(initialValue: query) }
    private var selection: CreatorQuery { CreatorQuery(q: query, kind: filter == .all ? nil : filter.rawValue, sort: sort) }
    private var entries: [CreatorEntry] {
        CreatorDirectory.browse(in: library.prompts, query: selection)
    }
    var body: some View {
        VStack(spacing: 0) {
            ViewThatFits(in: .horizontal) {
                HStack { typePicker; Spacer(minLength: 12); sortPicker }
                VStack(alignment: .leading) { typePicker; sortPicker }
            }.padding(.horizontal, 20).padding(.vertical, 8)
            if let feed = library.feed {
                FeedCreatorResults(repository: feed, query: selection)
            } else {
                ScrollView {
                    if entries.isEmpty {
                        ContentUnavailableView(String(localized: "暂无匹配内容"), systemImage: "person.crop.circle",
                            description: Text(String(localized: "试试其他分类，或清除筛选条件。")))
                    } else {
                        LazyVStack(spacing: 0) {
                            ForEach(entries) { entry in
                                NavigationLink { CreatorDetail(creator: entry.creator, initialKind: selection.kind, initialPreview: entry.preview) } label: {
                                    CreatorRow(entry: entry).padding(.vertical, 14)
                                }.buttonStyle(.plain).accessibilityIdentifier("creator-\(entry.id)")
                            }
                        }.padding(.horizontal, 20).padding(.bottom, 24)
                    }
                }.pageRefreshable { await library.refresh(force: true) }
            }
        }
        .background(Palette.paper)
        .navigationTitle(String(localized: "创作者"))
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                    prompt: String(localized: "搜索姓名或账号"))
    }
    private var typePicker: some View {
        Menu {
            Picker(String(localized: "内容类型"), selection: $filter) {
                ForEach(CreatorContentFilter.allCases) { Text($0.title).tag($0) }
            }
        } label: { Label(filter.title, systemImage: "line.3.horizontal.decrease").frame(minHeight: 44) }
            .accessibilityLabel(String(localized: "内容类型"))
            .accessibilityValue(filter.title).accessibilityIdentifier("creatorDirectoryFilter")
    }
    private var sortPicker: some View {
        Menu {
            Picker(String(localized: "排序"), selection: $sort) {
                ForEach(CreatorSort.allCases) { Text($0.title).tag($0) }
            }
        } label: { Label(sort.title, systemImage: "arrow.up.arrow.down").frame(minHeight: 44) }
            .accessibilityLabel(String(localized: "排序"))
            .accessibilityValue(sort.title).accessibilityIdentifier("creatorDirectorySort")
    }
}

private struct CreatorWorkPreview: View {
    let card: FeedCard
    var body: some View {
        Artwork(preview: ContentPreview(card), compact: true, fillsFrame: true, showsVideoBadge: false)
            .overlay(alignment: .topTrailing) {
                if card.kind == .video || card.kind == .web {
                    Image(systemName: card.kind == .video ? "play.fill" : "globe")
                        .font(.system(size: 10, weight: .semibold)).foregroundStyle(.white)
                        .padding(5).background(.black.opacity(0.45), in: Circle()).padding(5)
                }
            }.accessibilityHidden(true)
    }
}

struct CreatorRow: View {
    let entry: CreatorEntry
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Group {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 10) {
                    CreatorAvatar(creator: entry.creator, size: 40)
                    Text(entry.creator.displayName).font(.body).foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(CreatorIdentity.subtitle(entry.creator)).font(.caption).foregroundStyle(Palette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    if entry.count >= 0 { Text(String(localized: "\(entry.count) 条内容")).font(.caption).foregroundStyle(Palette.muted) }
                }
            } else { standardRow }
        }.frame(maxWidth: .infinity, minHeight: 64, alignment: .leading).contentShape(Rectangle())
            .accessibilityElement(children: .combine)
    }

    private var standardRow: some View {
        HStack(alignment: .center, spacing: 14) {
            CreatorAvatar(creator: entry.creator, size: 50)
            VStack(alignment: .leading, spacing: 5) {
                Text(entry.creator.displayName).font(.body).foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text(CreatorIdentity.subtitle(entry.creator)).font(.footnote).foregroundStyle(Palette.muted)
                    .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                if entry.count >= 0 { Text(String(localized: "\(entry.count) 条内容")).font(.footnote).foregroundStyle(Palette.muted) }
            }
            Spacer(minLength: 0)
            if let preview = entry.preview {
                CreatorWorkPreview(card: preview)
                    .frame(width: 82, height: 70).clipShape(RoundedRectangle(cornerRadius: 10))
            } else {
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Palette.muted).accessibilityHidden(true)
            }
        }
    }
}

struct CreatorByline: View {
    let creator: Prompt.Creator

    var body: some View {
        NavigationLink { CreatorDetail(creator: creator) } label: {
            HStack(spacing: 10) {
                CreatorAvatar(creator: creator, size: 32)
                VStack(alignment: .leading, spacing: 3) {
                    Text(creator.displayName).font(.subheadline.weight(.medium)).foregroundStyle(.primary)
                    Text(CreatorIdentity.subtitle(creator)).font(.caption).foregroundStyle(Palette.muted)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Palette.muted)
                    .accessibilityHidden(true)
            }.frame(minHeight: 44).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("creatorByline")
    }
}

struct CreatorDetail: View {
    private let snapshot: Prompt.Creator
    private let initialPreview: FeedCard?
    init(creator: Prompt.Creator, initialKind: String? = nil, initialPreview: FeedCard? = nil) {
        snapshot = creator; self.initialPreview = initialPreview
        _filter = State(initialValue: initialKind.flatMap(CreatorContentFilter.init(rawValue:)) ?? .all)
    }
    @Environment(Library.self) private var library
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var filter = CreatorContentFilter.all
    @State private var bioExpanded = false
    @State private var savedFeedback = false
    private var creator: Prompt.Creator { library.currentCreator(snapshot) }
    private var allItems: [Prompt] { library.items(for: creator) }
    private var items: [Prompt] { allItems.filter(filter.includes) }
    private var availableFilters: [CreatorContentFilter] {
        library.feed == nil ? CreatorContentFilter.allCases.filter { $0 == .all || allItems.contains(where: $0.includes) } : CreatorContentFilter.allCases
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 20) {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .center, spacing: 16) {
                            CreatorAvatar(creator: creator, size: 64)
                            identity
                        }
                        LazyVStack(alignment: .leading, spacing: 14) {
                            CreatorAvatar(creator: creator, size: 64)
                            identity
                        }
                    }
                    if let bio = creator.bio?.trimmingCharacters(in: .whitespacesAndNewlines), !bio.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(bio).font(.subheadline).lineSpacing(4).foregroundStyle(Palette.muted)
                                .lineLimit(bioExpanded || typeSize.isAccessibilitySize ? nil : 3)
                                .fixedSize(horizontal: false, vertical: true)
                            if bio.count > 100 && !typeSize.isAccessibilitySize {
                                Button(bioExpanded ? String(localized: "收起简介") : String(localized: "展开简介")) {
                                    bioExpanded.toggle()
                                }.font(.footnote).frame(minHeight: 44)
                            }
                        }
                    }
                    Link(destination: creator.profileURL) {
                        Label(String(localized: "查看 \(creator.platformName) 主页"), systemImage: "arrow.up.right")
                            .font(.subheadline).frame(minHeight: 28)
                    }.buttonStyle(.bordered).controlSize(.regular)
                        .accessibilityIdentifier("creatorExternalProfile")
                }.padding(.horizontal, 20).padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .leading, spacing: 14) {
                    ViewThatFits(in: .horizontal) {
                        HStack { contentHeading; Spacer(); filterPicker }
                        VStack(alignment: .leading, spacing: 8) { contentHeading; filterPicker }
                    }.padding(.horizontal, 20)
                    if let feed = library.feed {
                        OwnedFeedResults(repository: feed, query: FeedQuery(kind: filter == .all ? nil : filter.rawValue, creator: creator.id, sort: "recommended"), fallback: items, initialPreviews: [initialPreview].compactMap { $0 })
                    } else if items.isEmpty {
                        ContentUnavailableView(String(localized: "暂无匹配内容"), systemImage: "square.grid.2x2",
                            description: Text(String(localized: "试试其他分类，或清除筛选条件。")))
                    } else {
                        PromptGrid(items: items).padding(.horizontal, 16)
                    }
                }
            }.padding(.top, 12).padding(.bottom, 28)
        }
        .background(Palette.paper)
        .accessibilityIdentifier("creatorProfileScroll")
        .navigationTitle(creator.displayName).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    if library.toggleCreator(creator) { savedFeedback.toggle() }
                } label: {
                    Label(library.isCreatorSaved(creator) ? String(localized: "取消收藏创作者") : String(localized: "收藏创作者"), systemImage: library.isCreatorSaved(creator) ? "bookmark.fill" : "bookmark")
                        .frame(minWidth: 44, minHeight: 44)
                }.accessibilityLabel(library.isCreatorSaved(creator) ? String(localized: "取消收藏创作者") : String(localized: "收藏创作者"))
                    .accessibilityIdentifier("saveCreator").sensoryFeedback(.selection, trigger: savedFeedback)
            }
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: creator.profileURL) {
                    Label(String(localized: "分享"), systemImage: "square.and.arrow.up")
                }.accessibilityIdentifier("shareCreator")
            }
        }
        .onChange(of: availableFilters) { _, values in
            if !values.contains(filter) { filter = .all }
        }
    }

    private var identity: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(creator.displayName).font(Typography.editorial(.title)).fixedSize(horizontal: false, vertical: true)
            Text(CreatorIdentity.subtitle(creator)).font(.subheadline).foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
            if let feed = library.feed {
                if let count = (feed.creatorDiscovery.items + feed.creators.items).first(where: { $0.id == creator.id })?.count {
                    Text(String(localized: "\(count) 条内容")).font(.footnote).foregroundStyle(Palette.muted)
                }
            } else { Text(String(localized: "\(allItems.count) 条内容")).font(.footnote).foregroundStyle(Palette.muted) }
        }
    }

    private var contentHeading: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(filter == .all ? String(localized: "全部内容") : filter.title)
                .font(Typography.editorial(.title3)).accessibilityAddTraits(.isHeader)
            if filter != .all && library.feed == nil {
                Text(String(localized: "\(items.count) 条内容")).font(.footnote).foregroundStyle(Palette.muted)
            }
        }
    }

    private var filterPicker: some View {
        Picker(String(localized: "内容类型"), selection: $filter) {
            ForEach(availableFilters) { value in Text(value.title).tag(value) }
        }.pickerStyle(.menu).accessibilityIdentifier("creatorContentFilter")
    }
}

struct SavedCreators: View {
    let query: String
    @Environment(Library.self) private var library
    private var creators: [Prompt.Creator] {
        var seen = Set<String>()
        return library.savedCreators.map(library.currentCreator).filter { seen.insert($0.identityKey).inserted }.filter {
            $0.matchesSearch(query)
        }
    }
    var body: some View {
        if !library.savedCreatorsReadable {
            ContentUnavailableView {
                Label(String(localized: "收藏暂时无法读取"), systemImage: "bookmark.slash")
            } description: { Text(String(localized: "原文件和离线预览已保留，暂时不会覆盖你的收藏。")) }
            actions: { Button(String(localized: "重新读取收藏")) { library.reloadSavedCreators() }.buttonStyle(.bordered) }
        } else if creators.isEmpty {
            if query.isEmpty {
                ContentUnavailableView(String(localized: "暂无收藏的创作者"), systemImage: "person.crop.circle",
                    description: Text(String(localized: "在创作者主页轻点书签，方便下次找到。收藏保存在本机。")))
            } else { ContentUnavailableView.search(text: query) }
        } else {
            LazyVStack(spacing: 20) {
                ForEach(creators) { creator in
                    NavigationLink { CreatorDetail(creator: creator) } label: {
                        CreatorRow(entry: CreatorEntry(creator: creator, count: library.feed.map { $0.creators.items.first { $0.id == creator.id }?.count ?? -1 } ?? library.items(for: creator).count))
                    }.buttonStyle(.plain).accessibilityIdentifier("saved-creator-\(creator.id)")
                }
            }.padding(.horizontal, 20)
        }
    }
}

private enum CreatorIdentity {
    static func subtitle(_ creator: Prompt.Creator) -> String {
        guard let username = creator.username, !username.isEmpty else { return creator.platformName }
        let handle = username.hasPrefix("@") ? username : "@\(username)"
        return "\(handle) · \(creator.platformName)"
    }
}

private enum CreatorContentFilter: String, CaseIterable, Identifiable {
    case all, text, image, video, web, skill
    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: String(localized: "全部")
        case .text: PromptKind.text.title
        case .image: PromptKind.image.title
        case .video: PromptKind.video.title
        case .web: PromptKind.web.title
        case .skill: "Skill"
        }
    }
    func includes(_ item: Prompt) -> Bool {
        switch self {
        case .all: true
        case .skill: item.isSkill
        default: !item.isSkill && item.kind.rawValue == rawValue
        }
    }
}
