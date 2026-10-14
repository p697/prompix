import SwiftUI

struct PrompixOnboarding: View {
    let onComplete: () -> Void
    @Environment(Library.self) private var library
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var page = 0
    @State private var examples: [Prompt] = []
    @State private var writingExample: Prompt?
    @State private var capturedExamples = false
    @AccessibilityFocusState private var focusedPage: Int?

    var body: some View {
        VStack(spacing: 0) {
            navigation
            GeometryReader { viewport in
                TabView(selection: $page) {
                    ForEach(0..<3) { index in
                        pageContent(index, viewport: viewport.size)
                            .tag(index)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
            }
            controls
        }
        .background(Palette.paper)
        .foregroundStyle(Palette.ink)
        .onAppear(perform: captureExamples)
        .onChange(of: page) { _, value in focusedPage = value }
    }

    private var navigation: some View {
        HStack(spacing: 12) {
            Button { move(to: page - 1) } label: {
                Image(systemName: "chevron.left")
                    .font(.body.weight(.medium))
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(String(localized: "onboarding.back", table: "Onboarding"))
            .accessibilityIdentifier("onboardingBack")
            .disabled(page == 0).opacity(page == 0 ? 0 : 1)
            .accessibilityHidden(page == 0)
            Spacer(minLength: 0)
            Button(action: onComplete) {
                Text(String(localized: "onboarding.skip", table: "Onboarding"))
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityIdentifier("onboardingSkip")
        }
        .buttonStyle(.plain)
        .foregroundStyle(Palette.muted)
        .padding(.horizontal, 20)
    }

    private func pageContent(_ index: Int, viewport: CGSize) -> some View {
        ScrollView {
            VStack(spacing: 0) {
                Text(title(for: index))
                    .font(.system(.title, design: .default, weight: .regular))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityFocused($focusedPage, equals: index)
                    .accessibilityIdentifier("onboarding-title-\(index)")
                Spacer(minLength: 24)
                illustration(for: index, viewport: viewport)
                    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                    .accessibilityHidden(true)
                    .allowsHitTesting(false)
                Spacer(minLength: 24)
                Text(description(for: index))
                    .font(.body)
                    .foregroundStyle(Palette.muted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                if index == 2 {
                    Text(String(localized: "onboarding.use.skills", table: "Onboarding"))
                        .font(.subheadline)
                        .foregroundStyle(Palette.muted)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 12)
                }
            }
            .frame(maxWidth: 520)
            .padding(.horizontal, 24)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity, minHeight: viewport.height)
        }
        .scrollIndicators(.hidden)
        .accessibilityIdentifier("onboarding-page-\(index)")
    }

    @ViewBuilder private func illustration(for index: Int, viewport: CGSize) -> some View {
        let width = max(0, min(viewport.width - 48, typeSize.isAccessibilitySize ? 280 : 440))
        // Artwork scales with its container; larger text scrolls above the fixed actions.
        let height = min(width * 1.05, max(200, viewport.height * 0.67))
        if index == 0 {
            collage.frame(width: width, height: height)
        } else if index == 1 {
            collectionPreview.frame(maxWidth: width)
        } else {
            usePreview.frame(maxWidth: min(width, 360))
        }
    }

    private var collage: some View {
        GeometryReader { space in
            let width = space.size.width
            let height = space.size.height
            ZStack {
                tile(at: 0).frame(width: width * 0.23, height: height * 0.26)
                    .position(x: width * 0.14, y: height * 0.22)
                tile(at: 1).frame(width: width * 0.28, height: height * 0.31)
                    .position(x: width * 0.51, y: height * 0.17)
                tile(at: 2).frame(width: width * 0.21, height: height * 0.23)
                    .position(x: width * 0.86, y: height * 0.29)
                Text("Prompix")
                    .font(.system(size: width * 0.20, weight: .semibold, design: .default))
                    .tracking(-width * 0.008)
                    .lineLimit(1).minimumScaleFactor(0.7)
                    .position(x: width * 0.5, y: height * 0.52)
                tile(at: 3).frame(width: width * 0.25, height: height * 0.27)
                    .position(x: width * 0.15, y: height * 0.78)
                tile(at: 4).frame(width: width * 0.31, height: height * 0.30)
                    .position(x: width * 0.55, y: height * 0.83)
                tile(at: 5).frame(width: width * 0.20, height: height * 0.21)
                    .position(x: width * 0.88, y: height * 0.75)
            }
        }
    }

    private var collectionPreview: some View {
        HStack(alignment: .top, spacing: 16) {
            savedExample(at: 0)
            savedExample(at: 1).padding(.top, 36)
        }
    }

    private func savedExample(at index: Int) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            tile(at: index).aspectRatio(0.78, contentMode: .fit)
                .overlay(alignment: .bottomTrailing) {
                    Image(systemName: "bookmark.fill")
                        .font(.body)
                        .foregroundStyle(Palette.highlightInk)
                        .padding(10)
                        .background(Palette.highlight, in: Circle())
                        .padding(8)
                }
            if examples.indices.contains(index) {
                let item = examples[index]
                Text(item.displayTitle).font(.subheadline).lineLimit(2)
                Text(item.creator?.displayName ?? item.source.author ?? item.source.name)
                    .font(.caption).foregroundStyle(Palette.muted).lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var usePreview: some View {
        VStack(spacing: 18) {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Prompt").font(.caption.weight(.medium))
                    Spacer()
                    Image(systemName: "doc.on.doc").font(.body)
                }
                .foregroundStyle(Palette.accent)
                if let writingExample {
                    Text(writingExample.displayTitle).font(.title3).lineLimit(2)
                    Text(writingExample.displaySummary)
                        .font(.subheadline).foregroundStyle(Palette.muted).lineLimit(3)
                } else {
                    Text(String(localized: "onboarding.use.preview", table: "Onboarding"))
                        .font(.title3)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)
            .background(Palette.soft, in: RoundedRectangle(cornerRadius: 16))
            Image(systemName: "arrow.down").font(.title3.weight(.light)).foregroundStyle(Palette.accent)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { toolLabels }
                VStack(spacing: 8) { toolLabels }
            }
        }
    }

    @ViewBuilder private var toolLabels: some View {
        ForEach(["ChatGPT", "Claude", "Gemini"], id: \.self) { name in
            Text(name).font(.subheadline)
                .fixedSize()
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Palette.surface, in: Capsule())
        }
    }

    @ViewBuilder private func tile(at index: Int) -> some View {
        if examples.indices.contains(index) {
            OnboardingArtwork(item: examples[index])
                .clipShape(RoundedRectangle(cornerRadius: 3))
        } else {
            Rectangle().fill(index.isMultiple(of: 2) ? Palette.soft : Palette.noteSage)
                .overlay {
                    Image(systemName: ["text.quote", "photo", "play", "safari", "curlybraces", "sparkle"][index % 6])
                        .font(.title.weight(.ultraLight)).foregroundStyle(Palette.accent)
                }
        }
    }

    private var controls: some View {
        VStack(spacing: 12) {
            Button {
                if page == 2 { onComplete() } else { move(to: page + 1) }
            } label: {
                Text(page == 2 ? String(localized: "onboarding.complete", table: "Onboarding") : String(localized: "onboarding.next", table: "Onboarding"))
                    .font(.body.weight(.medium))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(minWidth: 160, minHeight: 28)
                    .padding(.horizontal, 28).padding(.vertical, 13)
                    .foregroundStyle(Palette.paper)
                    .background(Palette.accent, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(page == 2 ? "onboardingComplete" : "onboardingNext")
            HStack(spacing: 6) {
                ForEach(0..<3) { index in
                    Capsule().fill(index == page ? Palette.accent : Palette.line)
                        .frame(width: index == page ? 22 : 10, height: 4)
                }
            }
            .frame(height: 16)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(String(localized: "onboarding.progress", table: "Onboarding"))
            .accessibilityValue(String(format: String(localized: "onboarding.progress.format", table: "Onboarding"), locale: .current, page + 1, 3))
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: move(to: page + 1)
                case .decrement: move(to: page - 1)
                @unknown default: break
                }
            }
        }
        .padding(.horizontal, 24).padding(.top, 12).padding(.bottom, 12)
        .frame(maxWidth: .infinity)
        .background(Palette.paper)
    }

    private func move(to destination: Int) {
        guard (0..<3).contains(destination) else { return }
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { page = destination }
    }

    private func captureExamples() {
        guard !capturedExamples else { return }
        capturedExamples = true
        // Freeze this presentation's selection so a foreground catalog update cannot
        // rearrange the collage. Only existing catalog entries are used.
        let items = library.prompts
        let localImages = items.filter { item in
            item.kind == .image && OnboardingArtwork.hasBundledPreview(item)
        }
        let localIDs = Set(localImages.map(\.id))
        let remaining = items.filter { !localIDs.contains($0.id) }
        examples = Array((localImages + remaining).prefix(6))
        writingExample = items.first { $0.kind == .text && !$0.isSkill } ?? items.first
    }

    private func title(for index: Int) -> String {
        switch index {
        case 0: String(localized: "onboarding.discover.title", table: "Onboarding")
        case 1: String(localized: "onboarding.save.title", table: "Onboarding")
        default: String(localized: "onboarding.use.title", table: "Onboarding")
        }
    }

    private func description(for index: Int) -> String {
        switch index {
        case 0: String(localized: "onboarding.discover.body", table: "Onboarding")
        case 1: String(localized: "onboarding.save.body", table: "Onboarding")
        default: String(localized: "onboarding.use.body", table: "Onboarding")
        }
    }
}

private struct OnboardingArtwork: View {
    let item: Prompt

    static func hasBundledPreview(_ item: Prompt) -> Bool {
        if let name = item.media?.image, UIImage(named: name) != nil { return true }
        // Artwork gives a remote URL precedence over its procedural fallbacks.
        guard item.media?.imageURL == nil else { return false }
        if item.kind == .web, UIImage(named: "web-\(item.id)") != nil { return true }
        return UIImage(named: item.artwork) != nil
    }

    var body: some View {
        if item.kind == .text || item.isSkill || Self.hasBundledPreview(item) || item.media?.imageURL == nil {
            Artwork(item: item, compact: true)
        } else if let url = item.media?.imageURL, let image = ImageStore.shared.offlineImage(for: url) {
            Image(uiImage: image).resizable().scaledToFill().clipped()
        } else {
            // Remote artwork is optional here: onboarding remains useful offline
            // and never starts a separate image-download queue.
            GeometryReader { space in
                VStack(alignment: .leading, spacing: 10) {
                    Image(systemName: item.displaySymbol).font(.caption)
                    Spacer(minLength: 0)
                    Text(item.displayTitle)
                        .font(.system(size: max(11, min(18, space.size.width * 0.12))))
                        .lineLimit(4)
                    Spacer(minLength: 0)
                }
                .foregroundStyle(Palette.accent)
                .padding(space.size.width * 0.12)
                .frame(width: space.size.width, height: space.size.height, alignment: .leading)
                .background(Palette.soft)
            }
        }
    }
}
