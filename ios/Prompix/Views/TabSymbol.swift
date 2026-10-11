import SwiftUI

/// Template artwork avoids the system's automatic heavy filled tab variants.
enum TabSymbol {
    static func image(_ name: String) -> Image {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 25, height: 25))
        let image = renderer.image { context in
            let cg = context.cgContext
            cg.setStrokeColor(UIColor.black.cgColor)
            cg.setLineWidth(1.45); cg.setLineCap(.round); cg.setLineJoin(.round)
            if name == "discover" {
                cg.strokeEllipse(in: CGRect(x: 2.75, y: 2.75, width: 19.5, height: 19.5))
                cg.move(to: CGPoint(x: 16.8, y: 8.2)); cg.addLine(to: CGPoint(x: 14.2, y: 14.2)); cg.addLine(to: CGPoint(x: 8.2, y: 16.8)); cg.addLine(to: CGPoint(x: 10.8, y: 10.8)); cg.closePath(); cg.strokePath()
            } else if name == "collections" {
                cg.move(to: CGPoint(x: 8, y: 3.5)); cg.addLine(to: CGPoint(x: 20, y: 3.5)); cg.addQuadCurve(to: CGPoint(x: 22, y: 5.5), control: CGPoint(x: 22, y: 3.5)); cg.addLine(to: CGPoint(x: 22, y: 17)); cg.strokePath()
                cg.addPath(UIBezierPath(roundedRect: CGRect(x: 3, y: 7, width: 15, height: 15), cornerRadius: 2.5).cgPath); cg.strokePath()
                cg.move(to: CGPoint(x: 7, y: 12)); cg.addLine(to: CGPoint(x: 14, y: 12)); cg.move(to: CGPoint(x: 7, y: 16)); cg.addLine(to: CGPoint(x: 11, y: 16)); cg.strokePath()
            } else {
                cg.move(to: CGPoint(x: 6, y: 22)); cg.addLine(to: CGPoint(x: 6, y: 5)); cg.addQuadCurve(to: CGPoint(x: 8, y: 3), control: CGPoint(x: 6, y: 3)); cg.addLine(to: CGPoint(x: 17, y: 3)); cg.addQuadCurve(to: CGPoint(x: 19, y: 5), control: CGPoint(x: 19, y: 3)); cg.addLine(to: CGPoint(x: 19, y: 22)); cg.addLine(to: CGPoint(x: 12.5, y: 17.5)); cg.closePath(); cg.strokePath()
            }
        }.withRenderingMode(.alwaysTemplate)
        return Image(uiImage: image)
    }
}
