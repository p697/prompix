import Foundation
import Observation

enum PromptDetailOrigin { case catalog, favorite }

enum CatalogSyncState: Equatable, Sendable {
    case idle, checking, downloading(receivedBytes: Int, totalBytes: Int?), installing, current, failed

    var fractionCompleted: Double? {
        guard case let .downloading(received, total) = self, let total, total > 0 else { return nil }
        return min(1, max(0, Double(received) / Double(total)))
    }
}

/// One of the reader's own versions of a work's prompt.
struct PromptVersion: Identifiable, Hashable {
    let id: String
    let text: String
    let created: Date?
    /// The reader's name for it; unnamed versions are numbered by age.
    var name: String? = nil
    static func title(of version: PromptVersion, in versions: [PromptVersion]) -> String {
        version.name ?? String(localized: "我的 \((versions.firstIndex(of: version) ?? 0) + 1)")
    }
}

@MainActor @Observable final class Library {
    private(set) var prompts: [Prompt] = []
    private(set) var favorites: [Prompt] = []
    private(set) var savedCreators: [Prompt.Creator] = []
    private(set) var savedCreatorsReadable = true
    private(set) var error: String?
    private(set) var version = ""
    private(set) var isRefreshing = false
    private(set) var syncState = CatalogSyncState.idle
    private(set) var syncMessage: String?
    private(set) var updatedAt: Date?
    private(set) var drafts: [String: String] = [:]
    private var draftsReadable = true
    private(set) var favoritesReadable = true
    private var removedIDs = Set<String>()
    private var creatorAliases: [String: Prompt.Creator] = [:]
    private var lastAttempt: Date?
    private var refreshID: UUID?
    private var refreshTask: Task<Bool, Never>?
    private var refreshingLanguage = false
    private var lastAttemptLanguage: String?
    private var languagePackIndex: LanguagePackCache.Index?
    private var languagePackBase: LanguagePackCatalog.Base?
    private(set) var feed: FeedRepository?
    private var databaseFeedRequested = false
    private let feedService: (any FeedServing)?
    let recommendations: LocalRecommendations
    let decks: DeckStore
    private let directory: URL
    private let installFileWriter: (Data, URL) throws -> Void
    private var storageRecoveryPending = false
    private var languageCache: LanguagePackCache { LanguagePackCache(directory: directory) }
    var savedIDs: Set<String> { Set(favorites.map(\.id)) }
    /// Works with a saved draft in any language.
    var draftedIDs: Set<String> { Set(drafts.keys.map { String($0.components(separatedBy: "::")[0]) }) }
    private static let snapshotKey = "work"
    /// A version's name sits beside it as `<version id>::name`.
    private static let nameKey = "name"
    /// The works the reader has written versions of, from the copy kept beside them.
    var versionedWorks: [Prompt] {
        drafts.compactMap { key, value -> Prompt? in
            guard key.hasSuffix("::" + Self.snapshotKey) else { return nil }
            return try? JSONDecoder().decode(Prompt.self, from: Data(value.utf8))
        }
    }
    var savedImageURLs: Set<URL>? {
        guard favoritesReadable, savedCreatorsReadable, !storageRecoveryPending else { return nil }
        return Set(favorites.compactMap { $0.media?.imageURL } + favorites.compactMap { $0.creator?.avatarURL } + savedCreators.compactMap(\.avatarURL))
    }

    init(directory: URL? = nil, catalogURL: URL? = Bundle.main.url(forResource: "catalog", withExtension: "json"),
         feedService: (any FeedServing)? = nil,
         installFileWriter: @escaping (Data, URL) throws -> Void = { try $0.write(to: $1, options: .atomic) }) {
        self.directory = directory ?? URL.applicationSupportDirectory.appending(path: "Prompix", directoryHint: .isDirectory)
        self.recommendations = LocalRecommendations(directory: self.directory)
        self.decks = DeckStore(directory: self.directory)
        self.installFileWriter = installFileWriter
        databaseFeedRequested = feedService != nil
        self.feedService = feedService
        var checkpoint = FeedCheckpoint()
        do {
            try FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
            try Self.recoverCatalogTransaction(in: self.directory)
            let checkpointURL = self.directory.appending(path: FeedCheckpoint.fileName)
            if FileManager.default.fileExists(atPath: checkpointURL.path) {
                let attributes = try checkpointURL.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
                guard attributes.isRegularFile == true, attributes.isSymbolicLink != true,
                      (attributes.fileSize ?? Int.max) <= 40_000_000 else { throw FeedError.invalidResponse }
                checkpoint = try JSONDecoder().decode(FeedCheckpoint.self, from: Data(contentsOf: checkpointURL)).validated()
                removedIDs = Set(checkpoint.removedIDs)
            }
        } catch {
            storageRecoveryPending = true
            favoritesReadable = false; savedCreatorsReadable = false; draftsReadable = false
            self.error = String(localized: "收藏暂时无法读取。原文件已保留，请稍后重试。")
            return
        }
        do {
            let savedURL = self.directory.appending(path: "favorites.json")
            if FileManager.default.fileExists(atPath: savedURL.path) {
                favorites = try JSONDecoder().decode([Prompt].self, from: Data(contentsOf: savedURL))
            }
        } catch { favoritesReadable = false; self.error = String(localized: "收藏暂时无法读取。原文件已保留，请稍后重试。") }
        do {
            if FileManager.default.fileExists(atPath: creatorsFile.path) {
                savedCreators = try JSONDecoder().decode([Prompt.Creator].self, from: Data(contentsOf: creatorsFile))
            }
        } catch { savedCreatorsReadable = false; self.error = String(localized: "收藏暂时无法读取。原文件已保留，请稍后重试。") }
        do {
            if FileManager.default.fileExists(atPath: draftFile.path) {
                drafts = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: draftFile))
            }
        } catch {
            draftsReadable = false
            self.error = String(localized: "编辑草稿暂时无法读取。原文件已保留，暂不覆盖已有修改。")
        }
        do {
            guard let catalogURL else { throw CocoaError(.fileNoSuchFile) }
            let cachedURL = self.directory.appending(path: "catalog.json")
            let offlineFixture = ProcessInfo.processInfo.arguments.contains("--offline")
            let cached = offlineFixture ? nil : try? JSONDecoder().decode(Catalog.self, from: Data(contentsOf: cachedURL)).validated()
            let indexExists = !offlineFixture && FileManager.default.fileExists(atPath: self.directory.appending(path: LanguagePackCache.indexFileName).path)
            var catalog: Catalog?
            if indexExists {
                // Recover the transaction before consulting this pointer. A damaged
                // pack may use this same edition's projection, never an older bundle.
                if let index = try? languageCache.readIndex() {
                    languagePackIndex = index
                    let requested = Set([ContentLanguage.preferred].filter { index.downloadedLocales[$0] != nil })
                    if let edition = languageCache.load(index, locales: requested) {
                        catalog = edition.catalog; languagePackBase = edition.base
                    } else if let originals = languageCache.load(index, locales: []) {
                        languagePackBase = originals.base
                        catalog = cached?.version == index.manifest.version ? cached : originals.catalog
                    }
                    if catalog == nil, cached?.version == index.manifest.version { catalog = cached }
                } else { catalog = cached }
                guard catalog != nil else { throw CocoaError(.fileReadCorruptFile) }
            } else {
                catalog = try cached ?? JSONDecoder().decode(Catalog.self, from: Data(contentsOf: catalogURL)).validated()
            }
            let loadedCatalog = catalog!
            // Resolve legacy creator identities before replacing saved snapshots.
            let aliases = Self.creatorAliases(from: favorites, to: loadedCatalog.prompts)
            try applyCatalog(loadedCatalog, data: nil, aliases: aliases, availability: languagePackBase?.availableLanguages)
        } catch { self.error = String(localized: "灵感暂时没有加载成功。你仍然可以查看已保存的收藏。") }
        if feedService != nil {
            checkpoint.removedIDs = removedIDs.sorted()
            feed = makeFeed(checkpoint: checkpoint)
        }
    }

    private func makeFeed(checkpoint: FeedCheckpoint) -> FeedRepository? {
        guard let feedService else { return nil }
        let suggestive = recommendations.showsSuggestive
        let cache = FeedCache(directory: directory.appending(path: suggestive ? "feed-cache-suggestive" : "feed-cache"))
        return FeedRepository(service: feedService.presenting(suggestive: suggestive), cache: cache,
                              checkpoint: checkpoint, recommendations: recommendations) { [weak self] value in
            guard let self else { throw CancellationError() }
            try self.commitFeedRemovals(value)
        }
    }

    /// Suggestive works are a separate audience on the service, so lists, cursors
    /// and their cache are rebuilt for it rather than filtered in place.
    func setShowsSuggestive(_ value: Bool) async {
        guard value != recommendations.showsSuggestive, recommendations.setShowsSuggestive(value) else { return }
        guard let previous = feed, let next = makeFeed(checkpoint: previous.checkpoint) else { return }
        feed = next
        if let query = previous.discovery.query { await next.discovery.load(query, force: true) }
        if let query = previous.search.query { await next.search.load(query, force: true) }
        if previous.browse.value != nil || previous.browse.failure != nil { await next.browse.load(force: true) }
        if let query = previous.creatorDiscovery.query { await next.creatorDiscovery.load(query, force: true) }
        if let query = previous.creators.query { await next.creators.load(query, force: true) }
    }

    private static func parseDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    private var savedFile: URL { directory.appending(path: "favorites.json") }
    private var draftFile: URL { directory.appending(path: "drafts.json") }
    private var creatorsFile: URL { directory.appending(path: "creators.json") }
    func isRemoved(_ item: Prompt) -> Bool { isRemoved(id: item.id) }
    func isRemoved(id: String) -> Bool { removedIDs.contains(id) || feed?.removedIDs.contains(id) == true }
    func resolvedDetail(_ snapshot: Prompt, origin: PromptDetailOrigin) -> Prompt {
        if let feed { return feed.resolved(snapshot) }
        switch origin {
        case .catalog: return prompts.first { $0.id == snapshot.id } ?? snapshot
        case .favorite:
            return favorites.first {
                $0.id == snapshot.id && LanguagePackCatalog.sourceFingerprint($0) == LanguagePackCatalog.sourceFingerprint(snapshot)
            } ?? Self.enrichedFavorites([snapshot], from: prompts, availability: languagePackBase?.availableLanguages)[0]
        }
    }
    func advertisedLanguages(for snapshot: Prompt) -> [String] {
        guard !isRemoved(snapshot) else { return [] }
        if let feed { return feed.availableLanguages(for: snapshot) }
        if let base = languagePackBase, let current = base.catalog.prompts.first(where: { $0.id == snapshot.id }),
           LanguagePackCatalog.sourceFingerprint(current) == LanguagePackCatalog.sourceFingerprint(snapshot) {
            return base.availableLanguages[snapshot.id] ?? []
        }
        return snapshot.availableLanguages
    }
    func cancelLanguageRequest() {
        guard refreshingLanguage else { return }
        cancelRefresh()
    }
    private func cancelRefresh() {
        refreshTask?.cancel(); refreshTask = nil; refreshID = nil
        isRefreshing = false; refreshingLanguage = false; lastAttempt = nil
        syncState = .idle; syncMessage = nil
    }
    func currentCreator(_ creator: Prompt.Creator) -> Prompt.Creator {
        Self.resolveCreator(creator, in: prompts, aliases: creatorAliases)
    }
    func items(for creator: Prompt.Creator) -> [Prompt] {
        let current = currentCreator(creator)
        return prompts.filter { item in
            item.creator.map { Self.creatorsMatch($0, current, in: prompts) } ?? false
        }
    }
    func isCreatorSaved(_ creator: Prompt.Creator) -> Bool {
        let current = currentCreator(creator)
        return savedCreators.contains { Self.creatorsMatch(currentCreator($0), current, in: prompts) }
    }

    /// A handle is a usable fallback only when the current catalog does not
    /// associate it with multiple verified accounts. An unresolved bookmark
    /// remains its own identity instead of silently selecting both accounts.
    nonisolated static func creatorsMatch(_ first: Prompt.Creator, _ second: Prompt.Creator, in catalog: [Prompt]) -> Bool {
        guard first.matchesIdentity(of: second) else { return false }
        if first.platformIdentity != nil && second.platformIdentity != nil { return true }
        if first.identityKey == second.identityKey { return true }
        let unverified = first.platformIdentity == nil ? first : second
        let identities = Set(catalog.compactMap(\.creator).filter { $0.matchesIdentity(of: unverified) }.compactMap(\.platformIdentity))
        return identities.count <= 1
    }
    @discardableResult func toggleCreator(_ creator: Prompt.Creator) -> Bool {
        guard savedCreatorsReadable, !storageRecoveryPending else {
            error = String(localized: "已有收藏暂时无法读取。为保留原文件，本次修改未保存。")
            return false
        }
        let current = currentCreator(creator)
        var updated = savedCreators
        if isCreatorSaved(current) { updated.removeAll { Self.creatorsMatch(currentCreator($0), current, in: prompts) } }
        else { updated.insert(current, at: 0) }
        do {
            try JSONEncoder().encode(updated).write(to: creatorsFile, options: .atomic)
            savedCreators = updated
            return true
        } catch { self.error = String(localized: "未能保存收藏，请检查设备存储空间后重试。"); return false }
    }
    func reloadSavedCreators() {
        guard !storageRecoveryPending else { return }
        guard !savedCreatorsReadable else { return }
        do {
            let recovered = try JSONDecoder().decode([Prompt.Creator].self, from: Data(contentsOf: creatorsFile))
            let reconciled = Self.reconciledCreators(recovered, in: prompts, aliases: creatorAliases)
            if reconciled != recovered { try JSONEncoder().encode(reconciled).write(to: creatorsFile, options: .atomic) }
            savedCreators = reconciled
            savedCreatorsReadable = true; error = nil
        } catch { self.error = String(localized: "收藏仍然无法读取，原文件与离线预览已保留。") }
    }
    private func draftID(for item: Prompt, language: String?) -> String {
        language.map { item.id + "::" + ContentLanguage.canonical($0) } ?? item.id
    }
    /// The reader's own versions of a work, oldest first. Each lives in the drafts
    /// file under `<item id>::v<milliseconds>`, so removals reconcile them as before;
    /// a draft saved before versions existed appears as the oldest one.
    func versions(of item: Prompt) -> [PromptVersion] {
        drafts.compactMap { key, text -> PromptVersion? in
            let parts = key.components(separatedBy: "::")
            guard parts[0] == item.id, parts.count <= 2, parts.count < 2 || parts[1] != Self.snapshotKey else { return nil }
            let stamp = parts.count > 1 && parts[1].hasPrefix("v") ? Double(parts[1].dropFirst()) : nil
            return PromptVersion(id: key, text: text, created: stamp.map { Date(timeIntervalSince1970: $0 / 1000) },
                                 name: drafts[key + "::" + Self.nameKey])
        }.sorted { ($0.created ?? .distantPast) < ($1.created ?? .distantPast) }
    }
    /// Names a version; an empty name returns it to its number.
    @discardableResult func renameVersion(_ id: String, to name: String) -> Bool {
        guard draftsReadable, !storageRecoveryPending, drafts[id] != nil else { return false }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        var updated = drafts
        updated[id + "::" + Self.nameKey] = trimmed.isEmpty ? nil : String(trimmed.prefix(40))
        guard updated != drafts else { return true }
        do {
            try JSONEncoder().encode(updated).write(to: draftFile, options: .atomic)
            drafts = updated
            return true
        } catch {
            self.error = String(localized: "草稿未能保存，请检查设备存储空间。你仍可以复制本次修改。")
            return false
        }
    }
    /// Saves into an existing version, or starts a new one when `id` is nil.
    /// Returns the version's id, or nil when nothing could be saved.
    @discardableResult func saveVersion(_ text: String, id: String?, for item: Prompt, now: Date = Date()) -> String? {
        guard !isRemoved(item) else {
            error = String(localized: "这条内容已被移除，无法再保存。你仍可复制当前文字。")
            return nil
        }
        guard draftsReadable, !storageRecoveryPending else {
            error = String(localized: "已有草稿暂时无法读取，修改未保存。你可以先复制内容。")
            return nil
        }
        let key = id ?? item.id + "::v" + String(Int64(now.timeIntervalSince1970 * 1000))
        guard key.components(separatedBy: "::")[0] == item.id else { return nil }
        var updated = drafts
        updated[key] = text
        // Keep the work beside its versions, so 我的版本 can list it without a catalog or saved copy.
        let snapshot = item.id + "::" + Self.snapshotKey
        if updated[snapshot] == nil, let data = try? JSONEncoder().encode(item) { updated[snapshot] = String(decoding: data, as: UTF8.self) }
        guard updated != drafts else { return key }
        do {
            try JSONEncoder().encode(updated).write(to: draftFile, options: .atomic)
            drafts = updated
            return key
        } catch {
            self.error = String(localized: "草稿未能保存，请检查设备存储空间。你仍可以复制本次修改。")
            return nil
        }
    }
    @discardableResult func deleteVersion(_ id: String) -> Bool {
        guard draftsReadable, !storageRecoveryPending, drafts[id] != nil else { return false }
        var updated = drafts
        updated[id] = nil
        updated[id + "::" + Self.nameKey] = nil
        let itemID = id.components(separatedBy: "::")[0], snapshot = itemID + "::" + Self.snapshotKey
        if !updated.keys.contains(where: {
            let parts = $0.components(separatedBy: "::")
            return $0 != snapshot && parts.count <= 2 && parts[0] == itemID
        }) { updated[snapshot] = nil }
        do {
            try JSONEncoder().encode(updated).write(to: draftFile, options: .atomic)
            drafts = updated
            return true
        } catch {
            self.error = String(localized: "草稿未能保存，请检查设备存储空间。你仍可以复制本次修改。")
            return false
        }
    }
    func draft(for item: Prompt, language: String? = nil) -> String {
        drafts[draftID(for: item, language: language)] ?? item.content(in: language).prompt
    }
    @discardableResult func saveDraft(_ text: String, for item: Prompt, language: String? = nil) -> Bool {
        guard !isRemoved(item) else {
            error = String(localized: "这条内容已被移除，无法再保存。你仍可复制当前文字。")
            return false
        }
        guard draftsReadable, !storageRecoveryPending else {
            error = String(localized: "已有草稿暂时无法读取，修改未保存。你可以先复制内容。")
            return false
        }
        var updated = drafts
        updated[draftID(for: item, language: language)] = text == item.content(in: language).prompt ? nil : text
        guard updated != drafts else { return true }
        do {
            try JSONEncoder().encode(updated).write(to: draftFile, options: .atomic)
            drafts = updated
            return true
        } catch {
            self.error = String(localized: "草稿未能保存，请检查设备存储空间。你仍可以复制本次修改。")
            return false
        }
    }
    func refresh(force: Bool = false, session: URLSession = .shared, now: Date = Date()) async {
        #if targetEnvironment(simulator)
        // A staged, validated catalog can be exercised without replacing it
        // with the public edition while a release is being prepared.
        if ProcessInfo.processInfo.arguments.contains("--cached-only") { return }
        #endif
        guard !Task.isCancelled, !isRefreshing, !ProcessInfo.processInfo.arguments.contains("--offline"), !storageRecoveryPending else { return }
        if databaseFeedRequested {
            guard let feed else { return }
            let interval: TimeInterval = syncState == .failed ? 30 : 300
            if !force, let lastAttempt, now.timeIntervalSince(lastAttempt) < interval { return }
            isRefreshing = true; syncState = .checking; syncMessage = nil; lastAttempt = now
            defer { isRefreshing = false }
            do {
                let previousRelease = feed.state?.release
                try await feed.refresh()
                try Task.checkCancellation()
                version = feed.state?.release ?? version
                updatedAt = feed.state?.publishedAt.flatMap(Self.parseDate)
                syncState = .current
                // Revalidate the visible first page after a new publication. An
                // already paged session keeps its snapshot until pull-to-refresh.
                if !force, let query = feed.discovery.query, !feed.discovery.isLoading,
                   !feed.discovery.hasLoadedAdditionalPages, feed.discovery.release != feed.state?.release {
                    await feed.discovery.load(query, force: true)
                }
                let releaseChanged = previousRelease != nil && previousRelease != feed.state?.release
                if force || releaseChanged {
                    if feed.browse.value != nil || feed.browse.failure != nil { await feed.browse.load(force: true) }
                    if feed.creatorDiscovery.query != nil { await feed.creatorDiscovery.load(CreatorQuery(), force: true) }
                    if feed.creators.query != nil { await feed.creators.load("", force: true) }
                }
            } catch is CancellationError { lastAttempt = nil; syncState = .idle }
            catch {
                if (error as? URLError)?.code == .cancelled { lastAttempt = nil; syncState = .idle }
                else { syncState = .failed; syncMessage = String(localized: "内容更新未完成") }
            }
            return
        }
        // A failed first refresh must not strand an upgraded installation on its
        // previous edition for fifteen minutes. Successful checks retain the
        // longer interval; explicit retry always bypasses either interval.
        let retryInterval: TimeInterval = syncState == .failed ? 30 : 900
        if !force, lastAttemptLanguage == ContentLanguage.preferred,
           let lastAttempt, now.timeIntervalSince(lastAttempt) < retryInterval { return }
        _ = await startRefresh(requestedLocales: [ContentLanguage.preferred], target: nil, checkLatest: true,
                               session: session, now: now)
    }

    @discardableResult func ensureLanguage(_ locale: String?, for snapshot: Prompt, session: URLSession = .shared) async -> Bool {
        guard !Task.isCancelled else { return false }
        cancelLanguageRequest()
        guard let locale else { return true }
        guard LanguagePackCatalog.supportedLocales.contains(locale), !isRemoved(snapshot), !storageRecoveryPending else { return false }
        if let feed {
            if feed.resolved(snapshot).availableLanguages.contains(locale) { return true }
            do {
                let item = try await feed.language(locale, for: snapshot)
                try Task.checkCancellation()
                guard !isRemoved(item) else { return false }
                // A single detail must never treat absent page items as deletions.
                if favoritesReadable {
                    let updated = Self.enrichedFavorites(favorites, from: [item], availability: [item.id: feed.availableLanguages(for: item)])
                    if updated != favorites {
                        try commitCatalogFiles([("favorites.json", JSONEncoder().encode(updated))])
                        favorites = updated
                    }
                }
                return true
            } catch { return false }
        }
        let current = prompts.first { $0.id == snapshot.id }
        let matchesCurrent = current.map { LanguagePackCatalog.sourceFingerprint($0) == LanguagePackCatalog.sourceFingerprint(snapshot) } == true
        let available = advertisedLanguages(for: snapshot)
        guard available.contains(locale) else { return false }
        if snapshot.availableLanguages.contains(locale) || (matchesCurrent && current?.availableLanguages.contains(locale) == true) { return true }
        guard matchesCurrent, languagePackIndex != nil, !ProcessInfo.processInfo.arguments.contains("--offline") else { return false }
        // A user language selection supersedes an automatic update; its old result
        // must not replace this selection when the network returns out of order.
        cancelRefresh()
        return await startRefresh(requestedLocales: [locale], target: snapshot,
                                  checkLatest: false, session: session, now: Date())
    }

    private func startRefresh(requestedLocales: [String], target: Prompt?, checkLatest: Bool, session: URLSession, now: Date) async -> Bool {
        let attempt = UUID()
        if checkLatest { lastAttempt = now; lastAttemptLanguage = ContentLanguage.preferred }
        isRefreshing = true; refreshID = attempt; refreshingLanguage = target != nil
        syncState = .checking; syncMessage = nil
        let task = Task { [weak self] in
            guard let self else { return false }
            return await self.performRefresh(attempt: attempt, requestedLocales: requestedLocales, target: target,
                                             checkLatest: checkLatest, session: session)
        }
        refreshTask = task
        return await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
    }

    private func verifyRefreshOwner(_ attempt: UUID, target: Prompt?) throws {
        try Task.checkCancellation()
        guard refreshID == attempt else { throw CancellationError() }
        if let target {
            guard !isRemoved(target), let current = prompts.first(where: { $0.id == target.id }),
                  LanguagePackCatalog.sourceFingerprint(current) == LanguagePackCatalog.sourceFingerprint(target) else {
                throw CancellationError()
            }
        }
    }

    private func performRefresh(attempt: UUID, requestedLocales: [String], target: Prompt?, checkLatest: Bool, session: URLSession) async -> Bool {
        defer {
            if refreshID == attempt { isRefreshing = false; refreshID = nil; refreshTask = nil; refreshingLanguage = false }
            languageCache.pruneInactiveArtifacts()
        }
        do {
            try verifyRefreshOwner(attempt, target: target)
            let edition = try await CatalogSync.prepareLanguagePacks(requestedLocales: requestedLocales, cache: languageCache,
                active: languagePackIndex, checkLatest: checkLatest, session: session) { [weak self] progress in
                Task { @MainActor in
                    guard let self, self.refreshID == attempt else { return }
                    switch self.syncState { case .checking, .downloading: break; default: return }
                    if case let .downloading(received, _) = self.syncState, progress.receivedBytes < received { return }
                    self.syncState = .downloading(receivedBytes: progress.receivedBytes, totalBytes: progress.totalBytes)
                }
            }
            try verifyRefreshOwner(attempt, target: target)
            if let target {
                guard let incoming = edition.catalog.prompts.first(where: { $0.id == target.id }),
                      LanguagePackCatalog.sourceFingerprint(incoming) == LanguagePackCatalog.sourceFingerprint(target) else { throw CancellationError() }
            }
            syncState = .installing
            let staged = try await Self.stageLanguageEdition(edition, cache: languageCache, retainingIndex: languagePackIndex)
            defer { staged.releaseArtifacts() }
            try verifyRefreshOwner(attempt, target: target)
            // Staging repairs damaged artifacts, but a healthy unchanged edition
            // needs no active-pointer or personal-store transaction.
            if let active = languagePackIndex,
               active.manifestBytes == staged.index.manifestBytes,
               active.downloadedLocales == staged.index.downloadedLocales,
               version == edition.catalog.version, prompts == edition.catalog.prompts,
               removedIDs == Set(edition.catalog.removedIDs ?? []) {
                languagePackBase = edition.base
                syncState = .current
                return true
            }
            try commitLanguageEdition(edition, staged: staged)
            syncState = .current
            return true
        } catch is CancellationError {
            // Returning to the foreground should immediately resume an interrupted
            // update, without showing a failure for a user-initiated cancellation.
            if refreshID == attempt { lastAttempt = nil; syncState = .idle; syncMessage = nil }
        } catch {
            if refreshID == attempt {
                syncState = .failed
                syncMessage = String(localized: "暂时无法更新，仍可浏览已下载的灵感。")
            }
        }
        return false
    }

    private nonisolated static func stageLanguageEdition(_ edition: LanguagePackEdition, cache: LanguagePackCache,
                                                         retainingIndex: LanguagePackCache.Index?) async throws -> LanguagePackCache.Staged {
        try Task.checkCancellation()
        // Return the lease even if cancellation arrived during staging, so the
        // caller can release it and sweep safely after checking ownership.
        return try cache.stage(edition, retainingIndex: retainingIndex)
    }
    func installLanguagePacks(_ edition: LanguagePackEdition) throws {
        guard !storageRecoveryPending else { throw CocoaError(.fileWriteUnknown) }
        defer { languageCache.pruneInactiveArtifacts() }
        let staged = try languageCache.stage(edition, retainingIndex: languagePackIndex)
        defer { staged.releaseArtifacts() }
        try commitLanguageEdition(edition, staged: staged)
        // Explicit installs also supersede a download whose source text happens
        // to match. Its older manifest must not undo this edition's revocations.
        cancelRefresh()
        syncState = .current
    }
    private func commitLanguageEdition(_ edition: LanguagePackEdition, staged: LanguagePackCache.Staged) throws {
        guard removedIDs.isSubset(of: Set(edition.catalog.removedIDs ?? [])) else { throw SyncError.invalidManifest }
        var aliases = Self.creatorAliases(from: prompts + favorites, to: edition.catalog.prompts)
        for (key, previous) in creatorAliases where aliases[key] == nil {
            aliases[key] = Self.resolveCreator(previous, in: edition.catalog.prompts, aliases: aliases)
        }
        try applyCatalog(edition.catalog, data: JSONEncoder().encode(edition.catalog), aliases: aliases,
                         availability: edition.base.availableLanguages, additionalFiles: [(LanguagePackCache.indexFileName, staged.indexData)])
        languagePackIndex = staged.index; languagePackBase = edition.base
    }
    func install(_ data: Data, manifest: CatalogManifest) throws {
        guard languagePackIndex == nil,
              !FileManager.default.fileExists(atPath: directory.appending(path: LanguagePackCache.indexFileName).path) else { throw SyncError.invalidManifest }
        let catalog = try CatalogSync.verify(data, manifest: manifest.validated())
        try installVerified(catalog, data: data)
        cancelRefresh()
        syncState = .current
    }
    private func installVerified(_ catalog: Catalog, data: Data) throws {
        var aliases = Self.creatorAliases(from: prompts + favorites, to: catalog.prompts)
        for (key, previous) in creatorAliases where aliases[key] == nil {
            aliases[key] = Self.resolveCreator(previous, in: catalog.prompts, aliases: aliases)
        }
        try applyCatalog(catalog, data: data, aliases: aliases)
    }

    private func applyCatalog(_ catalog: Catalog, data: Data?, aliases: [String: Prompt.Creator],
                              availability: [String: [String]]? = nil, additionalFiles: [(name: String, data: Data)] = []) throws {
        guard !storageRecoveryPending else { throw CocoaError(.fileWriteUnknown) }
        let removed = removedIDs.union(catalog.removedIDs ?? [])
        let reconciled = savedCreatorsReadable ? Self.reconciledCreators(savedCreators, in: catalog.prompts, aliases: aliases) : savedCreators
        let updatedDrafts = draftsReadable ? drafts.filter { !removed.contains(String($0.key.components(separatedBy: "::")[0])) } : drafts
        let updatedFavorites = favoritesReadable ? Self.enrichedFavorites(favorites.filter { !removed.contains($0.id) }, from: catalog.prompts, availability: availability) : favorites
        var changes: [(name: String, data: Data)] = additionalFiles
        if reconciled != savedCreators { changes.append(("creators.json", try JSONEncoder().encode(reconciled))) }
        if let data { changes.append(("catalog.json", data)) }
        if updatedDrafts != drafts { changes.append(("drafts.json", try JSONEncoder().encode(updatedDrafts))) }
        if updatedFavorites != favorites { changes.append(("favorites.json", try JSONEncoder().encode(updatedFavorites))) }
        try commitCatalogFiles(changes)
        // No observable state changes until every file and the commit point succeed.
        savedCreators = reconciled; drafts = updatedDrafts; favorites = updatedFavorites
        creatorAliases = aliases; removedIDs = removed
        prompts = catalog.prompts.filter { !removed.contains($0.id) }; version = catalog.version
        updatedAt = catalog.publishedAt.flatMap(Self.parseDate)
    }

    private struct CatalogRollback: Codable {
        struct File: Codable {
            let name: String
            let data: Data?
        }
        let files: [File]
    }
    private static let transactionName = "catalog-transaction.json"
    private static let catalogFileNames: Set<String> = ["catalog.json", "favorites.json", "drafts.json", "creators.json", LanguagePackCache.indexFileName, FeedCheckpoint.fileName]

    private func commitFeedRemovals(_ checkpoint: FeedCheckpoint) throws {
        guard !storageRecoveryPending else { throw CocoaError(.fileWriteUnknown) }
        let removed = Set(checkpoint.removedIDs)
        guard removedIDs.isSubset(of: removed) else { throw FeedError.invalidResponse }
        let updatedFavorites = favorites.filter { !removed.contains($0.id) }
        let updatedDrafts = drafts.filter { !removed.contains(String($0.key.components(separatedBy: "::")[0])) }
        // Never acknowledge a checkpoint while a personal file cannot be reconciled.
        guard favoritesReadable, draftsReadable else { throw CocoaError(.fileReadCorruptFile) }
        let bytes = try JSONEncoder().encode(checkpoint)
        guard bytes.count <= 40_000_000 else { throw FeedError.invalidResponse }
        var changes = [(FeedCheckpoint.fileName, bytes)]
        if updatedFavorites != favorites { changes.append(("favorites.json", try JSONEncoder().encode(updatedFavorites))) }
        if updatedDrafts != drafts { changes.append(("drafts.json", try JSONEncoder().encode(updatedDrafts))) }
        try commitCatalogFiles(changes)
        removedIDs = removed; favorites = updatedFavorites; drafts = updatedDrafts
        prompts.removeAll { removed.contains($0.id) }
    }

    private func commitCatalogFiles(_ changes: [(name: String, data: Data)]) throws {
        guard !changes.isEmpty else { return }
        let manager = FileManager.default
        let previous = try changes.map { change -> CatalogRollback.File in
            let url = directory.appending(path: change.name)
            let data: Data?
            if manager.fileExists(atPath: url.path) {
                guard try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else { throw CocoaError(.fileReadUnknown) }
                data = try Data(contentsOf: url)
            } else { data = nil }
            return CatalogRollback.File(name: change.name, data: data)
        }
        // A single durable journal retains all prior bytes, including absent files.
        // Removing it is the commit point; a launch interrupted before then rolls back.
        let journal = directory.appending(path: Self.transactionName)
        try JSONEncoder().encode(CatalogRollback(files: previous)).write(to: journal, options: .atomic)
        do {
            for change in changes { try installFileWriter(change.data, directory.appending(path: change.name)) }
            try manager.removeItem(at: journal)
        } catch {
            let writeError = error
            do { try Self.recoverCatalogTransaction(in: directory) }
            catch {
                // Keep the journal and stop mutations/cache deletion until next launch
                // can recover. Do not let later edits invalidate the rollback snapshot.
                storageRecoveryPending = true
                self.error = String(localized: "收藏暂时无法读取。原文件已保留，请稍后重试。")
            }
            throw writeError
        }
    }

    private static func recoverCatalogTransaction(in directory: URL) throws {
        let manager = FileManager.default
        let journal = directory.appending(path: transactionName)
        guard manager.fileExists(atPath: journal.path) else { return }
        let rollback = try JSONDecoder().decode(CatalogRollback.self, from: Data(contentsOf: journal))
        guard !rollback.files.isEmpty, rollback.files.count <= catalogFileNames.count,
              Set(rollback.files.map(\.name)).count == rollback.files.count,
              rollback.files.allSatisfy({ catalogFileNames.contains($0.name) }) else { throw CocoaError(.fileReadCorruptFile) }
        for file in rollback.files.reversed() {
            let url = directory.appending(path: file.name)
            let exists = manager.fileExists(atPath: url.path)
            if exists {
                guard try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else { throw CocoaError(.fileWriteFileExists) }
            }
            if let data = file.data {
                let current = exists ? try Data(contentsOf: url) : nil
                if current != data { try data.write(to: url, options: .atomic) }
            } else if exists { try manager.removeItem(at: url) }
        }
        try manager.removeItem(at: journal)
    }
    private static func creatorAliases(from previous: [Prompt], to catalog: [Prompt]) -> [String: Prompt.Creator] {
        let current = Dictionary(uniqueKeysWithValues: catalog.map { ($0.id, $0) })
        var candidates: [String: [Prompt.Creator]] = [:]
        for item in previous {
            guard let old = item.creator, let next = current[item.id]?.creator,
                  !old.hasConflictingIdentity(with: next) else { continue }
            candidates[old.identityKey, default: []].append(next)
        }
        return candidates.compactMapValues { values in
            guard let first = values.first, Set(values.compactMap(\.platformIdentity)).count <= 1,
                  values.allSatisfy({ $0.matchesIdentity(of: first) }) else { return nil }
            return values.max { creatorCompleteness($0) < creatorCompleteness($1) }
        }
    }
    private static func resolveCreator(_ snapshot: Prompt.Creator, in catalog: [Prompt], aliases: [String: Prompt.Creator]) -> Prompt.Creator {
        let creators = catalog.compactMap(\.creator)
        let verified = creators.filter { candidate in
            candidate.platform == snapshot.platform && snapshot.platformIdentity != nil && candidate.platformIdentity == snapshot.platformIdentity
        }
        let anchor = aliases[snapshot.identityKey].flatMap { snapshot.hasConflictingIdentity(with: $0) ? nil : $0 }
        let identity = verified.isEmpty ? (anchor ?? snapshot) : snapshot
        let matches = verified.isEmpty ? creators.filter { $0.matchesIdentity(of: identity) } : verified
        guard let first = matches.first, Set(matches.compactMap(\.platformIdentity)).count <= 1,
              matches.allSatisfy({ $0.matchesIdentity(of: first) }) else { return snapshot }
        let exact = matches.filter { $0.id == identity.id }
        let resolved = (exact.isEmpty ? matches : exact).max { creatorCompleteness($0) < creatorCompleteness($1) } ?? snapshot
        // An incomplete source refresh must not undo a verified account identity.
        return snapshot.platformIdentity != nil && resolved.platformIdentity == nil ? snapshot : resolved
    }
    private static func reconciledCreators(_ saved: [Prompt.Creator], in catalog: [Prompt], aliases: [String: Prompt.Creator]) -> [Prompt.Creator] {
        var result: [Prompt.Creator] = []
        for snapshot in saved {
            let creator = resolveCreator(snapshot, in: catalog, aliases: aliases)
            if !result.contains(where: { creatorsMatch($0, creator, in: catalog) }) { result.append(creator) }
        }
        return result
    }
    private static func creatorCompleteness(_ creator: Prompt.Creator) -> Int {
        (creator.platformIdentity == nil ? 0 : 8) + (creator.avatarURL == nil ? 0 : 4)
            + (creator.bio == nil ? 0 : 2) + (creator.username == nil ? 0 : 1)
    }
    private static func enrichedFavorites(_ saved: [Prompt], from catalog: [Prompt], availability: [String: [String]]? = nil) -> [Prompt] {
        let current = Dictionary(uniqueKeysWithValues: catalog.map { ($0.id, $0) })
        return saved.map { snapshot in
            // Add translations and creator details without silently changing the
            // instruction the user saved. Edited drafts are stored separately.
            guard let item = current[snapshot.id],
                  snapshot.feedRevision == nil || snapshot.feedRevision == item.feedRevision,
                  LanguagePackCatalog.sourceFingerprint(item) == LanguagePackCatalog.sourceFingerprint(snapshot) else { return snapshot }
            var updated = item
            var translations = snapshot.localization?.translations ?? [:]
            for (locale, content) in item.localization?.translations ?? [:] { translations[locale] = content }
            if let available = availability?[item.id] { translations = translations.filter { available.contains($0.key) } }
            if let metadata = item.localization ?? snapshot.localization {
                updated.localization = Prompt.Localization(sourceLanguage: metadata.sourceLanguage,
                    sourceFingerprint: item.localization?.sourceFingerprint ?? metadata.sourceFingerprint, translations: translations, en: metadata.en)
            }
            return updated
        }
    }

    func isSaved(_ item: Prompt) -> Bool { savedIDs.contains(item.id) }
    func reloadFavorites() {
        guard !storageRecoveryPending else { return }
        guard !favoritesReadable else { return }
        do {
            let recovered = try JSONDecoder().decode([Prompt].self, from: Data(contentsOf: savedFile))
            let valid = Self.enrichedFavorites(recovered.filter { !removedIDs.contains($0.id) }, from: prompts,
                                              availability: languagePackBase?.availableLanguages)
            if valid != recovered { try JSONEncoder().encode(valid).write(to: savedFile, options: .atomic) }
            favorites = valid; favoritesReadable = true; error = nil
        } catch { self.error = String(localized: "收藏仍然无法读取，原文件与离线预览已保留。") }
    }
    @discardableResult func toggle(_ item: Prompt) -> Bool {
        guard !isRemoved(item) else {
            error = String(localized: "这条内容已被移除，无法再保存。你仍可复制当前文字。")
            return false
        }
        guard favoritesReadable, !storageRecoveryPending else {
            error = String(localized: "已有收藏暂时无法读取。为保留原文件，本次修改未保存。")
            return false
        }
        var updated = favorites
        if let index = updated.firstIndex(where: { $0.id == item.id }) { updated.remove(at: index) }
        else { updated.insert(item, at: 0) }
        do {
            let data = try JSONEncoder().encode(updated)
            try data.write(to: directory.appending(path: "favorites.json"), options: .atomic)
            favorites = updated
            let saved = updated.contains { $0.id == item.id }
            if !saved { decks.removeEverywhere([item.id]) }
            recommendations.record(saved ? .save : .unsave, prompt: item)
            return true
        } catch { self.error = String(localized: "未能保存收藏，请检查设备存储空间后重试。"); return false }
    }
    func dismissError() { error = nil }
    func reportContentFailure(_ failure: any Error) {
        if failure as? FeedError == .removed { error = String(localized: "这条内容已被移除，无法再保存。你仍可复制当前文字。") }
        else { error = String(localized: "内容暂时无法加载，请稍后重试。") }
    }
}


/// A user-made deck of saved works, newest first. "全部收藏" is every favorite
/// and is never stored as a deck.
struct Deck: Codable, Identifiable, Equatable {
    let id: String
    var name: String
    var itemIDs: [String]
    var updatedAt: Date
}

/// Decks live in their own file beside favorites.json, so a damaged deck file
/// never puts saved works at risk. An unreadable file is kept and not overwritten.
@MainActor @Observable final class DeckStore {
    static let fileName = "decks.json"
    static let maximumDecks = 100
    static let maximumItems = 5000
    static let maximumNameLength = 40
    private(set) var decks: [Deck] = []
    private(set) var readable = true
    private let file: URL?

    init(directory: URL? = nil) {
        file = directory?.appending(path: Self.fileName)
        guard let file, FileManager.default.fileExists(atPath: file.path) else { return }
        do {
            let attributes = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard attributes.isRegularFile == true, attributes.isSymbolicLink != true, (attributes.fileSize ?? .max) <= 4_000_000 else { throw FeedError.invalidResponse }
            let value = try JSONDecoder().decode([Deck].self, from: Data(contentsOf: file))
            guard Self.valid(value) else { throw FeedError.invalidResponse }
            decks = value
        } catch { readable = false }
    }

    static func valid(_ decks: [Deck]) -> Bool {
        decks.count <= maximumDecks && Set(decks.map(\.id)).count == decks.count && decks.allSatisfy { deck in
            !deck.id.isEmpty && deck.id.utf8.count <= 64 && cleanName(deck.name) == deck.name
                && deck.itemIDs.count <= maximumItems && Set(deck.itemIDs).count == deck.itemIDs.count
                && deck.itemIDs.allSatisfy(FeedValidation.id) && deck.updatedAt.timeIntervalSince1970.isFinite
        }
    }
    /// Trimmed, single-line and bounded; nil when nothing usable remains.
    static func cleanName(_ name: String) -> String? {
        let value = name.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty else { return nil }
        return String(value.prefix(maximumNameLength))
    }

    func decks(containing itemID: String) -> [Deck] { decks.filter { $0.itemIDs.contains(itemID) } }

    @discardableResult func create(named name: String, now: Date = Date()) -> Deck? {
        guard let name = Self.cleanName(name), decks.count < Self.maximumDecks else { return nil }
        let deck = Deck(id: UUID().uuidString.lowercased(), name: name, itemIDs: [], updatedAt: now)
        return commit([deck] + decks) ? deck : nil
    }
    @discardableResult func rename(_ id: String, to name: String, now: Date = Date()) -> Bool {
        guard let name = Self.cleanName(name), let index = decks.firstIndex(where: { $0.id == id }) else { return false }
        var next = decks; next[index].name = name; next[index].updatedAt = now
        return commit(next)
    }
    @discardableResult func delete(_ id: String) -> Bool {
        guard decks.contains(where: { $0.id == id }) else { return false }
        return commit(decks.filter { $0.id != id })
    }
    @discardableResult func set(_ itemID: String, in deckID: String, member: Bool, now: Date = Date()) -> Bool {
        guard FeedValidation.id(itemID), let index = decks.firstIndex(where: { $0.id == deckID }) else { return false }
        guard decks[index].itemIDs.contains(itemID) != member else { return true }
        var next = decks
        if member {
            guard next[index].itemIDs.count < Self.maximumItems else { return false }
            next[index].itemIDs.insert(itemID, at: 0)
        } else { next[index].itemIDs.removeAll { $0 == itemID } }
        next[index].updatedAt = now
        return commit(next)
    }
    /// Unsaving a work takes it out of every deck as well.
    @discardableResult func removeEverywhere(_ itemIDs: Set<String>) -> Bool {
        guard decks.contains(where: { !$0.itemIDs.allSatisfy { !itemIDs.contains($0) } }) else { return true }
        return commit(decks.map { deck in var deck = deck; deck.itemIDs.removeAll { itemIDs.contains($0) }; return deck })
    }

    private func commit(_ next: [Deck]) -> Bool {
        guard readable, Self.valid(next) else { return false }
        if let file {
            do { try JSONEncoder().encode(next).write(to: file, options: .atomic) } catch { return false }
        }
        decks = next
        return true
    }
}
