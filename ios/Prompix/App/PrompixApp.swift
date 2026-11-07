import SwiftUI

@main struct PrompixApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var library: Library
    init() {
        var directory: URL?
        var offline = false
        #if DEBUG && targetEnvironment(simulator)
        // UI tests run on the bundled catalog in a data directory of their own.
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "--ui-test-data"), arguments.indices.contains(index + 1),
           UUID(uuidString: arguments[index + 1]) != nil {
            directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appending(path: "UITestData").appending(path: arguments[index + 1])
        }
        // Unit tests host the app; neither they nor UI tests reach the content service.
        offline = directory != nil || arguments.contains("--offline") || NSClassFromString("XCTestCase") != nil
        if arguments.contains("--reset-onboarding") {
            // Reset only the welcome preference for first-run UI tests.
            UserDefaults.standard.removeObject(forKey: "hasCompletedOnboarding")
        }
        #endif
        _library = State(initialValue: Library(directory: directory, feedService: offline ? nil : FeedClient()))
    }
    var body: some Scene {
        WindowGroup {
            RootView().environment(library)
                .tint(Palette.accent)
                .foregroundStyle(Palette.ink)
                .task { await library.refresh() }
                .task { NoteFonts.shared.prepare() }
                .task(id: library.savedImageURLs) { if let urls = library.savedImageURLs { await ImageStore.shared.keepOffline(urls) } }
                .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await library.refresh() } } else { library.recommendations.flush() } }
                .alert(String(localized: "暂时遇到一点问题"), isPresented: Binding(get: { library.error != nil }, set: { if !$0 { library.dismissError() } })) {
                    Button(String(localized: "知道了"), role: .cancel) { library.dismissError() }
                } message: { Text(library.error ?? "") }
        }
    }
}

#if DEBUG && targetEnvironment(simulator)
/// Opt-in fixture for reviewing waiting states: holds each feed request and
/// picture download for a while, so skeletons and arrivals can be watched.
enum SimulatorSlowNetwork {
    static func wait(seconds: Double) async {
        guard ProcessInfo.processInfo.arguments.contains("--simulate-slow-network") else { return }
        try? await Task.sleep(for: .seconds(seconds))
    }
}
#endif
