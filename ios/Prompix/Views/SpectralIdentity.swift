import SwiftUI

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

/// A single light pass when a placeholder appears, not a perpetual shimmer or
/// a simulated progress bar. Network completion removes it without waiting.
struct LoadingSurface: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.scenePhase) private var scenePhase
    @State private var arrived = false
    private var canAnimate: Bool { !reduceMotion && !reduceTransparency && scenePhase == .active }

    var body: some View {
        Rectangle().fill(Palette.soft)
            .overlay {
                if canAnimate {
                    GeometryReader { geometry in
                        LinearGradient(colors: [.clear, Palette.spectrumBlue.opacity(0.10), Palette.spectrumIris.opacity(0.12), .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: geometry.size.width * 0.8)
                            .offset(x: arrived ? geometry.size.width : -geometry.size.width * 0.8)
                    }
                }
            }
            .clipped()
            .task(id: canAnimate) {
                guard canAnimate, !arrived else { return }
                withAnimation(.easeInOut(duration: 1.4)) { arrived = true }
            }
            .accessibilityHidden(true)
            .allowsHitTesting(false)
    }
}

/// A bounded field of pearl-like particles: a travelling wave changes light,
/// depth and spacing together. Activity is local to a real request, never a
/// decorative timer or a promise of measurable progress.
struct SpectralActivity: View {
    var active = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorScheme) private var colorScheme
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
            let phase = animates ? clock.date.timeIntervalSince(started) * .pi / 2.8 : 0.7
            Canvas { context, size in
                let unit = min(size.width, size.height)
                let rings = unit >= 56 ? 3 : 2
                let center = CGPoint(x: size.width / 2, y: size.height / 2)
                let colors = [Palette.spectrumBlue, Palette.spectrumIris, Palette.spectrumRose]
                for ring in 0...rings {
                    let count = ring == 0 ? 1 : ring * 6
                    for index in 0..<count {
                        let angle = Double(index) * .pi * 2 / Double(count) + Double(ring) * 0.14
                        let wave = sin(phase - Double(ring) * 0.85 + cos(angle) * 0.8)
                        let energy = 0.5 + 0.5 * wave
                        let radius = unit * Double(ring) / Double(rings) * (0.36 + 0.014 * wave)
                        let drift = active ? 0.035 * sin(phase * 0.5) : 0
                        let point = CGPoint(x: center.x + cos(angle + drift) * radius,
                                            y: center.y + sin(angle + drift) * radius * (0.93 + 0.035 * cos(phase)))
                        let diameter = unit * (rings == 3 ? 0.131 : 0.175) * (0.90 + 0.10 * energy)
                        let rect = CGRect(x: point.x - diameter / 2, y: point.y - diameter / 2, width: diameter, height: diameter)
                        let path = Path(ellipseIn: rect)
                        let pigment = colors[(index + ring) % 3]
                        if reduceTransparency {
                            context.fill(path, with: .color(pigment))
                        } else {
                            let pearl = colorScheme == .dark ? Color(white: 0.43) : Color.white
                            context.fill(path, with: .radialGradient(Gradient(colors: [pearl, Palette.spectrumIce, pigment]),
                                center: CGPoint(x: rect.midX - diameter * 0.22, y: rect.midY - diameter * 0.27),
                                startRadius: 0, endRadius: diameter * 0.9))
                            var light = context
                            light.opacity = 0.15 + 0.85 * energy
                            light.fill(path, with: .linearGradient(Gradient(stops: [
                                .init(color: pearl, location: 0),
                                .init(color: Palette.spectrumIce, location: 0.28),
                                .init(color: pigment, location: 0.58),
                                .init(color: Palette.spectrumPetal, location: 1)
                            ]), startPoint: CGPoint(x: rect.minX, y: rect.minY + diameter * (0.3 + wave * 0.5)),
                                endPoint: CGPoint(x: rect.maxX, y: rect.maxY - diameter * wave * 0.3)))
                            context.stroke(path, with: .color(.white.opacity(colorScheme == .dark ? 0.15 : 0.55)), lineWidth: 0.4)
                        }
                    }
                }
            }
        }
    }
}

/// Visible feedback is purely visual; VoiceOver retains a meaningful status.
struct ContentActivityLabel: View {
    var size: CGFloat = 72
    var body: some View {
        SpectralActivity().frame(width: size, height: size)
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
            SpectralActivity(active: false).frame(width: 28, height: 28)
            Text(message).font(.footnote).foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
    private var retry: some View { FeedRetryButton(retryAt: retryAt, action: action).accessibilityIdentifier(retryID) }
}
