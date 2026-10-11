import SwiftUI

@main struct PrompixApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var library = Library()
    var body: some Scene {
        WindowGroup {
            RootView().environment(library)
                .tint(Color.primary)
                .task { await library.refresh() }
                .task(id: library.savedImageURLs) { if let urls = library.savedImageURLs { await ImageStore.shared.keepOffline(urls) } }
                .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await library.refresh() } } }
                .alert(String(localized: "暂时遇到一点问题"), isPresented: Binding(get: { library.error != nil }, set: { if !$0 { library.dismissError() } })) {
                    Button(String(localized: "知道了"), role: .cancel) { library.dismissError() }
                } message: { Text(library.error ?? "") }
        }
    }
}
