import SwiftUI

@main struct PrompixApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var library = Library()
    var body: some Scene {
        WindowGroup {
            RootView().environment(library)
                .tint(Color.primary)
                .task { await library.refresh() }
                .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await library.refresh() } } }
                .alert("暂时遇到一点问题", isPresented: Binding(get: { library.error != nil }, set: { if !$0 { library.dismissError() } })) {
                    Button("知道了", role: .cancel) { library.dismissError() }
                } message: { Text(library.error ?? "") }
        }
    }
}
