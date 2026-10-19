import SwiftUI

/// A short, offline-ready introduction. Only explicit interest completion exits it.
struct PrompixOnboarding: View {
    let onComplete: () -> Void
    @Environment(Library.self) private var library
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openURL) private var openURL
    @State private var page = 0
    @State private var example: Prompt?
    @State private var openFailed = false
    @AccessibilityFocusState private var focusedPage: Int?

    private var canComplete: Bool {
        library.recommendations.interests.count == 3 && !library.recommendations.storageFailed
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { move(to: page - 1) } label: {
                    Image(systemName: "chevron.left").font(.system(size: 18, weight: .medium))
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
                    ForEach(0..<4) { index in
                        pageContent(index, viewport: viewport.size).tag(index)
                    }
                }.tabViewStyle(.page(indexDisplayMode: .never))
            }
            controls
        }
        .background(Palette.paper).foregroundStyle(Palette.ink)
        .interactiveDismissDisabled()
        .onChange(of: page) { _, value in focusedPage = value }
        .task {
            // Original Prompix Studio artwork and its complete prompt ship together.
            // Live catalog order, connectivity and downloaded media cannot change this story.
            guard let url = Bundle.main.url(forResource: "catalog", withExtension: "json"),
                  let data = try? Data(contentsOf: url),
                  let catalog = try? JSONDecoder().decode(Catalog.self, from: data) else { return }
            example = catalog.prompts.first { $0.id == "summer-citrus" }
        }
    }

    private func pageContent(_ index: Int, viewport: CGSize) -> some View {
        ScrollView {
            VStack(spacing: index == 3 ? 24 : 0) {
                if index == 3 {
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
                        Group {
                            switch index {
                            case 0: JourneyGlass(elapsed: elapsed, entered: entered)
                            case 1: JourneyCollage(elapsed: elapsed, entered: entered)
                            default: JourneyHandoff(elapsed: elapsed, entered: entered)
                            }
                        }.frame(width: width, height: height)
                    }
                    .accessibilityHidden(true).allowsHitTesting(false)
                    Spacer(minLength: 18)
                    JourneyEntrance(active: page == index, delay: 0.24) {
                        VStack(spacing: 14) {
                            Text(copy(["onboarding.discover.body", "onboarding.save.body", "onboarding.use.body"][index]))
                                .font(.subheadline).foregroundStyle(Palette.muted)
                                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("onboarding-body-\(index)")
                            if index == 2 {
                                Button(action: tryPrompt) {
                                    Label(copy("onboarding.handoff.action"), systemImage: "arrow.up.right")
                                        .font(.subheadline.weight(.semibold)).multilineTextAlignment(.center)
                                        .frame(minHeight: 44).padding(.horizontal, 18)
                                        .background(Palette.soft, in: Capsule())
                                }
                                .buttonStyle(JourneyButtonStyle()).disabled(example == nil)
                                .accessibilityIdentifier("onboardingTryPrompt")
                                if openFailed {
                                    Text(copy("onboarding.handoff.failed")).font(.footnote).foregroundStyle(Palette.muted)
                                }
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: 520)
            .padding(.horizontal, 24).padding(.top, index == 3 ? 20 : 12).padding(.bottom, 20)
            .frame(maxWidth: .infinity, minHeight: index == 3 ? nil : viewport.height)
        }
        .scrollIndicators(.hidden).accessibilityIdentifier("onboarding-page-\(index)")
    }

    private func heading(_ index: Int) -> some View {
        Text(copy(["onboarding.discover.title", "onboarding.save.title", "onboarding.use.title", "onboarding.interests.title"][index]))
            .font(.system(.largeTitle, design: .rounded, weight: .semibold))
            .tracking(-1.2).fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader).accessibilityFocused($focusedPage, equals: index)
            .accessibilityIdentifier("onboarding-title-\(index)")
    }

    private var controls: some View {
        VStack(spacing: 14) {
            if page == 3 {
                Text(typeSize.isAccessibilitySize ? "\(library.recommendations.interests.count) / 3" : String(format: copy("onboarding.interests.count"), locale: .current, library.recommendations.interests.count))
                    .font(.caption.monospacedDigit()).foregroundStyle(Palette.muted)
                    .contentTransition(.numericText()).accessibilityIdentifier("onboardingInterestCount")
                    .accessibilityLabel(String(format: copy("onboarding.interests.count"), locale: .current, library.recommendations.interests.count))
            }
            Button {
                if page == 3 {
                    // Check the durable write too: a failed save must never bypass setup.
                    guard canComplete, library.recommendations.setInterests(library.recommendations.interests) else { return }
                    onComplete()
                } else { move(to: page + 1) }
            } label: {
                HStack(spacing: 14) {
                    Text(copy(page == 3 ? "onboarding.complete" : page == 0 ? "onboarding.begin" : "onboarding.next"))
                        .fixedSize(horizontal: false, vertical: true)
                    if !typeSize.isAccessibilitySize { Image(systemName: "arrow.right").accessibilityHidden(true) }
                }
                .font(.body.weight(.semibold)).multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: 28).padding(.vertical, 16).padding(.horizontal, typeSize.isAccessibilitySize ? 16 : 24)
                .foregroundStyle(Palette.paper)
                .background(page == 3 && !canComplete ? Palette.muted.opacity(0.35) : Palette.ink, in: Capsule())
            }
            .buttonStyle(JourneyButtonStyle()).disabled(page == 3 && !canComplete)
            .accessibilityIdentifier(page == 3 ? "onboardingComplete" : "onboardingNext")
            HStack(spacing: 7) {
                ForEach(0..<4) { index in
                    Capsule().fill(index == page ? Palette.ink : Palette.line)
                        .frame(width: index == page ? 24 : 6, height: 5)
                }
            }
            .frame(height: 12).accessibilityElement(children: .ignore)
            .accessibilityLabel(copy("onboarding.progress"))
            .accessibilityValue(String(format: copy("onboarding.progress.format"), locale: .current, page + 1, 4))
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
        guard (0..<4).contains(destination) else { return }
        withAnimation(reduceMotion ? nil : .smooth(duration: 0.4)) { page = destination }
    }

    private func tryPrompt() {
        guard let example, let destination = PromptDestination.choices(for: example).first(where: { $0.id == "chatgpt" }) else { return }
        let transfer = destination.transfer(example.content(in: example.preferredTranslation).prompt)
        UIPasteboard.general.string = transfer.text
        openFailed = false
        openURL(transfer.url) { accepted in openFailed = !accepted }
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
                Ellipse().fill(Palette.spectrumIris.opacity(0.1)).blur(radius: 36)
                    .frame(width: width * 0.72, height: height * 0.4).offset(y: height * 0.12)
                ForEach(0..<7) { index in
                    let fraction = Double(index) / 6
                    RoundedRectangle(cornerRadius: width * 0.045, style: .continuous)
                        .fill(Palette.onboardingGlass(at: fraction))
                        .overlay {
                            RoundedRectangle(cornerRadius: width * 0.045).strokeBorder(
                                LinearGradient(colors: [.white.opacity(0.95), .white.opacity(0.12), .white.opacity(0.65)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 0.7)
                        }
                        .shadow(color: Palette.spectrumBlue.opacity(0.08), radius: 9, x: 0, y: 6)
                        .frame(width: width * 0.40, height: min(width * 0.67, height * 0.73))
                        .rotationEffect(.degrees(entered ? (fraction - 0.5) * 58 : -12), anchor: .bottom)
                        .rotation3DEffect(.degrees(entered ? sin(elapsed * 0.55) * 3 : 35), axis: (x: 0, y: 1, z: 0))
                        .offset(x: entered ? (fraction - 0.5) * width * 0.06 : 0,
                                y: (entered ? 0 : height * 0.12) + sin(elapsed * 0.65 + fraction * 1.2) * 5)
                        .scaleEffect(entered ? 1 : 0.72, anchor: .bottom)
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

private struct JourneyCollage: View {
    let elapsed: Double
    let entered: Bool
    var body: some View {
        GeometryReader { space in
            let w = space.size.width
            let h = space.size.height
            ZStack {
                photo("lake", width: w * 0.53, height: h * 0.44, angle: 9, phase: 1)
                    .position(x: w * 0.7, y: h * 0.25)
                photo("citrus", width: w * 0.59, height: h * 0.72, angle: -8, phase: 0)
                    .position(x: w * 0.32, y: h * 0.51)
                photo("studio-paper-forms", width: w * 0.44, height: h * 0.47, angle: 8, phase: 2)
                    .position(x: w * 0.75, y: h * 0.75)
            }
        }
    }
    private func photo(_ name: String, width: Double, height: Double, angle: Double, phase: Double) -> some View {
        Image(name).resizable().scaledToFill().frame(width: width, height: height)
            .clipShape(RoundedRectangle(cornerRadius: 20))
            .overlay { RoundedRectangle(cornerRadius: 20).strokeBorder(.white.opacity(0.55), lineWidth: 1) }
            .shadow(color: .black.opacity(0.12), radius: 14, x: 0, y: 8)
            .rotationEffect(.degrees(entered ? angle + sin(elapsed * 0.5 + phase) * 2 : 0))
            .scaleEffect(entered ? 1 : 0.75)
            .offset(y: entered ? sin(elapsed * 0.6 + phase) * 6 : 45 + phase * 16)
            .opacity(entered ? 1 : 0)
    }
}

private struct JourneyHandoff: View {
    let elapsed: Double
    let entered: Bool
    var body: some View {
        GeometryReader { space in
            let width = min(space.size.width * 0.7, 270)
            VStack(spacing: 12) {
                Image("citrus").resizable().scaledToFill()
                    .frame(width: width, height: space.size.height * 0.56)
                    .clipShape(RoundedRectangle(cornerRadius: 22))
                    .overlay(alignment: .bottomLeading) {
                        Label("Prompt", systemImage: "text.alignleft").font(.system(size: 14, weight: .medium))
                            .padding(.horizontal, 14).padding(.vertical, 9)
                            .background(.regularMaterial, in: Capsule()).padding(12)
                    }
                    .rotationEffect(.degrees(entered ? -5 : -15))
                    .offset(y: sin(elapsed * 0.6) * 3)
                Image(systemName: "arrow.down").font(.system(size: 24, weight: .light))
                    .foregroundStyle(Palette.accent).offset(y: sin(elapsed * 1.6) * 4)
                    .frame(height: 30)
                HStack(spacing: 12) {
                    Image(systemName: "bubble.left.and.bubble.right").font(.system(size: 24, weight: .light))
                    Text("ChatGPT").font(.system(size: 22, weight: .medium))
                    Image(systemName: "arrow.up.right").font(.system(size: 14, weight: .medium)).foregroundStyle(Palette.muted)
                }
                .padding(.horizontal, 24).frame(height: 64)
                .background(Palette.surface, in: Capsule())
                .overlay { Capsule().strokeBorder(Palette.line, lineWidth: 1) }
                .offset(y: entered ? 0 : 25)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .scaleEffect(entered ? 1 : 0.88).opacity(entered ? 1 : 0)
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
