import SwiftUI

/// Preserve SF Symbols' light outline in the system tab bar.
enum TabSymbol {
    static func image(_ name: String) -> Image {
        let configuration = UIImage.SymbolConfiguration(pointSize: 23, weight: .regular)
        let symbol = UIImage(systemName: name, withConfiguration: configuration) ?? UIImage()
        return Image(uiImage: symbol.withRenderingMode(.alwaysTemplate))
    }
}
