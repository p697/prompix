import Foundation
import Observation

@MainActor @Observable final class Library {
    private(set) var prompts: [Prompt] = []
    private(set) var favorites: [Prompt] = []
    private(set) var error: String?
    private(set) var version = ""
    private let directory: URL
    var savedIDs: Set<String> { Set(favorites.map(\.id)) }

    init(directory: URL? = nil, catalogURL: URL? = Bundle.main.url(forResource: "catalog", withExtension: "json")) {
        self.directory = directory ?? URL.applicationSupportDirectory.appending(path: "Prompix", directoryHint: .isDirectory)
        do {
            try FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
            let savedURL = self.directory.appending(path: "favorites.json")
            if FileManager.default.fileExists(atPath: savedURL.path) {
                favorites = try JSONDecoder().decode([Prompt].self, from: Data(contentsOf: savedURL))
            }
        } catch { self.error = "收藏暂时无法读取。原文件已保留，请稍后重试。" }
        do {
            guard let catalogURL else { throw CocoaError(.fileNoSuchFile) }
            let catalog = try JSONDecoder().decode(Catalog.self, from: Data(contentsOf: catalogURL)).validated()
            prompts = catalog.prompts
            version = catalog.version
        } catch { self.error = "灵感暂时没有加载成功。你仍然可以查看已保存的收藏。" }
    }

    func isSaved(_ item: Prompt) -> Bool { savedIDs.contains(item.id) }
    @discardableResult func toggle(_ item: Prompt) -> Bool {
        var updated = favorites
        if let index = updated.firstIndex(where: { $0.id == item.id }) { updated.remove(at: index) }
        else { updated.insert(item, at: 0) }
        do {
            let data = try JSONEncoder().encode(updated)
            try data.write(to: directory.appending(path: "favorites.json"), options: .atomic)
            favorites = updated
            return true
        } catch { self.error = "未能保存收藏，请检查设备存储空间后重试。"; return false }
    }
    func dismissError() { error = nil }
}
