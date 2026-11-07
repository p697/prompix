import SwiftUI
import ImageIO
import CryptoKit
import Observation

@MainActor @Observable final class ImageStore {
    static let shared = ImageStore()
    private final class CachedImage {
        let image: UIImage
        let previewOnly: Bool
        init(_ image: UIImage, previewOnly: Bool = false) { self.image = image; self.previewOnly = previewOnly }
    }
    private let memory = NSCache<NSURL, CachedImage>()
    // Tiny decoded previews outlive large bitmap eviction during category changes.
    // This is a bounded first-frame fallback, never a full-resolution result.
    private let thumbnails = NSCache<NSURL, UIImage>()
    private let session: URLSession
    private var pending: [URL: Task<UIImage, Error>] = [:]
    private let prepared = NSCache<NSURL, NSData>()
    @ObservationIgnored private var downloads: [URL: Task<Data, Error>] = [:]
    @ObservationIgnored private var prefetchOwners: [UUID: [URL]] = [:]
    @ObservationIgnored private var prefetching = Set<URL>()
    @ObservationIgnored private var attemptedPrefetch = Set<URL>()
    private let offlineDirectory: URL
    private var retainedURLs = Set<URL>()
    private(set) var offlineFailures = Set<URL>()
    init(offlineDirectory: URL? = nil, session: URLSession? = nil) {
        self.offlineDirectory = offlineDirectory ?? URL.applicationSupportDirectory.appending(path: "Prompix/OfflineImages", directoryHint: .isDirectory)
        memory.totalCostLimit = 40 * 1024 * 1024
        thumbnails.totalCostLimit = 8 * 1024 * 1024
        prepared.totalCostLimit = 16 * 1024 * 1024
        let configuration = URLSessionConfiguration.default
        configuration.urlCache = URLCache(memoryCapacity: 4 * 1024 * 1024, diskCapacity: 80 * 1024 * 1024, directory: URL.cachesDirectory.appending(path: "PrompixImages"))
        configuration.requestCachePolicy = .returnCacheDataElseLoad
        configuration.httpMaximumConnectionsPerHost = 4
        self.session = session ?? URLSession(configuration: configuration)
    }
    func cachedImage(for url: URL) -> UIImage? { memory.object(forKey: url as NSURL)?.image ?? thumbnails.object(forKey: url as NSURL) }
    func clear() { memory.removeAllObjects(); thumbnails.removeAllObjects(); prepared.removeAllObjects(); attemptedPrefetch.removeAll(); session.configuration.urlCache?.removeAllCachedResponses() }
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
    func offlineImage(for url: URL) -> UIImage? { UIImage(contentsOfFile: offlineFile(for: url).path) }
    func image(for url: URL, fullResolution: Bool = false) async throws -> UIImage {
        if let cached = memory.object(forKey: url as NSURL), !fullResolution || !cached.previewOnly { return cached.image }
        if !fullResolution, let image = offlineImage(for: url) {
            memory.setObject(CachedImage(image, previewOnly: true), forKey: url as NSURL, cost: Int(image.size.width * image.size.height * 4))
            return image
        }
        if let existing = pending[url] { return try await existing.value }
        let task = Task { @MainActor in
            let data = try await download(url)
            // ImageIO decoding must not compete with a swipe or presentation on MainActor.
            let decoded = try await Task.detached(priority: .userInitiated) {
                guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                      let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 1600, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else { throw SyncError.invalidResponse }
                let small = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 240, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
                return (UIImage(cgImage: cgImage), small.map { UIImage(cgImage: $0) })
            }.value
            if let thumbnail = decoded.1 {
                thumbnails.setObject(thumbnail, forKey: url as NSURL, cost: Int(thumbnail.size.width * thumbnail.size.height * 4))
            }
            return decoded.0
        }
        pending[url] = task
        defer { pending[url] = nil }
        let image = try await task.value
        memory.setObject(CachedImage(image), forKey: url as NSURL, cost: Int(image.size.width * image.size.height * 4))
        return image
    }
    private func download(_ url: URL) async throws -> Data {
        if let data = prepared.object(forKey: url as NSURL) { return data as Data }
        if let existing = downloads[url] { return try await existing.value }
        let task = Task {
            #if DEBUG && targetEnvironment(simulator)
            await SimulatorSlowNetwork.wait(seconds: Double.random(in: 1...3))
            #endif
            return try await CatalogSync.fetch(url, maximum: 8_000_000, session: session)
        }
        downloads[url] = task
        defer { downloads[url] = nil }
        let data = try await task.value
        prepared.setObject(data as NSData, forKey: url as NSURL, cost: data.count)
        return data
    }
    /// One global two-request budget, even during fast scroll/filter changes.
    /// Prewarm compressed bytes, not dozens of 1600px decoded bitmaps.
    func prefetch(_ urls: [URL], owner: UUID) {
        prefetchOwners[owner] = urls.isEmpty ? nil : Array(urls.prefix(20))
        let wanted = Set(prefetchOwners.values.flatMap { $0 })
        attemptedPrefetch.formIntersection(wanted.union(prefetching))
        pumpPrefetch()
    }
    private func pumpPrefetch() {
        guard !ProcessInfo.processInfo.isLowPowerModeEnabled else { return }
        let wanted = prefetchOwners.values.flatMap { $0 }
        for url in wanted where prefetching.count < 2 {
            guard !prefetching.contains(url), !attemptedPrefetch.contains(url),
                  memory.object(forKey: url as NSURL) == nil, prepared.object(forKey: url as NSURL) == nil else { continue }
            prefetching.insert(url); attemptedPrefetch.insert(url)
            Task {
                _ = try? await download(url)
                prefetching.remove(url)
                pumpPrefetch()
            }
        }
    }

}
struct RemoteImage: View {
    let url: URL
    var contentMode: ContentMode = .fit
    /// The work's own main colour, shown until the picture arrives.
    var tone: Color?
    @State private var image: UIImage?
    @State private var loadedURL: URL?
    @State private var failed = false
    @State private var attempt = 0
    @State private var develops = false
    var body: some View {
        ZStack {
            tone ?? Palette.soft
            if let image = (loadedURL == url ? image : nil) ?? ImageStore.shared.cachedImage(for: url) {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode).developsIn(develops && loadedURL == url)
            } else if failed {
                Button { attempt += 1 } label: { Image(systemName: "arrow.clockwise").font(.title3.weight(.light)).foregroundStyle(Palette.muted).frame(width: 44, height: 44) }
                    .accessibilityLabel(String(localized: "重新加载图片"))
            }
        }.task(id: "\(url)-\(attempt)") {
            if loadedURL != url { image = nil }
            failed = false
            // Only a picture that was not already on screen develops in.
            develops = image == nil && ImageStore.shared.cachedImage(for: url) == nil
            do {
                let loaded = try await ImageStore.shared.image(for: url)
                guard !Task.isCancelled else { return }
                image = loaded; loadedURL = url
            } catch {
                guard !Task.isCancelled else { return }
                failed = true
            }
        }
    }
}

extension View {
    /// A picture that arrives from the network develops in, the way a print
    /// surfaces in the tray: grey and flat out of the paper (out of the dark in
    /// the darkroom), then its own colour. Reduce Motion keeps a short fade.
    func developsIn(_ active: Bool) -> some View { modifier(Developing(active: active)) }
}

private struct Developing: ViewModifier {
    let active: Bool
    @State private var developed = false
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        let shown = developed || !active
        let toned = shown || reduceMotion
        content
            .saturation(toned ? 1 : 0).contrast(toned ? 1 : 0.5)
            .brightness(toned ? 0 : colorScheme == .dark ? -0.5 : 0.35)
            .animation(.timingCurve(0.2, 0.65, 0.2, 1, duration: 1.1), value: toned)
            .opacity(shown ? 1 : 0)
            .animation(.easeOut(duration: reduceMotion ? 0.2 : 0.3), value: shown)
            .onAppear { developed = true }
    }
}
