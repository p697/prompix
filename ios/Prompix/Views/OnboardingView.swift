import SwiftUI

/// Two steps: what Prompix is, then three interests. Only explicit interest completion exits it.
struct PrompixOnboarding: View {
    let onComplete: () -> Void
    @Environment(Library.self) private var library
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var page = 0
    @AccessibilityFocusState private var focusedPage: Int?
    private let pageCount = 2
    private let interestPage = 1

    private var canComplete: Bool {
        library.recommendations.interests.count == 3 && !library.recommendations.storageFailed
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { move(to: page - 1) } label: {
                    PrompixIcon.back.image
                        .frame(width: 44, height: 44).contentShape(Circle())
                }
                .accessibilityLabel(copy("onboarding.back"))
                .accessibilityIdentifier("onboardingBack")
                .disabled(page == 0).opacity(page == 0 ? 0 : 1).accessibilityHidden(page == 0)
                Spacer()
                Text("Prompix").font(.system(size: 17, weight: .medium)).tracking(-0.4)
                    .opacity(page == 0 ? 0 : 1).accessibilityHidden(true)
                Spacer()
                Color.clear.frame(width: 44, height: 44).accessibilityHidden(true)
            }
            .buttonStyle(.plain).padding(.horizontal, 16)
            GeometryReader { viewport in
                TabView(selection: $page) {
                    ForEach(0..<pageCount, id: \.self) { index in
                        pageContent(index, viewport: viewport.size).tag(index)
                    }
                }.tabViewStyle(.page(indexDisplayMode: .never))
            }
            controls
        }
        .background(Palette.paper).foregroundStyle(Palette.ink)
        .interactiveDismissDisabled()
        .onChange(of: page) { _, value in focusedPage = value }
    }

    private func pageContent(_ index: Int, viewport: CGSize) -> some View {
        ScrollView {
            VStack(spacing: index == interestPage ? 24 : 0) {
                if index == interestPage {
                    VStack(alignment: .leading, spacing: 10) {
                        heading(index)
                        Text(copy("onboarding.interests.body"))
                            .font(.subheadline).foregroundStyle(Palette.muted)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    InterestSelection(requiredCount: 3)
                } else {
                    JourneyEntrance(active: page == index, delay: 0.12) {
                        heading(index).multilineTextAlignment(.center)
                    }
                    Spacer(minLength: 16)
                    JourneyMotion(active: page == index) { elapsed, entered in
                        let width = min(viewport.width - 48, 400)
                        let height = typeSize.isAccessibilitySize ? 220 : min(width * 1.12, max(250, viewport.height * 0.65))
                        JourneyGlass(elapsed: elapsed, entered: entered).frame(width: width, height: height)
                    }
                    .accessibilityHidden(true).allowsHitTesting(false)
                    Spacer(minLength: 18)
                    JourneyEntrance(active: page == index, delay: 0.24) {
                        Text(copy("onboarding.discover.body"))
                            .font(.subheadline).foregroundStyle(Palette.muted)
                            .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("onboarding-body-\(index)")
                    }
                }
            }
            .frame(maxWidth: 520)
            .padding(.horizontal, 24).padding(.top, index == interestPage ? 20 : 12).padding(.bottom, 20)
            .frame(maxWidth: .infinity, minHeight: index == interestPage ? nil : viewport.height)
        }
        .scrollIndicators(.hidden).accessibilityIdentifier("onboarding-page-\(index)")
    }

    private func heading(_ index: Int) -> some View {
        Text(copy(index == interestPage ? "onboarding.interests.title" : "onboarding.discover.title"))
            .font(.system(.largeTitle, design: .rounded, weight: .semibold))
            .tracking(-1.2).fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader).accessibilityFocused($focusedPage, equals: index)
            .accessibilityIdentifier("onboarding-title-\(index)")
    }

    private var controls: some View {
        VStack(spacing: 14) {
            if page == interestPage {
                Text(typeSize.isAccessibilitySize ? "\(library.recommendations.interests.count) / 3" : String(format: copy("onboarding.interests.count"), locale: .current, library.recommendations.interests.count))
                    .font(.caption.monospacedDigit()).foregroundStyle(Palette.muted)
                    .contentTransition(.numericText()).accessibilityIdentifier("onboardingInterestCount")
                    .accessibilityLabel(String(format: copy("onboarding.interests.count"), locale: .current, library.recommendations.interests.count))
            }
            Button {
                if page == interestPage {
                    // Check the durable write too: a failed save must never bypass setup.
                    guard canComplete, library.recommendations.setInterests(library.recommendations.interests) else { return }
                    onComplete()
                } else { move(to: page + 1) }
            } label: {
                HStack(spacing: 14) {
                    Text(copy(page == interestPage ? "onboarding.complete" : "onboarding.begin"))
                        .fixedSize(horizontal: false, vertical: true)
                    if !typeSize.isAccessibilitySize { PrompixIcon.arrowRight.image(size: 20).accessibilityHidden(true) }
                }
                .font(.body.weight(.semibold)).multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: 28).padding(.vertical, 16).padding(.horizontal, typeSize.isAccessibilitySize ? 16 : 24)
                .foregroundStyle(Palette.paper)
                .background(page == interestPage && !canComplete ? Palette.muted.opacity(0.35) : Palette.ink, in: Capsule())
            }
            .buttonStyle(JourneyButtonStyle()).disabled(page == interestPage && !canComplete)
            .accessibilityIdentifier(page == interestPage ? "onboardingComplete" : "onboardingNext")
            HStack(spacing: 7) {
                ForEach(0..<pageCount, id: \.self) { index in
                    Capsule().fill(index == page ? Palette.ink : Palette.line)
                        .frame(width: index == page ? 24 : 6, height: 5)
                }
            }
            .frame(height: 12).accessibilityElement(children: .ignore)
            .accessibilityLabel(copy("onboarding.progress"))
            .accessibilityValue(String(format: copy("onboarding.progress.format"), locale: .current, page + 1, pageCount))
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: move(to: page + 1)
                case .decrement: move(to: page - 1)
                @unknown default: break
                }
            }
        }
        .frame(maxWidth: 440).padding(.horizontal, typeSize.isAccessibilitySize ? 20 : 28).padding(.top, 12).padding(.bottom, 12)
        .frame(maxWidth: .infinity).background(Palette.paper)
    }

    private func move(to destination: Int) {
        guard (0..<pageCount).contains(destination) else { return }
        withAnimation(reduceMotion ? nil : .smooth(duration: 0.4)) { page = destination }
    }

    private func copy(_ key: String) -> String { NSLocalizedString(key, tableName: "Onboarding", comment: "Welcome journey") }
}

/// Gentle decoration runs only for the visible page in an active, full-power app.
private struct JourneyMotion<Content: View>: View {
    let active: Bool
    @ViewBuilder let content: (Double, Bool) -> Content
    @Environment(\.scenePhase) private var phase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
    @State private var entered = false
    private var animates: Bool { active && phase == .active && !reduceMotion && !lowPower }
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !animates)) { timeline in
            content(animates ? timeline.date.timeIntervalSinceReferenceDate : 0, reduceMotion || lowPower || entered)
        }
        .task(id: active) {
            guard active else { entered = false; return }
            if !reduceMotion && !lowPower { try? await Task.sleep(for: .milliseconds(70)) }
            guard !Task.isCancelled else { return }
            withAnimation(reduceMotion || lowPower ? nil : .spring(duration: 1.05, bounce: 0.16)) { entered = true }
        }
        .onReceive(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)) { _ in
            lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        }
    }
}

private struct JourneyEntrance<Content: View>: View {
    let active: Bool
    let delay: Double
    @ViewBuilder let content: () -> Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false
    var body: some View {
        content().opacity(reduceMotion || appeared ? 1 : 0)
            .offset(y: reduceMotion || appeared ? 0 : 14)
            .task(id: active) {
                guard active else { appeared = false; return }
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.6).delay(delay)) { appeared = true }
            }
    }
}

private struct JourneyGlass: View {
    let elapsed: Double
    let entered: Bool
    var body: some View {
        GeometryReader { space in
            let width = space.size.width
            let height = space.size.height
            ZStack {
                Ellipse().fill(Palette.ink.opacity(0.06)).blur(radius: 36)
                    .frame(width: width * 0.72, height: height * 0.4).offset(y: height * 0.12)
                ForEach(0..<7) { index in
                    let fraction = Double(index) / 6
                    let page = RoundedRectangle(cornerRadius: width * 0.045, style: .continuous)
                    page.fill(Palette.ink.opacity(SpectralPages.tone(fraction)))
                        .overlay { page.strokeBorder(Palette.paper.opacity(0.35), lineWidth: 0.7) }
                        .shadow(color: .black.opacity(0.08), radius: 9, x: 0, y: 6)
                        .frame(width: width * 0.40, height: min(width * 0.67, height * 0.73))
                        .rotationEffect(.degrees(entered ? (fraction - 0.5) * 58 : -12), anchor: .bottom)
                        .rotation3DEffect(.degrees(entered ? sin(elapsed * 0.55) * 3 : 35), axis: (x: 0, y: 1, z: 0))
                        .offset(x: entered ? (fraction - 0.5) * width * 0.06 : 0,
                                y: (entered ? 0 : height * 0.12) + sin(elapsed * 0.65 + fraction * 1.2) * 5)
                        .scaleEffect(entered ? 1 : 0.72, anchor: .bottom)
                        .zIndex(SpectralPages.depth(fraction))
                }
            }
            .scaleEffect(0.9)
            .frame(width: width, height: height * 0.81)
            Text("Prompix").font(.system(size: min(48, width * 0.13), weight: .semibold, design: .rounded)).tracking(-2)
                .frame(width: width).position(x: width * 0.5, y: height * 0.91)
                .opacity(entered ? 1 : 0).offset(y: entered ? 0 : 12)
        }
    }
}

private struct JourneyButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
            .opacity(configuration.isPressed ? 0.8 : 1)
            .animation(reduceMotion ? nil : .spring(duration: 0.3, bounce: 0.2), value: configuration.isPressed)
    }
}
