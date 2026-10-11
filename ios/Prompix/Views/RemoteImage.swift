import SwiftUI
import ImageIO

@MainActor final class ImageStore {
    static let shared = ImageStore()
    private let memory = NSCache<NSURL, UIImage>()
    private let session: URLSession
    private var pending: [URL: Task<UIImage, Error>] = [:]
    init() {
        memory.totalCostLimit = 40 * 1024 * 1024
        let configuration = URLSessionConfiguration.default
        configuration.urlCache = URLCache(memoryCapacity: 4 * 1024 * 1024, diskCapacity: 80 * 1024 * 1024, directory: URL.cachesDirectory.appending(path: "PrompixImages"))
        configuration.requestCachePolicy = .returnCacheDataElseLoad
        configuration.httpMaximumConnectionsPerHost = 4
        session = URLSession(configuration: configuration)
    }
    func clear() { memory.removeAllObjects(); session.configuration.urlCache?.removeAllCachedResponses() }
    func image(for url: URL) async throws -> UIImage {
        if let image = memory.object(forKey: url as NSURL) { return image }
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
