// Tiny CLI tool: renders a single emoji (or short emoji sequence) to a
// transparent PNG using AppKit's real text system, which correctly
// rasterizes Apple Color Emoji's sbix bitmap glyphs — something resvg
// (the SVG renderer the rest of the caption pipeline uses) cannot do at
// all (verified empirically: it silently renders nothing for emoji text).
//
// Usage: emoji-render <emoji-string> <output-path> <pixel-size>
// Compiled once ahead of time and bundled as an extraResource, exactly
// like the ffmpeg/yt-dlp binaries — end users never need Xcode installed.
import AppKit
import Foundation

let arguments = CommandLine.arguments
guard arguments.count == 4 else {
    FileHandle.standardError.write("Usage: emoji-render <emoji> <output.png> <size>\n".data(using: .utf8)!)
    exit(1)
}

let emoji = arguments[1]
let outputPath = arguments[2]
guard let size = Double(arguments[3]) else {
    FileHandle.standardError.write("Invalid size argument\n".data(using: .utf8)!)
    exit(1)
}

let canvasSize = NSSize(width: size, height: size)
let image = NSImage(size: canvasSize)

image.lockFocus()
NSGraphicsContext.current?.imageInterpolation = .high

let font = NSFont(name: "Apple Color Emoji", size: CGFloat(size * 0.83)) ?? NSFont.systemFont(ofSize: CGFloat(size))
let attributes: [NSAttributedString.Key: Any] = [.font: font]
let attributedString = NSAttributedString(string: emoji, attributes: attributes)
let stringSize = attributedString.size()

let drawPoint = NSPoint(
    x: (canvasSize.width - stringSize.width) / 2,
    y: (canvasSize.height - stringSize.height) / 2
)
attributedString.draw(at: drawPoint)

image.unlockFocus()

guard let tiffData = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiffData),
      let pngData = bitmap.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("Failed to rasterize emoji\n".data(using: .utf8)!)
    exit(1)
}

do {
    try pngData.write(to: URL(fileURLWithPath: outputPath))
} catch {
    FileHandle.standardError.write("Failed to write PNG: \(error)\n".data(using: .utf8)!)
    exit(1)
}
