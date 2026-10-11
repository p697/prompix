import SwiftUI

struct Artwork: View {
    let item: Prompt
    var body: some View {
        GeometryReader { proxy in
            ZStack {
                if item.kind == .video, UIImage(named: item.id) != nil { photo(item.id, size: proxy.size) } else {
                switch item.artwork {
                case "citrus": photo("citrus", size: proxy.size)
                case "lake": photo("lake", size: proxy.size)
                case "tarot", "letter", "roast", "story", "learn", "journal": textArtwork(size: proxy.size)
                case "portfolio", "studio", "recipe", "travel", "timer", "gallery": webArtwork(size: proxy.size)
                case "sunset", "ocean", "orbit", "bloom", "coffee", "rain": landscape(size: proxy.size)
                default: abstractArtwork(size: proxy.size)
                }
                }
                if item.kind == .video {
                    VStack { Spacer(); HStack {
                        Label("0:06", systemImage: "play.fill").font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundStyle(.white).padding(.horizontal, 9).padding(.vertical, 6).background(.black.opacity(0.28), in: Capsule())
                        Spacer()
                    }.padding(12) }
                }
            }.frame(width: proxy.size.width, height: proxy.size.height).clipped()
        }.accessibilityHidden(true)
    }
    private func photo(_ name: String, size: CGSize) -> some View {
        Image(name).resizable().scaledToFill().frame(width: size.width, height: size.height).clipped()
    }
    private func textArtwork(size: CGSize) -> some View {
        let isDark = item.artwork == "roast"
        let ink = isDark ? Color(red: 0.91, green: 0.94, blue: 0.75) : Color(red: 0.31, green: 0.32, blue: 0.26)
        let captions: [String: (String, String, String)] = [
            "tarot": ("✳", "今天，\n慢慢来。", "A LITTLE PERSPECTIVE"),
            "letter": ("↗", "来自未来的\n一封信。", "DEAR FUTURE ME"),
            "roast": ("“", "嘴很毒。\n心很软。", "ROAST, WITH LOVE"),
            "story": ("☾", "今晚，\n月亮请假了。", "ONCE UPON A NIGHT"),
            "learn": ("↳", "把复杂，\n讲简单。", "SMALL EXPLANATIONS"),
            "journal": ("✴", "给大脑，\n留一点空白。", "A MOMENT TO YOURSELF")]
        let copy = captions[item.artwork] ?? captions["tarot"]!
        return ZStack {
            (isDark ? Color(red: 0.27, green: 0.32, blue: 0.22) : Color(red: 0.94, green: 0.92, blue: 0.86))
            VStack(alignment: .leading, spacing: size.height * 0.09) {
                Image(systemName: item.artwork == "tarot" ? "sparkle" : item.artwork == "story" ? "moon" : "asterisk").font(.system(size: min(size.width * 0.23, size.height * 0.20), weight: .ultraLight))
                Text(copy.1).font(.system(size: min(size.width * 0.14, size.height * 0.12), weight: .regular, design: .serif)).lineSpacing(5).lineLimit(nil).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Text(copy.2).font(.system(size: max(7, size.width * 0.039), design: .monospaced)).tracking(1.1)
            }.foregroundStyle(ink).padding(size.width * 0.12)
        }
    }
    private func webArtwork(size: CGSize) -> some View {
        let dark = item.artwork == "studio" || item.artwork == "timer"
        return ZStack {
            Color(red: 0.88, green: 0.89, blue: 0.86)
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 3) {
                    ForEach(0..<3) { _ in Circle().fill(dark ? .white.opacity(0.25) : .black.opacity(0.16)).frame(width: 3, height: 3) }
                    Spacer(); Text("made with a prompt").font(.system(size: 4, design: .monospaced))
                }.padding(9)
                Rectangle().fill(dark ? .white.opacity(0.12) : .black.opacity(0.08)).frame(height: 0.5)
                VStack(alignment: .leading, spacing: 10) {
                    Text(dark ? "FORM / STUDIO" : "SOMEWHERE GOOD").font(.system(size: 5, weight: .medium, design: .monospaced)).tracking(1)
                    Text(webTitle).font(.system(size: size.width * 0.12, weight: .regular, design: .serif)).lineSpacing(-2).lineLimit(nil).fixedSize(horizontal: false, vertical: true)
                    Capsule().fill(dark ? Color(red: 0.83, green: 0.89, blue: 0.53) : Color(red: 0.30, green: 0.36, blue: 0.27)).frame(width: 40, height: 12)
                    HStack(spacing: 6) {
                        ForEach(0..<3) { index in
                            RoundedRectangle(cornerRadius: 1).fill([Color(red: 0.68, green: 0.72, blue: 0.62), Color(red: 0.81, green: 0.70, blue: 0.58), Color(red: 0.71, green: 0.75, blue: 0.76)][index])
                                .overlay { Circle().stroke(.white.opacity(0.5), lineWidth: 1).padding(10) }
                        }
                    }.frame(height: size.height * 0.22)
                    Text("SELECTED WORK          2026").font(.system(size: 4, design: .monospaced)).tracking(1)
                }.padding(12)
            }.foregroundStyle(dark ? .white : Color(red: 0.23, green: 0.27, blue: 0.21))
                .background(dark ? Color(red: 0.17, green: 0.19, blue: 0.17) : Color(red: 0.97, green: 0.96, blue: 0.91))
                .clipShape(RoundedRectangle(cornerRadius: 3))
                .shadow(color: .black.opacity(0.10), radius: 12, y: 8)
                .padding(size.width * 0.09).rotationEffect(.degrees(-3))
        }
    }
    private var webTitle: String {
        switch item.artwork { case "portfolio": "Less, but\nmore you."; case "studio": "Ideas take\nshape here."; case "recipe": "A slower\nSunday."; case "travel": "Go a little\nfurther."; case "timer": "Make room\nfor focus."; default: "Objects\nof affection." }
    }
    private func landscape(size: CGSize) -> some View {
        let cool = item.artwork == "ocean" || item.artwork == "rain"
        return ZStack {
            LinearGradient(colors: cool ? [Color(red: 0.40, green: 0.54, blue: 0.59), Color(red: 0.81, green: 0.85, blue: 0.81), Color(red: 0.33, green: 0.47, blue: 0.44)] : [Color(red: 0.37, green: 0.40, blue: 0.50), Color(red: 0.85, green: 0.57, blue: 0.43), Color(red: 0.92, green: 0.75, blue: 0.50)], startPoint: .top, endPoint: .bottom)
            Circle().fill(Color(red: 1, green: 0.87, blue: 0.59)).frame(width: size.width * 0.26).blur(radius: 1).offset(x: size.width * 0.19, y: -size.height * 0.1)
            Path { path in
                path.move(to: CGPoint(x: 0, y: size.height * 0.58))
                path.addCurve(to: CGPoint(x: size.width, y: size.height * 0.55), control1: CGPoint(x: size.width * 0.3, y: size.height * 0.43), control2: CGPoint(x: size.width * 0.6, y: size.height * 0.76))
                path.addLine(to: CGPoint(x: size.width, y: size.height)); path.addLine(to: CGPoint(x: 0, y: size.height))
            }.fill(Color(red: 0.27, green: 0.32, blue: 0.32))
            Path { path in
                path.move(to: CGPoint(x: size.width * 0.47, y: size.height * 0.57))
                path.addCurve(to: CGPoint(x: size.width * 0.72, y: size.height), control1: CGPoint(x: size.width * 0.3, y: size.height * 0.76), control2: CGPoint(x: size.width * 0.7, y: size.height * 0.83))
            }.stroke(Color(red: 0.82, green: 0.78, blue: 0.67), lineWidth: size.width * 0.08)
            VStack { Text("SLOW CINEMA").font(.system(size: 7, design: .monospaced)).tracking(3); Spacer() }.foregroundStyle(.white.opacity(0.8)).padding(.top, 18)
        }
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
