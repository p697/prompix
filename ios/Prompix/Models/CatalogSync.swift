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

struct CatalogSync {
    static let endpoint = URL(string: "https://api.prompix.dev/v1/latest.json")!
    static func fetch(_ url: URL, maximum: Int, session: URLSession = .shared) async throws -> Data {
        var request = URLRequest(url: url)
        request.timeoutInterval = 25
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              response.url?.scheme == "https", response.url?.host == url.host else { throw SyncError.invalidResponse }
        guard response.expectedContentLength <= maximum else { throw SyncError.tooLarge }
        var data = Data()
        for try await byte in bytes {
            data.append(byte)
            if data.count > maximum { throw SyncError.tooLarge }
        }
        return data
    }
    static func verify(_ data: Data, manifest: CatalogManifest) throws -> Catalog {
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard digest == manifest.sha256 else { throw SyncError.checksum }
        let catalog = try JSONDecoder().decode(Catalog.self, from: data).validated()
        guard catalog.version == manifest.version else { throw SyncError.invalidManifest }
        return catalog
    }
}
