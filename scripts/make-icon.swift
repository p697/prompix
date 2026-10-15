import AppKit
import CoreGraphics

// Original three-page identity, sharing the in-app mark's geometry and palette.
// Render full bleed; the OS supplies the icon's corner mask.
let size = 1024
let output = CommandLine.arguments.dropFirst().first ?? "ios/Prompix/Resources/Assets.xcassets/AppIcon.appiconset"
let directory = URL(fileURLWithPath: output, isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
let space = CGColorSpaceCreateDeviceRGB()
func color(_ rgb: UInt) -> CGColor {
    CGColor(red: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255, alpha: 1)
}
for variant in ["AppIcon", "AppIconDark", "AppIconTinted"] {
    let dark = variant != "AppIcon", tinted = variant == "AppIconTinted"
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                            space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    context.setFillColor(color(tinted ? 0x171717 : dark ? 0x171B19 : 0xF5F5F0))
    context.fill(CGRect(x: 0, y: 0, width: size, height: size))
    for index in 0..<3 {
        context.saveGState()
        context.translateBy(x: 512, y: 238)
        context.rotate(by: CGFloat(index - 1) * -29 * .pi / 180)
        let rect = CGRect(x: -160, y: 0, width: 320, height: 562)
        let path = CGPath(roundedRect: rect, cornerWidth: 40, cornerHeight: 40, transform: nil)
        context.saveGState()
        context.setShadow(offset: CGSize(width: 0, height: -6), blur: 20, color: CGColor(gray: 0, alpha: dark ? 0.22 : 0.08))
        context.setFillColor(color(tinted ? 0xCCCCCC : 0xCBD7EF)); context.addPath(path); context.fillPath()
        context.restoreGState()
        context.addPath(path); context.clip()
        let colors: [CGColor] = tinted ? [color(0xF8F8F8), color(UInt(0xB0B0B0 + index * 0x151515)), color(0x777777)] :
            [color(0xE2F2FA), color(index == 2 ? 0xDEABCC : 0xADC7F5), color(index == 0 ? 0x5278F0 : 0x927DDE), color(0x3B4DA6)]
        let stops: [CGFloat] = tinted ? [0, 0.5, 1] : [0, 0.35, 0.75, 1]
        let gradient = CGGradient(colorsSpace: space, colors: colors as CFArray, locations: stops)!
        context.drawLinearGradient(gradient, start: CGPoint(x: -160, y: 562), end: CGPoint(x: 160, y: 0), options: [])
        context.setStrokeColor(CGColor(gray: 1, alpha: dark ? 0.28 : 0.65))
        context.setLineWidth(2); context.addPath(path); context.strokePath()
        context.restoreGState()
    }
    let image = NSBitmapImageRep(cgImage: context.makeImage()!)
    try image.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent(variant + ".png"))
}
