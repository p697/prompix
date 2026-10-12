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
    static func fetch(_ url: URL, maximum: Int, session: URLSession = .shared,
                      progress: @escaping @Sendable (CatalogDownloadProgress) -> Void = { _ in }) async throws -> Data {
        guard maximum >= 0 else { throw SyncError.tooLarge }
        var request = URLRequest(url: url)
        request.timeoutInterval = 60
        // A task delegate receives bounded chunks on the session's delegate queue.
        // This avoids millions of per-byte iterations for a multilingual edition.
        let download = BoundedCatalogDownload(maximum: maximum, host: url.host, progress: progress)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                download.start(request, session: session, continuation: continuation)
            }
        } onCancel: {
            download.cancel()
        }
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

private final class BoundedCatalogDownload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let maximum: Int
    private let host: String?
    private let progress: @Sendable (CatalogDownloadProgress) -> Void
    // All mutable state is protected by lock, including cancellation before start.
    private var task: URLSessionDataTask?
    private var continuation: CheckedContinuation<Data, any Error>?
    private var finished = false
    private var bytes = Data()
    private var expectedBytes: Int?
    private var lastProgressAt: TimeInterval = 0

    init(maximum: Int, host: String?, progress: @escaping @Sendable (CatalogDownloadProgress) -> Void) {
        self.maximum = maximum; self.host = host; self.progress = progress
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
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              response.url?.scheme == "https", response.url?.host == host else {
            finish(.failure(SyncError.invalidResponse)); completionHandler(.cancel); return
        }
        guard response.expectedContentLength <= maximum else {
            finish(.failure(SyncError.tooLarge)); completionHandler(.cancel); return
        }
        let initial = lock.withLock { () -> CatalogDownloadProgress? in
            guard !finished else { return nil }
            // URLSession delivers decoded bytes; a compressed Content-Length is
            // not the total for these chunks and would reach 100% prematurely.
            let encoding = http.value(forHTTPHeaderField: "Content-Encoding")?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let isEncoded = encoding.map { !$0.isEmpty && $0 != "identity" } ?? false
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
        guard request.url?.scheme == "https", request.url?.host == host else {
            finish(.failure(SyncError.invalidResponse)); completionHandler(nil); return
        }
        completionHandler(request)
    }
}
