import SwiftUI

struct Artwork: View {
    let item: Prompt
    var compact = false
    var body: some View {
        GeometryReader { proxy in
            ZStack {
                if item.kind == .text || item.isSkill { noteArtwork(size: proxy.size) }
                else if let name = item.media?.image, UIImage(named: name) != nil { photo(name, size: proxy.size) }
                else if let url = item.media?.imageURL { RemoteImage(url: url).frame(width: proxy.size.width, height: proxy.size.height).clipped() }
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
                if item.kind == .video {
                    VStack { Spacer(); HStack {
                        Label(item.media?.videoURL == nil ? "0:06" : String(localized: "播放"), systemImage: "play.fill").font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundStyle(.white).padding(.horizontal, 9).padding(.vertical, 6).background(.black.opacity(0.28), in: Capsule())
                        Spacer()
                    }.padding(12) }
                }
            }.frame(width: proxy.size.width, height: proxy.size.height).clipped().accessibilityHidden(true)
        }.accessibilityElement(children: .ignore).accessibilityHidden(true)
    }
    private func communityArtwork(size: CGSize) -> some View {
        ZStack {
            Color(red: 0.92, green: 0.91, blue: 0.85)
            VStack(alignment: .leading, spacing: 16) {
                Image(systemName: item.kind == .web ? "curlybraces" : "quote.opening").font(.system(size: 28, weight: .ultraLight))
                Text(item.displayTitle).font(.system(size: min(size.width * 0.12, 28), weight: .regular, design: .serif)).lineLimit(5).minimumScaleFactor(0.75)
                Spacer(minLength: 0)
                Text(item.displayKind).font(.system(size: 11, weight: .medium))
            }.foregroundStyle(Color(red: 0.28, green: 0.32, blue: 0.23)).padding(size.width * 0.12)
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
                Text(item.displayContent.cover?.text ?? cover.text).font(.system(size: min(size.width * (compact ? 0.115 : 0.15), 32), weight: .regular, design: .serif))
                    .lineSpacing(4).lineLimit(compact ? 3 : 5).minimumScaleFactor(0.65)
                Spacer(minLength: 0)
                if !compact { Text(item.displayContent.cover?.eyebrow ?? cover.eyebrow).font(.system(size: max(9, size.width * 0.045))).lineLimit(2) }
            }.foregroundStyle(palette.1).padding(size.width * 0.12)
        }
    }
    private func noteArtwork(size: CGSize) -> some View {
        ZStack {
            noteColor
            VStack(alignment: .leading, spacing: compact ? 6 : 12) {
                HStack(spacing: 6) {
                    Image(systemName: item.isSkill ? "curlybraces" : "text.quote")
                    if !compact { Text(item.isSkill ? "SKILL.md" : item.displayKind) }
                    Spacer(minLength: 0)
                }.font(.system(size: compact ? 12 : 10, weight: .medium))
                    .foregroundStyle(Palette.muted)
                Text(item.displayTitle)
                    .font(.system(size: min(size.width * (compact ? 0.14 : 0.108), 23), weight: .regular, design: .serif))
                    .lineSpacing(3).lineLimit(4).fixedSize(horizontal: false, vertical: true).layoutPriority(1)
                if !compact {
                    Text(noteExcerpt).font(.system(size: max(11, min(size.width * 0.068, 13))))
                        .lineSpacing(4).lineLimit(3)
                        .foregroundStyle(Palette.muted)
                }
                Spacer(minLength: 0)
            }.foregroundStyle(Palette.ink).padding(size.width * 0.10)
        }
    }
    private var noteExcerpt: String {
        let text = item.isSkill ? item.displaySummary : item.displayContent.prompt
        return text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private var noteColor: Color {
        if item.isSkill { return Palette.soft }
        switch item.cover?.tone ?? item.artwork {
        case "sage", "tarot": return Palette.noteSage
        case "clay", "letter": return Palette.noteRose
        case "sky", "learn": return Palette.noteLavender
        default: return Palette.soft
        }
    }
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
