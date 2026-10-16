import SwiftUI
import WebKit

enum WebsiteExamples {
    static let files = [
        "quiet-portfolio": "portfolio",
        "indie-studio": "studio",
        "sunday-recipes": "recipes",
        "travel-notes": "travel",
        "soft-focus": "focus",
        "little-gallery": "gallery"
    ]
}

// JavaScript is enabled only for bundled, first-party artifacts, never the native app shell.
struct WebExample: View {
    let filename: String
    @Environment(\.dismiss) private var dismiss
    @State private var loading = true
    @State private var failure: String?
    @State private var attempt = 0
    var body: some View {
        NavigationStack {
            ZStack {
                BundledWebsite(filename: filename, loading: $loading, failure: $failure).id(attempt)
                if loading { ContentActivityLabel(size: 80).accessibilityLabel(String(localized: "正在打开作品…")) }
                if let failure {
                    ContentUnavailableView {
                        Label(String(localized: "网页暂不可用"), systemImage: "safari")
                    } description: { Text(failure) } actions: {
                        Button(String(localized: "重新打开")) { self.failure = nil; loading = true; attempt += 1 }
                    }.background(Palette.paper)
                }
            }.navigationTitle(String(localized: "原创网页示例")).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "完成")) { dismiss() } } }
        }
    }
}
struct BundledWebsite: UIViewRepresentable {
    let filename: String
    @Binding var loading: Bool
    @Binding var failure: String?
    func makeCoordinator() -> Coordinator { Coordinator(loading: $loading, failure: $failure) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        if WebsiteExamples.files.values.contains(filename),
           let url = Bundle.main.url(forResource: filename, withExtension: "html", subdirectory: "WebExamples") {
            context.coordinator.root = url.deletingLastPathComponent().standardizedFileURL.path + "/"
            view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            Task { @MainActor in loading = false; failure = String(localized: "作品文件没有加载成功。你仍可以复制完整 Prompt。") }
        }
        return view
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
    class Coordinator: NSObject, WKNavigationDelegate {
        var root = ""
        let loading: Binding<Bool>
        let failure: Binding<String?>
        init(loading: Binding<Bool>, failure: Binding<String?>) { self.loading = loading; self.failure = failure }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loading.wrappedValue = false }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { showFailure(error) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { showFailure(error) }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { showFailure(URLError(.cannotLoadFromNetwork)) }
        private func showFailure(_ error: Error) {
            if (error as NSError).code == NSURLErrorCancelled { return }
            loading.wrappedValue = false
            failure.wrappedValue = String(localized: "作品暂时没有打开成功，请重新尝试。")
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            if url.isFileURL, !root.isEmpty, url.standardizedFileURL.path.hasPrefix(root) { decisionHandler(.allow) }
            else {
                decisionHandler(.cancel)
                if ["https", "mailto"].contains(url.scheme ?? ""), navigationAction.navigationType == .linkActivated { UIApplication.shared.open(url) }
            }
        }
    }
}
