import SwiftUI

@main struct PrompixApp: App {
    @State private var library = Library()
    var body: some Scene {
        WindowGroup {
            RootView().environment(library)
                .tint(Color.primary)
                .alert("暂时遇到一点问题", isPresented: Binding(get: { library.error != nil }, set: { if !$0 { library.dismissError() } })) {
                    Button("知道了", role: .cancel) { library.dismissError() }
                } message: { Text(library.error ?? "") }
        }
    }
}
