import AppKit
import CoreGraphics
// Original folded-page mark, rendered at full App Store resolution.
let size = 1024
let colorSpace = CGColorSpaceCreateDeviceRGB()
let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(red: 0.26, green: 0.31, blue: 0.24, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: size, height: size))
// Two opening pages; the quiet gap reads as a path into a collection.
context.setFillColor(CGColor(red: 0.94, green: 0.93, blue: 0.86, alpha: 1))
let left = CGMutablePath()
left.move(to: CGPoint(x: 255, y: 740))
left.addCurve(to: CGPoint(x: 482, y: 666), control1: CGPoint(x: 338, y: 750), control2: CGPoint(x: 432, y: 730))
left.addLine(to: CGPoint(x: 482, y: 258))
left.addCurve(to: CGPoint(x: 259, y: 337), control1: CGPoint(x: 425, y: 320), control2: CGPoint(x: 344, y: 348))
left.addQuadCurve(to: CGPoint(x: 235, y: 363), control: CGPoint(x: 235, y: 335))
left.addLine(to: CGPoint(x: 235, y: 714))
left.addQuadCurve(to: CGPoint(x: 255, y: 740), control: CGPoint(x: 235, y: 738))
context.addPath(left); context.fillPath()
let right = CGMutablePath()
right.move(to: CGPoint(x: 546, y: 665))
right.addCurve(to: CGPoint(x: 755, y: 784), control1: CGPoint(x: 607, y: 725), control2: CGPoint(x: 688, y: 770))
right.addQuadCurve(to: CGPoint(x: 785, y: 763), control: CGPoint(x: 785, y: 790))
right.addLine(to: CGPoint(x: 785, y: 414))
right.addQuadCurve(to: CGPoint(x: 761, y: 385), control: CGPoint(x: 785, y: 389))
right.addCurve(to: CGPoint(x: 546, y: 258), control1: CGPoint(x: 677, y: 374), control2: CGPoint(x: 607, y: 325))
right.closeSubpath(); context.addPath(right); context.fillPath()
let image = NSBitmapImageRep(cgImage: context.makeImage()!)
let output = CommandLine.arguments.dropFirst().first ?? "ios/Prompix/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png"
try image.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
