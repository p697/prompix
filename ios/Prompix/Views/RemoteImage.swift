import SwiftUI
import ImageIO
import CryptoKit
import Observation

@MainActor @Observable final class ImageStore {
    static let shared = ImageStore()
    private let memory = NSCache<NSURL, UIImage>()
    private let session: URLSession
    private var pending: [URL: Task<UIImage, Error>] = [:]
    private let offlineDirectory: URL
    private var retainedURLs = Set<URL>()
    private(set) var offlineFailures = Set<URL>()
    init(offlineDirectory: URL? = nil, session: URLSession? = nil) {
        self.offlineDirectory = offlineDirectory ?? URL.applicationSupportDirectory.appending(path: "Prompix/OfflineImages", directoryHint: .isDirectory)
        memory.totalCostLimit = 40 * 1024 * 1024
        let configuration = URLSessionConfiguration.default
        configuration.urlCache = URLCache(memoryCapacity: 4 * 1024 * 1024, diskCapacity: 80 * 1024 * 1024, directory: URL.cachesDirectory.appending(path: "PrompixImages"))
        configuration.requestCachePolicy = .returnCacheDataElseLoad
        configuration.httpMaximumConnectionsPerHost = 4
        self.session = session ?? URLSession(configuration: configuration)
    }
    func clear() { memory.removeAllObjects(); session.configuration.urlCache?.removeAllCachedResponses() }
    private func offlineFile(for url: URL) -> URL {
        let key = SHA256.hash(data: Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        return offlineDirectory.appending(path: key + ".jpg")
    }
    func keepOffline(_ urls: Set<URL>) async {
        retainedURLs = urls
        offlineFailures.formIntersection(urls)
        do {
            try FileManager.default.createDirectory(at: offlineDirectory, withIntermediateDirectories: true)
            let keep = Set(urls.map { offlineFile(for: $0).lastPathComponent })
            for file in try FileManager.default.contentsOfDirectory(at: offlineDirectory, includingPropertiesForKeys: nil) where !keep.contains(file.lastPathComponent) {
                try FileManager.default.removeItem(at: file)
            }
        } catch { offlineFailures = urls; return }
        for url in urls {
            guard !Task.isCancelled else { return }
            if UIImage(contentsOfFile: offlineFile(for: url).path) != nil {
                offlineFailures.remove(url)
                continue
            }
            do {
                let image = try await image(for: url)
                guard !Task.isCancelled, retainedURLs.contains(url) else { continue }
                let ratio = min(1, 800 / max(image.size.width, image.size.height))
                let size = CGSize(width: image.size.width * ratio, height: image.size.height * ratio)
                let format = UIGraphicsImageRendererFormat(); format.scale = 1
                let thumbnail = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
                guard let data = thumbnail.jpegData(compressionQuality: 0.8) else { throw SyncError.invalidResponse }
                try data.write(to: offlineFile(for: url), options: .atomic)
                offlineFailures.remove(url)
            } catch { if !Task.isCancelled, retainedURLs.contains(url) { offlineFailures.insert(url) } }
        }
    }
    func image(for url: URL) async throws -> UIImage {
        if let image = memory.object(forKey: url as NSURL) { return image }
        if let image = UIImage(contentsOfFile: offlineFile(for: url).path) {
            memory.setObject(image, forKey: url as NSURL, cost: Int(image.size.width * image.size.height * 4))
            return image
        }
        if let existing = pending[url] { return try await existing.value }
        let task = Task { @MainActor in
            let data = try await CatalogSync.fetch(url, maximum: 8_000_000, session: session)
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 1600, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { throw SyncError.invalidResponse }
            return UIImage(cgImage: cgImage)
        }
        pending[url] = task
        defer { pending[url] = nil }
        let image = try await task.value
        memory.setObject(image, forKey: url as NSURL, cost: Int(image.size.width * image.size.height * 4))
        return image
    }
}
struct RemoteImage: View {
    let url: URL
    @State private var image: UIImage?
    @State private var failed = false
    @State private var attempt = 0
    var body: some View {
        ZStack {
            Palette.soft
            if let image { Image(uiImage: image).resizable().scaledToFit() }
            else if failed {
                Button { attempt += 1 } label: { Image(systemName: "arrow.clockwise").font(.title3.weight(.light)).foregroundStyle(.secondary).frame(width: 44, height: 44) }
                    .accessibilityLabel("重新加载图片")
            } else { ProgressView().controlSize(.small) }
        }.task(id: "\(url)-\(attempt)") {
            image = nil; failed = false
            do { image = try await ImageStore.shared.image(for: url) }
            catch { failed = true }
        }
    }
}
