import SwiftUI
import WebKit

// Only bundled, first-party examples are rendered here. The app shell is native.
struct WebExample: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            BundledWebsite().navigationTitle("原创网页示例").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }
}
struct BundledWebsite: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        if let url = Bundle.main.url(forResource: "portfolio", withExtension: "html", subdirectory: "WebExamples") {
            view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        return view
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
    class Coordinator: NSObject, WKNavigationDelegate {
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            if url.isFileURL { decisionHandler(.allow) }
            else {
                decisionHandler(.cancel)
                if url.scheme == "https", navigationAction.navigationType == .linkActivated { UIApplication.shared.open(url) }
            }
        }
    }
}
