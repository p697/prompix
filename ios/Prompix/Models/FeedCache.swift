import Foundation
import CryptoKit

/// Disposable browsing data. Personal favorites, drafts and removal checkpoints
/// live in Library's separate transaction and are never pruned by this cache.
actor FeedCache {
    struct PageRecord: Codable, Sendable {
        let query: FeedQuery
        let savedAt: Date
        let page: FeedPage
    }
    struct DetailRecord: Codable, Sendable {
        let locale: String
        let detail: FeedDetail
    }
    let directory: URL
    private let pageLimit: Int
    private let detailLimit: Int
    private let detailByteLimit: Int
    init(directory: URL, pageLimit: Int = 12, detailLimit: Int = 80, detailByteLimit: Int = 40_000_000) {
        self.directory = directory
        self.pageLimit = max(1, pageLimit); self.detailLimit = max(1, detailLimit); self.detailByteLimit = max(1, detailByteLimit)
    }
    func page(for query: FeedQuery) throws -> PageRecord? {
        let query = try query.validated()
        let key = try pageKey(query)
        guard let data = try read(key, maximum: 1_010_000) else { return nil }
        let record = try JSONDecoder().decode(PageRecord.self, from: data)
        guard record.query == query else { throw FeedError.invalidResponse }
        _ = try record.page.validated(locale: query.locale, limit: query.sort == "recommended" ? 90 : FeedClient.pageSize)
        return record
    }
    func store(_ page: FeedPage, query: FeedQuery, now: Date = Date()) throws {
        let query = try query.validated()
        _ = try page.validated(locale: query.locale, limit: query.sort == "recommended" ? 90 : FeedClient.pageSize)
        try write(JSONEncoder().encode(PageRecord(query: query, savedAt: now, page: page)), key: pageKey(query), maximum: 1_010_000)
        try prune(prefix: "page-", count: pageLimit, bytes: 12_120_000)
    }
    func detail(id: String, revision: String, locale: String) throws -> FeedDetail? {
        guard FeedValidation.id(id), FeedValidation.revision(revision), FeedValidation.locale(locale) else { throw FeedError.invalidQuery }
        guard let data = try read(detailKey(id: id, revision: revision, locale: locale), maximum: 2_010_000) else { return nil }
        let record = try JSONDecoder().decode(DetailRecord.self, from: data)
        guard record.locale == locale else { throw FeedError.invalidResponse }
        return try record.detail.validated(id: id, revision: revision, locale: locale)
    }
    func store(_ detail: FeedDetail, locale: String) throws {
        _ = try detail.validated(id: detail.item.id, revision: detail.revision, locale: locale)
        try write(JSONEncoder().encode(DetailRecord(locale: locale, detail: detail)),
                  key: detailKey(id: detail.item.id, revision: detail.revision, locale: locale), maximum: 2_010_000)
        try prune(prefix: "detail-", count: detailLimit, bytes: detailByteLimit)
    }
    func creators(q: String) throws -> FeedCreatorsPage? {
        guard let data = try read(auxiliaryKey("creators", q), maximum: 1_000_000) else { return nil }
        return try JSONDecoder().decode(FeedCreatorsPage.self, from: data).validated(limit: FeedClient.pageSize)
    }
    func store(_ page: FeedCreatorsPage, q: String) throws {
        _ = try page.validated(limit: FeedClient.pageSize)
        try write(JSONEncoder().encode(page), key: auxiliaryKey("creators", q), maximum: 1_000_000)
        try prune(prefix: "creators-", count: 6, bytes: 6_000_000)
    }
    func browse(locale: String) throws -> FeedBrowse? {
        guard let data = try read(auxiliaryKey("browse", locale), maximum: 1_000_000) else { return nil }
        return try JSONDecoder().decode(FeedBrowse.self, from: data).validated(locale: locale)
    }
    func store(_ browse: FeedBrowse, locale: String) throws {
        _ = try browse.validated(locale: locale)
        try write(JSONEncoder().encode(browse), key: auxiliaryKey("browse", locale), maximum: 1_000_000)
        try prune(prefix: "browse-", count: 3, bytes: 3_000_000)
    }
    private func auxiliaryKey(_ prefix: String, _ value: String) -> String {
        prefix + "-" + digest(Data(value.utf8)) + ".json"
    }
    /// Called after a durable takedown commit; readers also filter the committed ID
    /// set, so an interrupted cleanup cannot resurrect a cached item.
    func remove(ids: Set<String>) throws {
        guard !ids.isEmpty else { return }
        for url in try files() {
            if url.lastPathComponent.hasPrefix("page-") {
                if let data = try read(url.lastPathComponent, maximum: 1_010_000),
                   let record = try? JSONDecoder().decode(PageRecord.self, from: data),
                   record.page.items.contains(where: { ids.contains($0.id) }) { try FileManager.default.removeItem(at: url) }
            } else if url.lastPathComponent.hasPrefix("browse-") || url.lastPathComponent.hasPrefix("creators-") {
                // Global counts/covers cannot remain authoritative after a takedown.
                try FileManager.default.removeItem(at: url)
            } else if url.lastPathComponent.hasPrefix("detail-") {
                if let data = try read(url.lastPathComponent, maximum: 2_010_000),
                   let record = try? JSONDecoder().decode(DetailRecord.self, from: data), ids.contains(record.detail.item.id) {
                    try FileManager.default.removeItem(at: url)
                }
            }
        }
    }
    private func pageKey(_ query: FeedQuery) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
        return "page-" + digest(try encoder.encode(query)) + ".json"
    }
    private func detailKey(id: String, revision: String, locale: String) -> String {
        "detail-" + digest(Data([id, revision, locale].joined(separator: "\n").utf8)) + ".json"
    }
    private func digest(_ value: Data) -> String { SHA256.hash(data: value).map { String(format: "%02x", $0) }.joined() }
    private func read(_ key: String, maximum: Int) throws -> Data? {
        try validateDirectory()
        let url = directory.appending(path: key)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let attributes = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard attributes.isRegularFile == true, attributes.isSymbolicLink != true, let size = attributes.fileSize,
              size <= maximum else { throw FeedError.invalidResponse }
        let data = try Data(contentsOf: url)
        guard data.count <= maximum else { throw FeedError.invalidResponse }
        try FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        return data
    }
    private func write(_ data: Data, key: String, maximum: Int) throws {
        guard data.count <= maximum else { throw FeedError.invalidResponse }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let attributes = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard attributes.isDirectory == true, attributes.isSymbolicLink != true else { throw FeedError.invalidResponse }
        try data.write(to: directory.appending(path: key), options: .atomic)
    }
    private func validateDirectory() throws {
        guard FileManager.default.fileExists(atPath: directory.path) else { return }
        let attributes = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard attributes.isDirectory == true, attributes.isSymbolicLink != true else { throw FeedError.invalidResponse }
    }
    private func files() throws -> [URL] {
        try validateDirectory()
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey, .contentModificationDateKey])
            .filter { url in
                let name = url.deletingPathExtension().lastPathComponent
                let parts = name.split(separator: "-", maxSplits: 1)
                guard parts.count == 2, ["page", "detail", "creators", "browse"].contains(String(parts[0])), FeedValidation.revision(String(parts[1])),
                      url.pathExtension == "json", let attributes = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]) else { return false }
                return attributes.isRegularFile == true && attributes.isSymbolicLink != true
            }
    }
    private func prune(prefix: String, count: Int, bytes: Int) throws {
        var entries: [(url: URL, size: Int, modified: Date)] = []
        for url in try files() where url.lastPathComponent.hasPrefix(prefix) {
            let attributes = try url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            entries.append((url: url, size: attributes.fileSize ?? 0, modified: attributes.contentModificationDate ?? Date.distantPast))
        }
        entries.sort { $0.modified == $1.modified ? $0.url.lastPathComponent < $1.url.lastPathComponent : $0.modified > $1.modified }
        var total = 0
        for (index, entry) in entries.enumerated() {
            total += entry.size
            if index >= count || total > bytes { try FileManager.default.removeItem(at: entry.url) }
        }
    }
}
