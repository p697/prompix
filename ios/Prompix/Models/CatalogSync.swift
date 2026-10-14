import Foundation
import CryptoKit

struct CatalogManifest: Decodable {
    let schemaVersion: Int
    let version: String
    let sha256: String
    let catalog: URL
    func validated() throws -> CatalogManifest {
        guard schemaVersion == 1, catalog.scheme == "https", catalog.host == "api.prompix.dev",
              catalog.path == "/releases/\(version)/catalog.json", sha256.count == 64 else { throw SyncError.invalidManifest }
        return self
    }
}
enum SyncError: Error { case invalidManifest, invalidResponse, tooLarge, checksum }

struct CatalogDownloadProgress: Sendable, Equatable {
    let receivedBytes: Int
    let totalBytes: Int?
}

struct CatalogSync {
    static let endpoint = URL(string: "https://api.prompix.dev/v1/latest.json")!
    static let languagePackEndpoint = URL(string: "https://api.prompix.dev/v2/latest.json")!
    static func fetch(_ url: URL, maximum: Int, session: URLSession = .shared,
                      requiresExactURL: Bool = false,
                      timeout: TimeInterval = 60,
                      progress: @escaping @Sendable (CatalogDownloadProgress) -> Void = { _ in },
                      validateResponse: @escaping @Sendable (HTTPURLResponse) throws -> Void = {
                          guard $0.statusCode == 200 else { throw SyncError.invalidResponse }
                      }) async throws -> Data {
        try Task.checkCancellation()
        guard maximum >= 0 else { throw SyncError.tooLarge }
        guard timeout > 0 && timeout <= 120 else { throw SyncError.invalidResponse }
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        if requiresExactURL { request.cachePolicy = .reloadIgnoringLocalCacheData }
        // A task delegate receives bounded chunks on the session's delegate queue.
        // This avoids millions of per-byte iterations for a multilingual edition.
        let download = BoundedCatalogDownload(maximum: maximum, host: url.host,
                                              exactURL: requiresExactURL ? url : nil, validateResponse: validateResponse, progress: progress)
        let bytes = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                download.start(request, session: session, continuation: continuation)
            }
        } onCancel: {
            download.cancel()
        }
        try Task.checkCancellation()
        return bytes
    }
    /// Prepares a verified edition off the main actor without changing the active cache.
    /// Only explicitly requested, advertised locales can trigger a network download.
    static func prepareLanguagePacks(requestedLocales: [String], cache: LanguagePackCache,
                                     active: LanguagePackCache.Index? = nil, checkLatest: Bool = true,
                                     session: URLSession = .shared,
                                     progress: @escaping @Sendable (CatalogDownloadProgress) -> Void = { _ in }) async throws -> LanguagePackEdition {
        try Task.checkCancellation()
        let manifestBytes: Data
        if checkLatest {
            manifestBytes = try await fetch(languagePackEndpoint, maximum: LanguagePackCatalog.manifestByteLimit,
                                            session: session, requiresExactURL: true)
        } else {
            guard let active else { throw SyncError.invalidManifest }
            manifestBytes = active.manifestBytes
        }
        try Task.checkCancellation()
        let manifest = try LanguagePackCatalog.verifyManifest(manifestBytes)
        try Task.checkCancellation()
        let updates = LanguagePackDownloadProgress(progress)
        var received = 0
        let baseBytes: Data
        if let cached = cache.readBase(manifest: manifest) {
            baseBytes = cached
        } else {
            // Cache usability for locale packs depends on the verified base. Keep
            // totals indeterminate until those reuse checks establish missing bytes.
            baseBytes = try await fetch(manifest.base.url, maximum: manifest.base.byteCount,
                                        session: session, requiresExactURL: true) { value in
                updates.report(received: value.receivedBytes, total: nil)
            }
            received = baseBytes.count
        }
        try Task.checkCancellation()
        let base = try LanguagePackCatalog.verifyBase(baseBytes, manifest: manifest)
        try Task.checkCancellation()
        var localeBytes: [String: Data] = [:]
        for locale in LanguagePackCatalog.supportedLocales where manifest.locales[locale] != nil {
            try Task.checkCancellation()
            if let cached = cache.readLocale(locale, base: base) { localeBytes[locale] = cached }
            try Task.checkCancellation()
        }
        var seen = Set<String>()
        let missing = requestedLocales.filter {
            LanguagePackCatalog.supportedLocales.contains($0) && manifest.locales[$0] != nil
                && seen.insert($0).inserted && localeBytes[$0] == nil
        }
        let total = received + missing.reduce(0) { $0 + manifest.locales[$1]!.byteCount }
        updates.report(received: received, total: total)
        for locale in missing {
            try Task.checkCancellation()
            let descriptor = manifest.locales[locale]!, offset = received
            let bytes = try await fetch(descriptor.url, maximum: descriptor.byteCount,
                                        session: session, requiresExactURL: true) { value in
                updates.report(received: offset + value.receivedBytes, total: total)
            }
            try Task.checkCancellation()
            _ = try LanguagePackCatalog.verifyLocale(bytes, locale: locale, base: base)
            try Task.checkCancellation()
            localeBytes[locale] = bytes
            received += bytes.count
        }
        try Task.checkCancellation()
        let edition = try LanguagePackEdition(manifestBytes: manifestBytes, baseBytes: baseBytes, localeBytes: localeBytes)
        try Task.checkCancellation()
        return edition
    }
    // This nonisolated async function runs decoding and hashing away from the
    // library's main actor. The caller commits the verified edition atomically.
    static func verified(_ data: Data, manifest: CatalogManifest) async throws -> Catalog {
        try Task.checkCancellation()
        let catalog = try verify(data, manifest: manifest)
        try Task.checkCancellation()
        return catalog
    }
    static func verify(_ data: Data, manifest: CatalogManifest) throws -> Catalog {
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard digest == manifest.sha256 else { throw SyncError.checksum }
        let catalog = try JSONDecoder().decode(Catalog.self, from: data).validated()
        guard catalog.version == manifest.version else { throw SyncError.invalidManifest }
        return catalog
    }
}

private final class LanguagePackDownloadProgress: @unchecked Sendable {
    private let lock = NSLock()
    private var received = 0
    private let callback: @Sendable (CatalogDownloadProgress) -> Void
    init(_ callback: @escaping @Sendable (CatalogDownloadProgress) -> Void) { self.callback = callback }
    func report(received value: Int, total: Int?) {
        lock.withLock {
            received = max(received, value)
            callback(CatalogDownloadProgress(receivedBytes: received, totalBytes: total))
        }
    }
}

private final class BoundedCatalogDownload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let maximum: Int
    private let host: String?
    private let exactURL: URL?
    private let validateResponse: @Sendable (HTTPURLResponse) throws -> Void
    private let progress: @Sendable (CatalogDownloadProgress) -> Void
    // All mutable state is protected by lock, including cancellation before start.
    private var task: URLSessionDataTask?
    private var continuation: CheckedContinuation<Data, any Error>?
    private var finished = false
    private var bytes = Data()
    private var expectedBytes: Int?
    private var lastProgressAt: TimeInterval = 0

    init(maximum: Int, host: String?, exactURL: URL?, validateResponse: @escaping @Sendable (HTTPURLResponse) throws -> Void,
         progress: @escaping @Sendable (CatalogDownloadProgress) -> Void) {
        self.maximum = maximum; self.host = host; self.exactURL = exactURL; self.progress = progress
        self.validateResponse = validateResponse
    }

    func start(_ request: URLRequest, session: URLSession, continuation: CheckedContinuation<Data, any Error>) {
        let task = session.dataTask(with: request)
        task.delegate = self
        let canStart = lock.withLock {
            guard !finished else { return false }
            self.task = task; self.continuation = continuation
            return true
        }
        if canStart { task.resume() }
        else { task.cancel(); continuation.resume(throwing: CancellationError()) }
    }

    func cancel() { finish(.failure(CancellationError())) }

    private func finish(_ result: Result<Data, any Error>) {
        let pending = lock.withLock { () -> (URLSessionDataTask?, CheckedContinuation<Data, any Error>?) in
            guard !finished else { return (nil, nil) }
            finished = true
            let pending = (task, continuation)
            task = nil; continuation = nil; bytes = Data()
            return pending
        }
        if case .failure = result { pending.0?.cancel() }
        pending.1?.resume(with: result)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse,
              response.url?.scheme == "https", response.url?.host == host,
              exactURL == nil || response.url?.absoluteString == exactURL?.absoluteString else {
            finish(.failure(SyncError.invalidResponse)); completionHandler(.cancel); return
        }
        do { try validateResponse(http) }
        catch { finish(.failure(error)); completionHandler(.cancel); return }
        let encoding = http.value(forHTTPHeaderField: "Content-Encoding")?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let isEncoded = encoding.map { !$0.isEmpty && $0 != "identity" } ?? false
        guard isEncoded || response.expectedContentLength <= maximum else {
            finish(.failure(SyncError.tooLarge)); completionHandler(.cancel); return
        }
        let initial = lock.withLock { () -> CatalogDownloadProgress? in
            guard !finished else { return nil }
            // URLSession delivers decoded bytes; a compressed Content-Length is
            // not the total for these chunks and would reach 100% prematurely.
            expectedBytes = !isEncoded && response.expectedContentLength > 0 ? Int(response.expectedContentLength) : nil
            if let expectedBytes { bytes.reserveCapacity(expectedBytes) }
            lastProgressAt = Date.timeIntervalSinceReferenceDate
            return CatalogDownloadProgress(receivedBytes: 0, totalBytes: expectedBytes)
        }
        guard let initial else { completionHandler(.cancel); return }
        progress(initial)
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let update = lock.withLock { () -> (tooLarge: Bool, progress: CatalogDownloadProgress?) in
            guard !finished else { return (false, nil) }
            // Content-Length can be absent, incorrect or smaller than decoded data.
            // Reject before appending so accumulated storage never exceeds the cap.
            guard data.count <= maximum - bytes.count else { return (true, nil) }
            bytes.append(data)
            let now = Date.timeIntervalSinceReferenceDate
            guard now - lastProgressAt >= 0.1 else { return (false, nil) }
            lastProgressAt = now
            return (false, CatalogDownloadProgress(receivedBytes: bytes.count, totalBytes: expectedBytes))
        }
        if update.tooLarge { finish(.failure(SyncError.tooLarge)) }
        else if let value = update.progress { progress(value) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        if let error { finish(.failure(error)); return }
        let completed = lock.withLock { finished ? nil : bytes }
        guard let completed else { return }
        progress(CatalogDownloadProgress(receivedBytes: completed.count, totalBytes: completed.count))
        finish(.success(completed))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        guard request.url?.scheme == "https", request.url?.host == host,
              exactURL == nil || request.url?.absoluteString == exactURL?.absoluteString else {
            finish(.failure(SyncError.invalidResponse)); completionHandler(nil); return
        }
        completionHandler(request)
    }
}
