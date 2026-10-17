import SwiftUI
import UIKit

/// An original family of unfolding pages: one prompt, many possible outcomes.
/// Pure vector artwork, independent of downloaded content and its colors.
struct SpectralPages: View, Animatable {
    nonisolated var openness = 1.0
    var compact = false
    nonisolated var animatableData: Double {
        get { openness }
        set { openness = newValue }
    }
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        GeometryReader { geometry in
            let size = min(geometry.size.width, geometry.size.height)
            let count = compact ? 3 : 7
            ZStack {
                ForEach(0..<count, id: \.self) { index in
                    let fraction = Double(index) / Double(count - 1)
                    let angle = (fraction - 0.5) * (compact ? 58 : 112) * openness
                    RoundedRectangle(cornerRadius: size * (compact ? 0.055 : 0.012))
                        .fill(pageGradient(fraction))
                        .overlay {
                            RoundedRectangle(cornerRadius: size * (compact ? 0.055 : 0.012))
                                .strokeBorder(.white.opacity(colorScheme == .dark ? 0.24 : 0.55), lineWidth: compact ? 0.4 : 0.7)
                        }
                        .overlay(alignment: .leading) {
                            Rectangle()
                                .fill(.white.opacity(reduceTransparency ? 0 : 0.24))
                                .frame(width: size * 0.009)
                                .padding(.vertical, size * 0.02)
                        }
                        .frame(width: size * (compact ? 0.43 : 0.30), height: size * (compact ? 0.72 : 0.58))
                        .rotationEffect(.degrees(angle), anchor: .bottom)
                        .position(x: geometry.size.width * 0.5, y: geometry.size.height * 0.48)
                }
            }
        }
        .accessibilityHidden(true)
        .allowsHitTesting(false)
    }

    private func pageGradient(_ fraction: Double) -> LinearGradient {
        let edge = fraction < 0.5 ? Palette.spectrumBlue : Palette.spectrumIris
        return LinearGradient(stops: [
            .init(color: Color(red: 0.86, green: 0.94, blue: 1), location: 0),
            .init(color: fraction > 0.65 ? Palette.spectrumRose : Color(red: 0.68, green: 0.78, blue: 0.98), location: 0.35),
            .init(color: edge, location: 0.75),
            .init(color: Color(red: 0.23, green: 0.30, blue: 0.65), location: 1)
        ], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

struct PrompixWordmark: View {
    var body: some View {
        HStack(spacing: 7) {
            SpectralPages(compact: true).frame(width: 28, height: 28)
            Text("Prompix").font(.title2.weight(.semibold)).tracking(-0.8)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Prompix")
        .accessibilityAddTraits(.isHeader)
    }
}

/// Every skeleton uses the same quiet surface, without an activity overlay.
struct LoadingSurface: View {
    var body: some View {
        Rectangle().fill(Palette.soft).accessibilityHidden(true).allowsHitTesting(false)
    }
}

/// Three small pages lift in sequence, matching the approved loading study.
/// The footprint stays fixed; the activity never gates a network completion.
struct PageActivity: View {
    var active = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var visible = true
    @State private var lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
    @State private var started = Date()
    private var animates: Bool { active && visible && scenePhase == .active && !reduceMotion && !lowPower }
    var body: some View {
        drawing
            .onAppear { visible = true }
            .onDisappear { visible = false }
            .onReceive(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)) { _ in
                lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
            }
            .accessibilityHidden(true).allowsHitTesting(false)
    }
    @ViewBuilder private var drawing: some View {
        if #available(iOS 18, *) {
            timeline.onScrollVisibilityChange(threshold: 0.01) { visible = $0 }
        } else { timeline }
    }
    private var timeline: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !animates)) { clock in
            let elapsed = animates ? clock.date.timeIntervalSince(started) : 0.45
            Canvas { context, size in
                let colors = [Palette.accent, Palette.spectrumIris, Palette.spectrumRose]
                for index in 0..<3 {
                    let phase = (elapsed / 1.8 - Double(index) / 6 + 1).truncatingRemainder(dividingBy: 1)
                    let lift = pow(max(0, sin(phase * .pi * 2)), 2)
                    let height = 14 + 3 * lift
                    let rect = CGRect(x: size.width / 2 - 15 + Double(index) * 11,
                                      y: size.height / 2 + 8 - height - 3 * lift,
                                      width: 8, height: height)
                    context.fill(Path(roundedRect: rect, cornerRadius: 2), with: .color(colors[index].opacity(0.45 + 0.55 * lift)))
                }
            }
        }
    }
}

/// Visible feedback is purely visual; VoiceOver retains a meaningful status.
struct ContentActivityLabel: View {
    var size: CGFloat = 40
    var body: some View {
        PageActivity().frame(width: min(size, 48), height: 28)
            .accessibilityElement(children: .ignore)
            .accessibilityHidden(false)
            .accessibilityLabel(String(localized: "正在加载内容…"))
    }
}

/// A single quiet recovery row. Existing content stays in its original place;
/// failure is static and can never be mistaken for an operation still running.
struct ContentRecoveryRow: View {
    var message = String(localized: "暂时无法连接")
    var retryAt: Date?
    var retryID = "retryContent"
    let action: () -> Void
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) { status; Spacer(minLength: 8); retry }
            VStack(alignment: .leading, spacing: 4) { status; retry }
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .contain)
    }
    private var status: some View {
        HStack(spacing: 10) {
            Text(message).font(.footnote).foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
    private var retry: some View { FeedRetryButton(retryAt: retryAt, action: action).accessibilityIdentifier(retryID) }
}

/// Keep UIKit's refresh gesture, accessibility action and inset lifecycle.
/// Only the refresh control's visible indicator is replaced.
extension View {
    func pageRefreshable(action: @escaping @Sendable () async -> Void) -> some View {
        modifier(PageRefreshModifier(action: action))
    }
}

private struct PageRefreshModifier: ViewModifier {
    let action: @Sendable () async -> Void
    @State private var refreshing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    func body(content: Content) -> some View {
        content.refreshable {
            refreshing = true
            defer { refreshing = false }
            await action()
        }
        .background(RefreshPageAppearance(active: refreshing && scenePhase == .active, reduceMotion: reduceMotion)
            .allowsHitTesting(false).accessibilityHidden(true))
    }
}

private struct RefreshPageAppearance: UIViewRepresentable {
    let active: Bool
    let reduceMotion: Bool
    func makeUIView(context: Context) -> RefreshPageAnchor { RefreshPageAnchor() }
    func updateUIView(_ view: RefreshPageAnchor, context: Context) {
        view.active = active
        view.reduceMotion = reduceMotion
        view.attach()
    }
    static func dismantleUIView(_ view: RefreshPageAnchor, coordinator: ()) { view.detach() }
}

/// No delegate replacement, private class names, swizzling or new gestures.
/// When a native refresh control cannot be found, its system appearance remains.
private final class RefreshPageAnchor: UIView {
    var active = false
    var reduceMotion = false
    private weak var refresh: UIRefreshControl?
    private var originalTint: UIColor?
    private var host: UIHostingController<PageActivity>?
    private var retry: Task<Void, Never>?
    private var attempts = 0
    private var renderedActive: Bool?

    init() { super.init(frame: .zero); isUserInteractionEnabled = false }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { detach() } else { attempts = 0; attach() }
    }
    override func layoutSubviews() { super.layoutSubviews(); attach() }

    func attach() {
        guard window != nil else { return }
        if let refresh, refresh.window != nil {
            updateAppearance()
            return
        }
        var ancestor = superview
        while let node = ancestor {
            let controls = refreshControls(in: node)
            if controls.count == 1, let control = controls.first {
                detach()
                refresh = control
                originalTint = control.tintColor
                let controller = UIHostingController(rootView: PageActivity(active: active && !reduceMotion))
                controller.view.backgroundColor = .clear
                controller.view.isUserInteractionEnabled = false
                controller.view.accessibilityElementsHidden = true
                controller.view.translatesAutoresizingMaskIntoConstraints = false
                control.addSubview(controller.view)
                NSLayoutConstraint.activate([
                    controller.view.centerXAnchor.constraint(equalTo: control.centerXAnchor),
                    controller.view.centerYAnchor.constraint(equalTo: control.centerYAnchor),
                    controller.view.widthAnchor.constraint(equalToConstant: 44),
                    controller.view.heightAnchor.constraint(equalToConstant: 28)
                ])
                host = controller
                control.tintColor = .clear
                updateAppearance()
                return
            }
            if controls.count > 1 { break }
            ancestor = node.superview
        }
        // SwiftUI may install UIRefreshControl after the background mounts.
        guard retry == nil, attempts < 12 else { return }
        attempts += 1
        retry = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
            guard let self else { return }
            self.retry = nil
            self.attach()
        }
    }
    private func updateAppearance() {
        let next = active && !reduceMotion
        if renderedActive != next {
            host?.rootView = PageActivity(active: next)
            renderedActive = next
        }
        // Expose one semantic refresh status, not both native and custom labels.
        refresh?.accessibilityIdentifier = "pageRefreshControl"
    }
    private func refreshControls(in node: UIView) -> [UIRefreshControl] {
        if let scroll = node as? UIScrollView, let control = scroll.refreshControl { return [control] }
        return node.subviews.flatMap { refreshControls(in: $0) }
    }
    func detach() {
        retry?.cancel(); retry = nil
        if let refresh { refresh.tintColor = originalTint }
        host?.view.removeFromSuperview()
        host = nil; refresh = nil; originalTint = nil; renderedActive = nil
    }
}
