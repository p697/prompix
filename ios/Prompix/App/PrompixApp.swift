import SwiftUI

@main struct PrompixApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var library = Library()
    init() {
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("--reset-onboarding") {
            // Reset only the welcome preference for first-run UI acceptance.
            UserDefaults.standard.removeObject(forKey: "hasCompletedOnboarding")
        }
        if ProcessInfo.processInfo.arguments.contains("--simulate-network-failure") {
            try? FileManager.default.removeItem(at: SimulatorNetworkFailure.recoveryURL)
            URLProtocol.registerClass(SimulatorNetworkFailure.self)
        }
        #endif
    }
    var body: some Scene {
        WindowGroup {
            RootView().environment(library)
                .tint(Palette.accent)
                .foregroundStyle(Palette.ink)
                .task { await library.refresh() }
                .task(id: library.savedImageURLs) { if let urls = library.savedImageURLs { await ImageStore.shared.keepOffline(urls) } }
                .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await library.refresh() } } }
                .alert(String(localized: "暂时遇到一点问题"), isPresented: Binding(get: { library.error != nil }, set: { if !$0 { library.dismissError() } })) {
                    Button(String(localized: "知道了"), role: .cancel) { library.dismissError() }
                } message: { Text(library.error ?? "") }
        }
    }
}

#if DEBUG && targetEnvironment(simulator)
/// Opt-in UI acceptance fixture. A host-side test can restore networking before
/// pressing the real retry button; ordinary and release launches never register it.
final class SimulatorNetworkFailure: URLProtocol {
    private var pendingFailure: DispatchWorkItem?
    static var recoveryURL: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("prompix-ui-network-restored")
    }
    override class func canInit(with request: URLRequest) -> Bool {
        ["http", "https"].contains(request.url?.scheme ?? "") &&
            !FileManager.default.fileExists(atPath: recoveryURL.path)
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if ProcessInfo.processInfo.arguments.contains("--simulate-slow-image-failure"), request.url?.path.hasPrefix("/media/") == true {
            let failure = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            }
            pendingFailure = failure
            DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: failure)
        } else { client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)) }
    }
    override func stopLoading() { pendingFailure?.cancel(); pendingFailure = nil }
}
#endif
