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
