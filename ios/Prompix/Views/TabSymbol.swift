import SwiftUI

/// Keep the supplied outline while the native tab bar controls icon sizing.
enum TabSymbol {
    static func image(_ name: String) -> Image {
        // TabView otherwise substitutes filled variants for every tab.
        if let symbol = UIImage(systemName: name) {
            return Image(uiImage: symbol).renderingMode(.template)
        }
        return Image(systemName: name)
    }
}
