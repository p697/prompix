import Foundation
import Observation

@MainActor @Observable final class Library {
    private(set) var prompts: [Prompt] = []
    private(set) var favorites: [Prompt] = []
    private(set) var error: String?
    private(set) var version = ""
    private(set) var isRefreshing = false
    private(set) var syncMessage: String?
    private(set) var updatedAt: Date?
    private(set) var drafts: [String: String] = [:]
    private var draftsReadable = true
    private(set) var favoritesReadable = true
    private var removedIDs = Set<String>()
    private var lastAttempt: Date?
    private let directory: URL
    var savedIDs: Set<String> { Set(favorites.map(\.id)) }
    var savedImageURLs: Set<URL>? { favoritesReadable ? Set(favorites.compactMap { $0.media?.imageURL }) : nil }

    init(directory: URL? = nil, catalogURL: URL? = Bundle.main.url(forResource: "catalog", withExtension: "json")) {
        self.directory = directory ?? URL.applicationSupportDirectory.appending(path: "Prompix", directoryHint: .isDirectory)
        do {
            try FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
            let savedURL = self.directory.appending(path: "favorites.json")
            if FileManager.default.fileExists(atPath: savedURL.path) {
                favorites = try JSONDecoder().decode([Prompt].self, from: Data(contentsOf: savedURL))
            }
        } catch { favoritesReadable = false; self.error = String(localized: "收藏暂时无法读取。原文件已保留，请稍后重试。") }
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
            let cached = ProcessInfo.processInfo.arguments.contains("--offline") ? nil : try? JSONDecoder().decode(Catalog.self, from: Data(contentsOf: cachedURL)).validated()
            let catalog = try cached ?? JSONDecoder().decode(Catalog.self, from: Data(contentsOf: catalogURL)).validated()
            prompts = catalog.prompts
            version = catalog.version
            updatedAt = catalog.publishedAt.flatMap(Self.parseDate)
            let removed = Set(catalog.removedIDs ?? [])
            removedIDs = removed
            if !removed.isEmpty {
                if favoritesReadable {
                    favorites.removeAll { removed.contains($0.id) }
                    try JSONEncoder().encode(favorites).write(to: savedFile, options: .atomic)
                }
                try removeDrafts(ids: removed)
            }
        } catch { self.error = String(localized: "灵感暂时没有加载成功。你仍然可以查看已保存的收藏。") }
    }

    private static func parseDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    private var savedFile: URL { directory.appending(path: "favorites.json") }
    private var draftFile: URL { directory.appending(path: "drafts.json") }
    func draft(for item: Prompt) -> String { drafts[item.id] ?? item.prompt }
    @discardableResult func saveDraft(_ text: String, for item: Prompt) -> Bool {
        guard draftsReadable else {
            error = String(localized: "已有草稿暂时无法读取，修改未保存。你可以先复制内容。")
            return false
        }
        var updated = drafts
        updated[item.id] = text == item.prompt ? nil : text
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
    private func removeDrafts(ids: Set<String>) throws {
        guard draftsReadable else { return }
        let updated = drafts.filter { !ids.contains($0.key) }
        guard updated != drafts else { return }
        try JSONEncoder().encode(updated).write(to: draftFile, options: .atomic)
        drafts = updated
    }
    func refresh(force: Bool = false, session: URLSession = .shared) async {
        guard !isRefreshing, !ProcessInfo.processInfo.arguments.contains("--offline") else { return }
        if !force, let lastAttempt, Date().timeIntervalSince(lastAttempt) < 900 { return }
        lastAttempt = Date(); isRefreshing = true
        defer { isRefreshing = false }
        do {
            let data = try await CatalogSync.fetch(CatalogSync.endpoint, maximum: 32_000, session: session)
            let manifest = try JSONDecoder().decode(CatalogManifest.self, from: data).validated()
            if manifest.version == version { syncMessage = nil; return }
            let content = try await CatalogSync.fetch(manifest.catalog, maximum: 10_000_000, session: session)
            try install(content, manifest: manifest)
            syncMessage = nil
        } catch is CancellationError { }
        catch { syncMessage = String(localized: "暂时无法更新，仍可浏览已下载的灵感。") }
    }
    func install(_ data: Data, manifest: CatalogManifest) throws {
        let catalog = try CatalogSync.verify(data, manifest: manifest.validated())
        // Cache the complete validated edition first. Interrupted writes preserve the previous edition.
        try data.write(to: directory.appending(path: "catalog.json"), options: .atomic)
        let removed = Set(catalog.removedIDs ?? [])
        try removeDrafts(ids: removed)
        let updatedFavorites = favorites.filter { !removed.contains($0.id) }
        if favoritesReadable { try JSONEncoder().encode(updatedFavorites).write(to: savedFile, options: .atomic) }
        removedIDs = removed
        favorites = updatedFavorites; prompts = catalog.prompts; version = catalog.version
        updatedAt = catalog.publishedAt.flatMap(Self.parseDate)
    }

    func isSaved(_ item: Prompt) -> Bool { savedIDs.contains(item.id) }
    func reloadFavorites() {
        guard !favoritesReadable else { return }
        do {
            let recovered = try JSONDecoder().decode([Prompt].self, from: Data(contentsOf: savedFile))
            let valid = recovered.filter { !removedIDs.contains($0.id) }
            if valid != recovered { try JSONEncoder().encode(valid).write(to: savedFile, options: .atomic) }
            favorites = valid; favoritesReadable = true; error = nil
        } catch { self.error = String(localized: "收藏仍然无法读取，原文件与离线预览已保留。") }
    }
    @discardableResult func toggle(_ item: Prompt) -> Bool {
        guard favoritesReadable else {
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
            return true
        } catch { self.error = String(localized: "未能保存收藏，请检查设备存储空间后重试。"); return false }
    }
    func dismissError() { error = nil }
}
