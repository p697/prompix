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
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    private var entries: [CreatorEntry] {
        if let feed = library.feed { return feed.creators.items.map { CreatorEntry(creator: $0.creator, count: $0.count) } }
        return CreatorDirectory.entries(in: library.prompts)
    }

    var body: some View { content.task { await library.feed?.creators.load("") } }
    @ViewBuilder private var content: some View {
        if !entries.isEmpty && !typeSize.isAccessibilitySize && !voiceOverEnabled {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(String(localized: "创作者")).font(.subheadline.weight(.medium)).accessibilityAddTraits(.isHeader)
                    Spacer()
                    NavigationLink { CreatorsView() } label: {
                        Text(String(localized: "查看全部")).font(.footnote).frame(minHeight: 44)
                    }.foregroundStyle(Palette.muted).accessibilityIdentifier("allCreators")
                }.padding(.horizontal, 16)
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: 12) {
                        ForEach(entries) { entry in
                            NavigationLink { CreatorDetail(creator: entry.creator) } label: {
                                VStack(spacing: 7) {
                                    CreatorAvatar(creator: entry.creator, size: 44)
                                    Text(entry.creator.displayName).font(.caption).lineLimit(1)
                                }.frame(width: 72, alignment: .top).contentShape(Rectangle())
                            }.buttonStyle(.plain).foregroundStyle(Palette.ink)
                                .accessibilityLabel(entry.creator.displayName)
                                .accessibilityValue(String(localized: "\(entry.count) 条内容"))
                                .accessibilityIdentifier("creator-\(entry.id)")
                        }
                    }.padding(.horizontal, 16).padding(.bottom, 4)
                }.accessibilityIdentifier("creatorRail")
            }
        } else {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(String(localized: "创作者")).font(.headline).accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 12)
                    NavigationLink { CreatorsView() } label: {
                        Text(String(localized: "查看全部")).font(.footnote).frame(minHeight: 44)
                    }.accessibilityIdentifier("allCreators")
                }
                if entries.isEmpty {
                    if let store = library.feed?.creators, store.query == nil || store.isLoading {
                        CreatorLoadingRows(count: 1)
                    } else { VStack(alignment: .leading, spacing: 8) {
                        Text(String(localized: "作者信息会随内容更新出现。"))
                            .font(.subheadline).foregroundStyle(Palette.muted)
                            .fixedSize(horizontal: false, vertical: true)
                        CreatorUpdateButton(identifier: "loadCreators")
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
                        .background(Palette.soft, in: RoundedRectangle(cornerRadius: 14))
                    }
                } else {
                    ForEach(Array(entries.prefix(1))) { entry in
                        NavigationLink { CreatorDetail(creator: entry.creator) } label: { CreatorRow(entry: entry) }
                            .buttonStyle(.plain).accessibilityIdentifier("creator-\(entry.id)")
                    }
                }
            }.padding(.horizontal, 20)
        }
    }
}

struct CreatorsView: View {
    @Environment(Library.self) private var library
    @State private var query: String
    init(query: String = "") { _query = State(initialValue: query) }
    private var entries: [CreatorEntry] {
        CreatorDirectory.entries(in: library.prompts).filter { $0.creator.matchesSearch(query) }
    }

    var body: some View {
        ScrollView {
            if let feed = library.feed {
                FeedCreatorResults(repository: feed, query: query)
            } else if entries.isEmpty {
                if !query.isEmpty {
                    ContentUnavailableView.search(text: query)
                } else {
                    ContentUnavailableView {
                        Label(String(localized: "暂无创作者"), systemImage: "person.crop.circle")
                    } description: {
                        Text(String(localized: "作者信息会随内容更新出现。"))
                    } actions: {
                        CreatorUpdateButton(identifier: "loadCreatorsDirectory")
                    }
                }
            } else {
                LazyVStack(spacing: 0) {
                    ForEach(entries) { entry in
                        NavigationLink { CreatorDetail(creator: entry.creator) } label: {
                            CreatorRow(entry: entry).padding(.vertical, 14)
                        }.buttonStyle(.plain).accessibilityIdentifier("creator-\(entry.id)")
                        if entry.id != entries.last?.id { Rectangle().fill(Palette.line).frame(height: 0.5).padding(.leading, 64) }
                    }
                }.padding(.horizontal, 20).padding(.bottom, 24)
            }
        }
        .background(Palette.paper)
        .navigationTitle(String(localized: "创作者"))
        .refreshable { await library.refresh(force: true) }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                    prompt: String(localized: "搜索姓名或账号"))
    }
}

private struct CreatorUpdateButton: View {
    let identifier: String
    @Environment(Library.self) private var library

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(library.isRefreshing ? String(localized: "正在更新…") : String(localized: "检查内容更新")) {
                Task {
                    await library.refresh(force: true)
                    await library.feed?.creators.load("", force: true)
                }
            }
            .buttonStyle(.bordered).controlSize(.regular)
            .disabled(library.isRefreshing).accessibilityIdentifier(identifier)
            if let message = library.syncMessage {
                Text(message).font(.footnote).foregroundStyle(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
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
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(Palette.muted)
                .accessibilityHidden(true)
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
    init(creator: Prompt.Creator) { snapshot = creator }
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
                        OwnedFeedResults(repository: feed, query: FeedQuery(kind: filter == .all ? nil : filter.rawValue, creator: creator.id), fallback: items)
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
                if let count = feed.creators.items.first(where: { $0.id == creator.id })?.count {
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
