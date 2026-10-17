import SwiftUI

struct PrompixOnboarding: View {
    let onComplete: () -> Void
    @Environment(Library.self) private var library
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var page = 0
    @State private var pagesUnfolded = false
    @State private var examples: [Prompt] = []
    @State private var writingExample: Prompt?
    @State private var capturedExamples = false
    @State private var trial: Trial?
    @AccessibilityFocusState private var focusedPage: Int?

    private struct Trial: Identifiable {
        let id = UUID()
        let item: Prompt
        let language: String?
        let content: Prompt.TranslatedContent
        let text: String
    }

    var body: some View {
        VStack(spacing: 0) {
            navigation
            GeometryReader { viewport in
                TabView(selection: $page) {
                    ForEach(0..<4) { index in
                        Group {
                            if index == 3 {
                                ScrollView {
                                    VStack(alignment: .leading, spacing: 20) {
                                        Text(RecommendationCopy.text("interests.title")).font(.title)
                                            .accessibilityIdentifier("onboarding-title-3")
                                            .accessibilityAddTraits(.isHeader)
                                            .accessibilityFocused($focusedPage, equals: 3)
                                        InterestSelection()
                                    }.padding(24).frame(maxWidth: 560).frame(maxWidth: .infinity)
                                }.accessibilityIdentifier("onboarding-page-3")
                            } else { pageContent(index, viewport: viewport.size) }
                        }.tag(index)
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
        .sheet(item: $trial, onDismiss: { focusedPage = 2 }) { trial in
            PromptUseSheet(item: trial.item, text: trial.text, sourceText: trial.content.prompt, title: trial.content.title, language: trial.language, onPrepared: { prepared in
                let saved = library.saveDraft(prepared, for: trial.item, language: trial.language)
                if !saved { library.dismissError() }
                return saved
            })
        }
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
                if index == 2 {
                    usePreview.frame(maxWidth: 360)
                    Spacer(minLength: 24)
                } else if !typeSize.isAccessibilitySize {
                    illustration(for: index, viewport: viewport)
                        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                        .accessibilityHidden(true)
                        .allowsHitTesting(false)
                    Spacer(minLength: 24)
                }
                Text(description(for: index))
                    .font(.body)
                    .foregroundStyle(Palette.muted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("onboarding-body-\(index)")
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
            brandIllustration.frame(width: width, height: height)
        } else {
            collectionPreview.frame(maxWidth: width)
        }
    }

    private var brandIllustration: some View {
        GeometryReader { space in
            VStack(spacing: 0) {
                SpectralPages(openness: reduceMotion || pagesUnfolded ? 1 : 0.06)
                    .frame(height: space.size.height * 0.84)
                    .task {
                        guard !pagesUnfolded else { return }
                        // Mount the artwork before interpolating its geometry.
                        // Only this decoration waits; every action is usable now.
                        if !reduceMotion { try? await Task.sleep(for: .milliseconds(100)) }
                        withAnimation(reduceMotion || Task.isCancelled ? nil : .spring(duration: 0.85, bounce: 0.12)) {
                            pagesUnfolded = true
                        }
                    }
                Text("Prompix")
                    .font(.system(size: min(48, space.size.width * 0.14), weight: .medium))
                    .tracking(-2)
            }
            .frame(maxWidth: .infinity)
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
        VStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Prompt").font(.caption.weight(.medium))
                    Spacer()
                    Image(systemName: "text.alignleft").font(.body).accessibilityHidden(true)
                }
                .foregroundStyle(Palette.accent)
                if let writingExample {
                    let content = writingExample.content(in: writingExample.preferredTranslation)
                    Text(content.title).font(.title3)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(content.prompt)
                        .font(.subheadline).foregroundStyle(Palette.muted).lineSpacing(4)
                        .lineLimit(typeSize.isAccessibilitySize ? 4 : 5)
                        .accessibilityIdentifier("onboardingTrialExcerpt")
                } else {
                    Text(String(localized: "onboarding.use.preview", table: "Onboarding"))
                        .font(.title3)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(alignment: .top) {
                LinearGradient(colors: [Palette.spectrumBlue, Palette.spectrumIris, Palette.spectrumRose], startPoint: .leading, endPoint: .trailing)
                    .frame(height: 2).padding(.horizontal, 24)
            }
            .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.line, lineWidth: 0.5) }
            if let writingExample {
                Button { openTrial(writingExample) } label: {
                    HStack(spacing: 10) {
                        Text(String(localized: "onboarding.trial.action", table: "Onboarding"))
                            .fixedSize(horizontal: false, vertical: true)
                        Image(systemName: "arrow.right").accessibilityHidden(true)
                    }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Palette.accent)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("onboardingTryPrompt")
                .accessibilityHint(String(localized: "onboarding.trial.hint", table: "Onboarding"))
            }
        }
    }

    private func openTrial(_ item: Prompt) {
        let language = item.preferredTranslation
        trial = Trial(item: item, language: language, content: item.content(in: language),
                      text: library.draft(for: item, language: language))
    }

    @ViewBuilder private func tile(at index: Int) -> some View {
        if examples.indices.contains(index) {
            OnboardingArtwork(item: examples[index])
                .clipShape(RoundedRectangle(cornerRadius: 3))
        } else {
            Rectangle().fill(index.isMultiple(of: 2) ? Palette.soft : Palette.noteMint)
                .overlay {
                    Image(systemName: ["text.quote", "photo", "play", "safari", "curlybraces", "sparkle"][index % 6])
                        .font(.title.weight(.ultraLight)).foregroundStyle(Palette.accent)
                }
        }
    }

    private var controls: some View {
        VStack(spacing: 12) {
            Button {
                if page == 3 { onComplete() } else { move(to: page + 1) }
            } label: {
                Text(page == 3 ? String(localized: "onboarding.complete", table: "Onboarding") : String(localized: "onboarding.next", table: "Onboarding"))
                    .font(.body.weight(.medium))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(minWidth: 160, minHeight: 28)
                    .padding(.horizontal, 28).padding(.vertical, 13)
                    .foregroundStyle(Palette.paper)
                    .background(Palette.accent, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(page == 3 ? "onboardingComplete" : "onboardingNext")
            HStack(spacing: 6) {
                ForEach(0..<4) { index in
                    Capsule().fill(index == page ? Palette.accent : Palette.line)
                        .frame(width: index == page ? 22 : 10, height: 4)
                }
            }
            .frame(height: 16)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(String(localized: "onboarding.progress", table: "Onboarding"))
            .accessibilityValue(String(format: String(localized: "onboarding.progress.format", table: "Onboarding"), locale: .current, page + 1, 4))
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
        guard (0..<4).contains(destination) else { return }
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { page = destination }
    }

    private func captureExamples() {
        guard !capturedExamples else { return }
        capturedExamples = true
        // Freeze this presentation's selection so a foreground catalog update cannot
        // rearrange the examples. Only existing catalog entries are used.
        let items = library.prompts
        let localImages = items.filter { item in
            item.kind == .image && OnboardingArtwork.hasBundledPreview(item)
        }
        let localIDs = Set(localImages.map(\.id))
        let remaining = items.filter { !localIDs.contains($0.id) }
        let writingCandidates = items.filter {
            $0.kind == .text && !$0.isSkill && !$0.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && $0.prompt.count <= 1_200
        }
        writingExample = writingCandidates.first { $0.id == "ordinary-museum" } ?? writingCandidates.first
        // A single real prompt connects discovery, saving and trying. Its text
        // is already in the catalog; opening the preview needs no network.
        var seen = Set<String>()
        let story = Array(localImages.prefix(1)) + [writingExample].compactMap { $0 } + localImages + remaining
        examples = Array(story.filter { seen.insert($0.id).inserted }.prefix(2))
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
