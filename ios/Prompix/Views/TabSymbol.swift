import SwiftUI

/// Prompix's own stroke icons, drawn from the design boards on a 24 pt grid so
/// every glyph shares one weight, cap and corner. Rendered once as template
/// images, they tint like SF Symbols in tab bars, toolbars, menus and buttons.
enum PrompixIcon: CaseIterable {
    case discover, saved, savedFill, search, back, share, edit, copy, check, plus, close, filter
    case chevronDown, chevronRight, arrowUpRight, arrowRight, person, more, less, play, trash

    @MainActor var image: Image { image(size: 22) }
    @MainActor func image(size: CGFloat) -> Image {
        Image(uiImage: PrompixIconCache.image(self, size: size)).renderingMode(.template)
    }

    fileprivate var drawing: (stroke: CGPath, fill: CGPath?) {
        let stroke = CGMutablePath(), fill = CGMutablePath()
        func line(_ points: [CGPoint]) {
            stroke.move(to: points[0]); points.dropFirst().forEach { stroke.addLine(to: $0) }
        }
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }
        switch self {
        case .discover:
            stroke.addEllipse(in: CGRect(x: 3, y: 3, width: 18, height: 18))
            fill.addLines(between: [p(15.5, 8.5), p(13.5, 13.5), p(8.5, 15.5), p(10.5, 10.5)]); fill.closeSubpath()
        case .saved, .savedFill:
            let shape = CGMutablePath()
            shape.addLines(between: [p(7, 3.5), p(17, 3.5), p(17, 20.5), p(12, 16.9), p(7, 20.5)]); shape.closeSubpath()
            stroke.addPath(shape)
            if self == .savedFill { fill.addPath(shape) }
        case .search:
            stroke.addEllipse(in: CGRect(x: 4.5, y: 4.5, width: 13, height: 13)); line([p(16, 16), p(20, 20)])
        case .back: line([p(14.5, 5.5), p(8, 12), p(14.5, 18.5)])
        case .share:
            line([p(12, 15), p(12, 4)]); line([p(8, 7.5), p(12, 4), p(16, 7.5)]); line([p(6, 11), p(6, 19.5), p(18, 19.5), p(18, 11)])
        case .edit:
            stroke.addLines(between: [p(4, 20), p(8, 20), p(19, 9), p(15, 5), p(4, 16)]); stroke.closeSubpath()
        case .copy:
            stroke.addRoundedRect(in: CGRect(x: 8, y: 8, width: 11, height: 12), cornerWidth: 2.5, cornerHeight: 2.5)
            stroke.move(to: p(5, 15)); stroke.addLine(to: p(5, 6))
            stroke.addArc(tangent1End: p(5, 4), tangent2End: p(7, 4), radius: 2); stroke.addLine(to: p(15, 4))
        case .check: line([p(5, 12.5), p(9.5, 17), p(19, 7.5)])
        case .plus: line([p(12, 5), p(12, 19)]); line([p(5, 12), p(19, 12)])
        case .close: line([p(6, 6), p(18, 18)]); line([p(18, 6), p(6, 18)])
        case .filter:
            line([p(4, 7), p(14, 7)]); line([p(18, 7), p(20, 7)]); line([p(4, 17), p(8, 17)]); line([p(12, 17), p(20, 17)])
            stroke.addEllipse(in: CGRect(x: 14, y: 5, width: 4, height: 4)); stroke.addEllipse(in: CGRect(x: 8, y: 15, width: 4, height: 4))
        case .chevronDown: line([p(7, 10), p(12, 15), p(17, 10)])
        case .chevronRight: line([p(9, 6), p(15, 12), p(9, 18)])
        case .arrowUpRight: line([p(7, 17), p(17, 7)]); line([p(9, 7), p(17, 7), p(17, 15)])
        case .arrowRight: line([p(5, 12), p(19, 12)]); line([p(13, 6), p(19, 12), p(13, 18)])
        case .person:
            stroke.addEllipse(in: CGRect(x: 8.5, y: 4.5, width: 7, height: 7))
            stroke.move(to: p(5, 20)); stroke.addCurve(to: p(12, 14.5), control1: p(6.2, 16.4), control2: p(9, 14.5))
            stroke.addCurve(to: p(19, 20), control1: p(15, 14.5), control2: p(17.8, 16.4))
        case .more:
            for x in [5.0, 12, 19] { fill.addEllipse(in: CGRect(x: x - 1.8, y: 10.2, width: 3.6, height: 3.6)) }
        case .less: stroke.addEllipse(in: CGRect(x: 3.5, y: 3.5, width: 17, height: 17)); line([p(7, 17), p(17, 7)])
        case .play: fill.addLines(between: [p(8, 5.5), p(19, 12), p(8, 18.5)]); fill.closeSubpath()
        case .trash:
            line([p(4.5, 7), p(19.5, 7)]); line([p(9.5, 7), p(9.5, 4.5), p(14.5, 4.5), p(14.5, 7)])
            stroke.addLines(between: [p(6.5, 7), p(7.5, 20), p(16.5, 20), p(17.5, 7)])
        }
        return (stroke, fill.isEmpty ? nil : fill)
    }
}

@MainActor private enum PrompixIconCache {
    private static var images: [String: UIImage] = [:]
    static func image(_ icon: PrompixIcon, size: CGFloat) -> UIImage {
        let key = "\(icon)-\(size)"
        if let cached = images[key] { return cached }
        let drawing = icon.drawing, scale = size / 24
        let image = UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { context in
            let cg = context.cgContext
            cg.scaleBy(x: scale, y: scale)
            UIColor.black.setStroke(); UIColor.black.setFill()
            if let fill = drawing.fill { cg.addPath(fill); cg.fillPath() }
            cg.addPath(drawing.stroke)
            cg.setLineWidth(1.8); cg.setLineCap(.round); cg.setLineJoin(.round)
            cg.strokePath()
        }.withRenderingMode(.alwaysTemplate)
        images[key] = image
        return image
    }
}
