import XCTest
@testable import Prompix

@MainActor final class ImagePrefetchTests: XCTestCase {
    func testPrefetchIsBoundedAndReplacesObsoleteQueueWithoutDecoding() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PrefetchProtocol.self]
        let session = URLSession(configuration: config)
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        let store = ImageStore(offlineDirectory: root, session: session)
        let owner = UUID()
        let old = (0..<12).map { URL(string: "https://api.prompix.dev/media/prefetch-\($0).png")! }
        let fresh = URL(string: "https://api.prompix.dev/media/fresh.png")!
        PrefetchProtocol.probe.reset()
        defer { store.prefetch([], owner: owner); PrefetchProtocol.probe.finishAll(); session.invalidateAndCancel() }
        store.prefetch(old, owner: owner)
        for _ in 0..<100 where PrefetchProtocol.probe.count < 2 { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(PrefetchProtocol.probe.count, 2)
        store.prefetch([fresh], owner: owner)
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertEqual(PrefetchProtocol.probe.count, 2, "Changing viewport must not start another pool")
        PrefetchProtocol.probe.finishAll()
        for _ in 0..<100 where PrefetchProtocol.probe.count < 3 { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(PrefetchProtocol.probe.urls.last, fresh)
        XCTAssertEqual(PrefetchProtocol.probe.count, 3, "The remaining old queue must be dropped")
        XCTAssertNil(store.cachedImage(for: fresh), "Prefetch must not retain full decoded images")
        // A visible cell joins the same download instead of issuing another request.
        let visible = Task { try await store.image(for: fresh) }
        PrefetchProtocol.probe.finishAll()
        let image = try await visible.value
        XCTAssertGreaterThan(image.size.width, 0)
        XCTAssertEqual(PrefetchProtocol.probe.count, 3)
        XCTAssertNotNil(store.cachedImage(for: fresh))
    }

    func testLookaheadUsesOneScreenForPagesAndTwoForMedia() {
        let bounds = CGRect(x: 0, y: 1_600, width: 390, height: 800)
        XCTAssertTrue(PageApproach(contentHeight: 3_100, viewport: bounds).approaching)
        XCTAssertFalse(PageApproach(contentHeight: 3_300, viewport: bounds).approaching)
        XCTAssertFalse(PageApproach(contentHeight: 2_000, viewport: nil).approaching)
        let window = GridViewport(bounds: bounds, width: 390)
        XCTAssertTrue(window.includes(top: 3_900, height: 300))
        XCTAssertFalse(window.includes(top: 4_100, height: 300))
        XCTAssertFalse(window.includes(top: 500, height: 300))
    }
}

private final class PrefetchProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [URL] = []
    private var waiting: [PrefetchProtocol] = []
    var urls: [URL] { lock.withLock { recorded } }
    var count: Int { urls.count }
    func reset() { lock.withLock { recorded = []; waiting = [] } }
    func add(_ request: PrefetchProtocol) {
        lock.withLock { recorded.append(request.request.url!); waiting.append(request) }
    }
    func finishAll() {
        let requests = lock.withLock { let result = waiting; waiting = []; return result }
        requests.forEach { $0.finish() }
    }
}
private final class PrefetchProtocol: URLProtocol, @unchecked Sendable {
    static let probe = PrefetchProbe()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.probe.add(self) }
    override func stopLoading() {}
    func finish() {
        let data = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGNILAjAihiGlgQAP6xIQWSZPVUAAAAASUVORK5CYII=")!
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}
