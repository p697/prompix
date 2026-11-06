import SwiftUI

struct Artwork: View {
    let item: ContentPreview
    var compact = false
    // Feed previews fill their reserved frame; full-image reading remains fitted.
    var fillsFrame = false
    var showsVideoBadge = true
    init(item: Prompt, compact: Bool = false, fillsFrame: Bool = false) {
        self.item = ContentPreview(item); self.compact = compact; self.fillsFrame = fillsFrame
    }
    init(preview: ContentPreview, compact: Bool = false, fillsFrame: Bool = false, showsVideoBadge: Bool = true) {
        item = preview; self.compact = compact; self.fillsFrame = fillsFrame; self.showsVideoBadge = showsVideoBadge
    }
    var body: some View {
        GeometryReader { proxy in
            ZStack {
                if item.usesTextArtwork { noteArtwork(size: proxy.size) }
                else if let name = item.media?.image, UIImage(named: name) != nil { photo(name, size: proxy.size) }
                else if let url = item.media?.imageURL { RemoteImage(url: url, contentMode: compact || fillsFrame ? .fill : .fit).frame(width: proxy.size.width, height: proxy.size.height).clipped() }
                else if item.kind == .web, UIImage(named: "web-\(item.id)") != nil {
                    Image("web-\(item.id)").resizable().scaledToFill().frame(width: proxy.size.width, height: proxy.size.height, alignment: .top).clipped()
                }
                else if let cover = item.cover { editorialCover(cover, size: proxy.size) }
                else if item.artwork == "text-editorial" || item.artwork == "web-editorial" { communityArtwork(size: proxy.size) }
                else if item.kind == .video, UIImage(named: item.id) != nil { photo(item.id, size: proxy.size) } else {
                switch item.artwork {
                case "citrus": photo("citrus", size: proxy.size)
                case "lake": photo("lake", size: proxy.size)
                case "tarot", "letter", "roast", "story", "learn", "journal": noteArtwork(size: proxy.size)
                case "portfolio", "studio", "recipe", "travel", "timer", "gallery": communityArtwork(size: proxy.size)
                default: abstractArtwork(size: proxy.size)
                }
                }
                if item.kind == .video && showsVideoBadge {
                    VStack { Spacer(); HStack {
                        Text(item.durationLabel.map { "▶ " + $0 } ?? "▶").font(Typography.meta(size: 10)).tracking(0.6)
                            .foregroundStyle(.white).padding(.horizontal, 8).padding(.vertical, 5).background(.black.opacity(0.45), in: Capsule())
                        Spacer()
                    }.padding(8) }
                }
            }.frame(width: proxy.size.width, height: proxy.size.height).clipped().accessibilityHidden(true)
        }.accessibilityElement(children: .ignore).accessibilityHidden(true)
    }
    private func communityArtwork(size: CGSize) -> some View {
        ZStack {
            Palette.soft
            VStack(alignment: .leading, spacing: 16) {
                Image(systemName: item.kind == .web ? "curlybraces" : "quote.opening").font(.system(size: 28, weight: .ultraLight))
                Text(item.displayTitle).font(.system(size: min(size.width * 0.12, 28), weight: .regular, design: .default)).lineLimit(5).minimumScaleFactor(0.75)
                Spacer(minLength: 0)
                Text(item.displayKind).font(.system(size: 11, weight: .medium))
            }.foregroundStyle(Palette.ink).padding(size.width * 0.12)
        }
    }
    private func editorialCover(_ cover: Prompt.Cover, size: CGSize) -> some View {
        let colors: [String: (Color, Color)] = [
            "sage": (Color(red: 0.85, green: 0.88, blue: 0.79), Color(red: 0.25, green: 0.33, blue: 0.23)),
            "clay": (Color(red: 0.92, green: 0.84, blue: 0.75), Color(red: 0.46, green: 0.25, blue: 0.20)),
            "ink": (Color(red: 0.24, green: 0.31, blue: 0.27), Color(red: 0.92, green: 0.93, blue: 0.79)),
            "sky": (Color(red: 0.81, green: 0.87, blue: 0.87), Color(red: 0.25, green: 0.37, blue: 0.41)),
            "cream": (Color(red: 0.94, green: 0.92, blue: 0.85), Color(red: 0.36, green: 0.35, blue: 0.27))
        ]
        let palette = colors[cover.tone] ?? colors["cream"]!
        return ZStack {
            palette.0
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Circle().stroke(palette.1.opacity(0.55), lineWidth: 0.8).frame(width: 19, height: 19)
                        .overlay { Circle().fill(palette.1).frame(width: 4, height: 4) }
                    Spacer()
                    Image(systemName: "arrow.up.right").font(.system(size: 12, weight: .light))
                }
                Spacer(minLength: 0)
                Text(cover.text).font(.system(size: min(size.width * (compact ? 0.115 : 0.15), 32), weight: .regular, design: .default))
                    .lineSpacing(4).lineLimit(compact ? 3 : 5).minimumScaleFactor(0.65)
                Spacer(minLength: 0)
                if !compact { Text(cover.eyebrow).font(.system(size: max(9, size.width * 0.045))).lineLimit(2) }
            }.foregroundStyle(palette.1).padding(size.width * 0.12)
        }
    }
    private func noteArtwork(size: CGSize) -> some View {
        ZStack {
            noteColor
            VStack(alignment: .leading, spacing: compact ? 6 : 10) {
                if !compact {
                    Text(item.metaLine).font(Typography.meta(size: 10)).tracking(1.2).lineLimit(1)
                        .foregroundStyle(Palette.muted)
                }
                Text(item.displayTitle)
                    .font(Typography.prompt(size: min(size.width * (compact ? 0.13 : 0.1), 21)))
                    .lineSpacing(3).lineLimit(4).fixedSize(horizontal: false, vertical: true).layoutPriority(1)
                Spacer(minLength: 0)
            }.foregroundStyle(Palette.ink).padding(size.width * 0.10)
        }
    }
    private var noteColor: Color { item.isSkill ? Palette.soft : Palette.surface }
    private func photo(_ name: String, size: CGSize) -> some View {
        Image(name).resizable().scaledToFill().frame(width: size.width, height: size.height).clipped()
    }
    private func abstractArtwork(size: CGSize) -> some View {
        ZStack {
            Color(red: 0.87, green: 0.83, blue: 0.76)
            Ellipse().fill(Color(red: 0.38, green: 0.46, blue: 0.35)).frame(width: size.width * 0.6, height: size.height * 0.66).rotationEffect(.degrees(32)).offset(x: -size.width * 0.12)
            Ellipse().fill(Color(red: 0.79, green: 0.38, blue: 0.24)).frame(width: size.width * 0.43, height: size.height * 0.45).rotationEffect(.degrees(-30)).offset(x: size.width * 0.20, y: size.height * 0.1)
            Circle().fill(Color(red: 0.98, green: 0.82, blue: 0.47)).frame(width: size.width * 0.3).offset(y: -size.height * 0.22)
        }
    }
}
