import SwiftUI

/// The tab bar supplies selection, tint and hit targets. Render each SF Symbol
/// into the same optical box so iOS does not replace every icon with its fill.
@MainActor enum TabSymbol {
    private static let images: [String: UIImage] = {
        let names = ["rectangle.grid.1x2", "rectangle.stack", "bookmark"]
        return Dictionary(uniqueKeysWithValues: names.compactMap { name in
            guard let symbol = UIImage(systemName: name, withConfiguration:
                UIImage.SymbolConfiguration(pointSize: 20, weight: .regular)) else { return nil }
            let canvas = CGSize(width: 25, height: 25)
            let scale = min(21 / symbol.size.width, 21 / symbol.size.height)
            let size = CGSize(width: symbol.size.width * scale, height: symbol.size.height * scale)
            let image = UIGraphicsImageRenderer(size: canvas).image { _ in
                symbol.draw(in: CGRect(x: (canvas.width - size.width) / 2, y: (canvas.height - size.height) / 2,
                                       width: size.width, height: size.height))
            }.withRenderingMode(.alwaysTemplate)
            return (name, image)
        })
    }()

    static func image(_ name: String) -> Image {
        if let image = images[name] { return Image(uiImage: image).renderingMode(.template) }
        return Image(systemName: name)
    }
}
