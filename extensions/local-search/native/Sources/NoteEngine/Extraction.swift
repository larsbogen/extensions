import CoreGraphics
import Foundation
import PDFKit

public struct ExtractedTextLine {
    public let text: String
    /// Upright image pixels, measured from the top left.
    public let bounds: CGRect
}

public struct ExtractedPage {
    public let index: Int
    public let cropBox: CGRect
    public let rotation: Int
    public let composite: CGImage
    /// Only the detected ink. Black on white, in the same coordinates as composite.
    public let handwriting: CGImage
    public let regions: [CGRect]
    public let original: CGImage?
    public let printedLines: [ExtractedTextLine]
    public let rasterToPDF: CGAffineTransform

    public func pdfBounds(for raster: CGRect) -> CGRect {
        raster.applying(rasterToPDF).standardized.intersection(cropBox)
    }
}

private enum ExtractionError: LocalizedError {
    case invalidPDF, invalidPage, registration
    var errorDescription: String? {
        switch self {
        case .invalidPDF: return "PDF-en kunne ikke leses eller er låst."
        case .invalidPage: return "Siden kunne ikke gjengis."
        case .registration: return "Originalsiden kunne ikke justeres sikkert."
        }
    }
}

private func document(_ url: URL) throws -> PDFDocument {
    guard let doc = PDFDocument(url: url), !doc.isLocked, doc.pageCount > 0 else {
        throw ExtractionError.invalidPDF
    }
    return doc
}

private struct RasterGeometry {
    let width: Int, height: Int
    let pdfToCanvas: CGAffineTransform, pdfToRaster: CGAffineTransform

    init(_ page: CGPDFPage, longEdge: Int) throws {
        let box = page.getBoxRect(.cropBox).standardized
        guard !box.isEmpty, box.width.isFinite, box.height.isFinite else { throw ExtractionError.invalidPage }
        let r = (Int(page.rotationAngle) % 360 + 360) % 360
        let (w, h) = (r == 90 || r == 270) ? (box.height, box.width) : (box.width, box.height)
        let scale = Double(longEdge) / max(w, h)
        width = max(1, Int((w * scale).rounded()))
        height = max(1, Int((h * scale).rounded()))
        // Quartz limits its fit transform to the page's native size on some macOS releases.
        // Ask it only for rotation/crop translation, then scale explicitly to OCR resolution.
        let natural = CGRect(x: 0, y: 0, width: w, height: h)
        let fit = min(CGFloat(width) / w, CGFloat(height) / h)
        let scaleAndCenter = CGAffineTransform(a: fit, b: 0, c: 0, d: fit,
            tx: (CGFloat(width) - fit*w)/2, ty: (CGFloat(height) - fit*h)/2)
        pdfToCanvas = page.getDrawingTransform(.cropBox, rect: natural, rotate: 0, preserveAspectRatio: true)
            .concatenating(scaleAndCenter)
        pdfToRaster = pdfToCanvas.concatenating(CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: CGFloat(height)))
    }
}

private enum PageLayers { case all, inkAndBase, inkOnly, baseOnly }

private func isInk(_ annotation: PDFAnnotation) -> Bool {
    annotation.type?.trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased() == "ink"
}

private func render(_ page: PDFPage, geometry g: RasterGeometry, layers: PageLayers) throws -> CGImage {
    guard let ref = page.pageRef, let context = CGContext(data: nil, width: g.width, height: g.height,
        bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw ExtractionError.invalidPage }
    context.setFillColor(gray: 1, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: g.width, height: g.height))
    context.concatenate(g.pdfToCanvas)
    context.clip(to: ref.getBoxRect(.cropBox))
    if layers != .inkOnly { context.drawPDFPage(ref) }
    for note in page.annotations where note.shouldDisplay && (layers == .all || (layers != .baseOnly && isInk(note))) {
        context.saveGState()
        // PDFKit applies the crop and page rotation inside PDFAnnotation.draw.
        context.concatenate(page.transform(for: .cropBox).inverted())
        note.draw(with: .cropBox, in: context)
        context.restoreGState()
    }
    guard let image = context.makeImage() else { throw ExtractionError.invalidPage }
    return image
}

private struct Gray {
    let width: Int, height: Int
    var pixels: [UInt8]

    init(_ image: CGImage) throws {
        width = image.width
        height = image.height
        guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue),
              let bytes = ctx.data else { throw ExtractionError.invalidPage }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        pixels = Array(UnsafeBufferPointer(start: bytes.assumingMemoryBound(to: UInt8.self), count: width * height))
    }

    func image() throws -> CGImage {
        guard let provider = CGDataProvider(data: Data(pixels) as CFData),
              let result = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 8,
                bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue), provider: provider,
                decode: nil, shouldInterpolate: false, intent: .defaultIntent) else { throw ExtractionError.invalidPage }
        return result
    }

    func textMasked(_ lines: [ExtractedTextLine]) -> Gray {
        var erased = self
        for line in lines {
            let rect = line.bounds.insetBy(dx: -1, dy: -1).integral.intersection(CGRect(x: 0, y: 0, width: width, height: height))
            guard !rect.isEmpty else { continue }
            for y in Int(rect.minY)..<Int(rect.maxY) {
                let start = y * width + Int(rect.minX)
                let end = y * width + Int(rect.maxX)
                for i in start..<end { erased.pixels[i] = 255 }
            }
        }
        return erased
    }

    /// Occupied tiles connect nearby strokes without making distant margin comments one region.
    func regions() -> [CGRect] {
        let size = max(4, max(width, height) / 220)
        let cols = (width + size - 1) / size, rows = (height + size - 1) / size
        var occupied = [Bool](repeating: false, count: cols * rows)
        for y in 0..<height {
            for x in 0..<width where pixels[y * width + x] < 190 {
                occupied[(y / size) * cols + x / size] = true
            }
        }
        var result: [CGRect] = []
        for tile in occupied.indices where occupied[tile] {
            occupied[tile] = false
            var queue = [tile], pos = 0
            var x0 = cols, x1 = 0, y0 = rows, y1 = 0
            while pos < queue.count {
                let p = queue[pos], x = p % cols, y = p / cols
                pos += 1
                x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y)
                for yy in max(0, y-1)...min(rows-1, y+1) {
                    for xx in max(0, x-2)...min(cols-1, x+2) {
                        let near = yy * cols + xx
                        if occupied[near] { occupied[near] = false; queue.append(near) }
                    }
                }
            }
            let rect = CGRect(x: x0*size, y: y0*size, width: min(width, (x1+1)*size)-x0*size,
                              height: min(height, (y1+1)*size)-y0*size)
            result.append(rect)
        }
        return result
    }
}

private func textLines(_ page: PDFPage, transform: CGAffineTransform) -> [ExtractedTextLine] {
    guard let selection = page.selection(for: page.bounds(for: .cropBox)) else { return [] }
    return selection.selectionsByLine().compactMap { line in
        guard let text = line.string?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return ExtractedTextLine(text: text, bounds: line.bounds(for: page).applying(transform).standardized)
    }
}

private func textFingerprint(_ page: PDFPage) -> String {
    (page.string ?? "").precomposedStringWithCanonicalMapping.split(whereSeparator: { $0.isWhitespace }).joined()
}

private struct PointSample {
    let x: Double, y: Double, tone: Int
}

private struct Fingerprint {
    let bitmap: Gray
    let points: [PointSample]
    let blocks: [Float]
    let text: String
    let textBounds: CGRect

    init(_ page: PDFPage) throws {
        guard let ref = page.pageRef else { throw ExtractionError.invalidPage }
        let geometry = try RasterGeometry(ref, longEdge: 192)
        let bitmap = try Gray(render(page, geometry: geometry, layers: .inkAndBase))
        self.bitmap = bitmap
        text = textFingerprint(page)
        let normalized = CGAffineTransform(scaleX: 1/CGFloat(geometry.width), y: 1/CGFloat(geometry.height))
        textBounds = textLines(page, transform: geometry.pdfToRaster.concatenating(normalized))
            .reduce(CGRect.null) { $0.union($1.bounds) }
        var raw: [PointSample] = [], density = [Float](repeating: 0, count: 64)
        for y in 0..<bitmap.height {
            for x in 0..<bitmap.width {
                let tone = Int(bitmap.pixels[y * bitmap.width + x])
                guard tone < 240 else { continue }
                density[(y * 8 / bitmap.height) * 8 + x * 8 / bitmap.width] += Float(255 - tone)
                if tone <= 217 {
                    raw.append(PointSample(x: (Double(x)+0.5)/Double(bitmap.width),
                                           y: (Double(y)+0.5)/Double(bitmap.height), tone: tone))
                }
            }
        }
        let count = min(350, raw.count)
        points = (0..<count).map { raw[$0 * raw.count / count] }
        let sum = max(1, density.reduce(0, +))
        blocks = density.map { $0 / sum }
    }
}

/// Translate and uniformly scale normalized upright page coordinates about the center.
private struct Registration {
    var zoom: Double = 1, dx: Double = 0, dy: Double = 0
    func transform(source: Gray, target: Gray) -> CGAffineTransform {
        CGAffineTransform(a: zoom*Double(target.width)/Double(source.width), b: 0, c: 0,
            d: zoom*Double(target.height)/Double(source.height),
            tx: (0.5 - 0.5*zoom + dx)*Double(target.width), ty: (0.5 - 0.5*zoom + dy)*Double(target.height))
    }
}

private func agreement(_ source: [PointSample], _ target: Gray, _ reg: Registration) -> Double {
    let sx = reg.zoom*Double(target.width), sy = reg.zoom*Double(target.height)
    let tx = (0.5 - 0.5*reg.zoom + reg.dx)*Double(target.width), ty = (0.5 - 0.5*reg.zoom + reg.dy)*Double(target.height)
    var error = 0
    for p in source {
        let x = Int(floor(p.x*sx + tx)), y = Int(floor(p.y*sy + ty))
        guard x >= 0, x < target.width, y >= 0, y < target.height else { error += 255-p.tone; continue }
        // Extra ink is expected, but missing source ink is evidence of a mismatch.
        error += max(0, Int(target.pixels[y*target.width+x]) - p.tone)
    }
    return 1 - Double(error)/(Double(source.count)*160)
}

private func bestRegistration(_ source: [PointSample], target: Gray, near: Registration, step: Double, radius: Int)
    -> (Registration, Double) {
    var best = near, score = agreement(source, target, near)
    for zi in -radius...radius {
        for xi in -radius...radius {
            for yi in -radius...radius {
                let next = Registration(zoom: near.zoom + Double(zi)*step*2,
                                        dx: near.dx + Double(xi)*step, dy: near.dy + Double(yi)*step)
                let tested = agreement(source, target, next)
                if tested > score + 0.00005 { best = next; score = tested }
            }
        }
    }
    return (best, score)
}

private func findPage(_ export: Fingerprint, candidates: [(Int, Fingerprint)]) -> (Int, Registration)? {
    let ranked = candidates.compactMap { (index, src) -> (Int, Fingerprint, Float)? in
        guard src.points.count >= 16 else { return nil }
        // Even visually similar editions can differ in only one course code.
        if !src.text.isEmpty && !export.text.isEmpty && src.text != export.text { return nil }
        let distance = zip(src.blocks, export.blocks).reduce(Float(0)) { $0 + abs($1.0 - $1.1) }
        return (index, src, distance)
    }.sorted { $0.2 < $1.2 }
    var matches: [(Int, Registration, Double)] = []
    // Very many visually identical candidates are ambiguous before registration.
    if ranked.count > 8 && ranked[8].2 - ranked[0].2 < 0.04 { return nil }
    for (index, src, _) in ranked.prefix(8) {
        let matchedText = !src.text.isEmpty && src.text == export.text &&
            !src.textBounds.isEmpty && !export.textBounds.isEmpty
        if matchedText {
            let a = src.textBounds, b = export.textBounds
            let zoom = b.width / a.width
            let anchor = Registration(zoom: zoom,
                dx: b.midX - (a.midX - 0.5)*zoom - 0.5, dy: b.midY - (a.midY - 0.5)*zoom - 0.5)
            if (0.83...1.18).contains(zoom), abs(anchor.dx) <= 0.10, abs(anchor.dy) <= 0.10 {
                let score = agreement(src.points, export.bitmap, anchor)
                if score >= 0.78 {
                    matches.append((index, anchor, score))
                    continue
                }
            }
        }
        let near = agreement(src.points, export.bitmap, Registration()) > 0.995 ? Registration()
            : bestRegistration(src.points, target: export.bitmap, near: Registration(), step: 0.014, radius: 3).0
        let (reg, score) = bestRegistration(src.points, target: export.bitmap, near: near, step: 0.003, radius: 2)
        if score >= 0.84 { matches.append((index, reg, score)) }
    }
    matches.sort { $0.2 > $1.2 }
    guard let best = matches.first, matches.count == 1 || best.2 - matches[1].2 > 0.035 else { return nil }
    return (best.0, best.1)
}

private func registered(_ original: CGImage, source: Gray, target: Gray, initial: Registration) throws -> (Gray, CGAffineTransform) {
    var points: [PointSample] = []
    // Sample dark source strokes across the entire page for sub-thumbnail refinement.
    let stride = max(1, Int(sqrt(Double(source.width * source.height)/90000)))
    for y in Swift.stride(from: 0, to: source.height, by: stride) {
        for x in Swift.stride(from: 0, to: source.width, by: stride) {
            let tone = Int(source.pixels[y*source.width+x])
            if tone <= 155 {
                points.append(PointSample(x: (Double(x)+0.5)/Double(source.width), y: (Double(y)+0.5)/Double(source.height), tone: tone))
            }
        }
    }
    guard points.count >= 12 else { throw ExtractionError.registration }
    let count = min(900, points.count)
    let samples = (0..<count).map { points[$0 * points.count / count] }
    var reg = initial
    if agreement(samples, target, reg) < 0.995 {
        for step in [0.0025, 0.001, 0.0004, 0.00015] {
            reg = bestRegistration(samples, target: target, near: reg, step: step, radius: 2).0
        }
    }
    let mapping = reg.transform(source: source, target: target)
    guard let ctx = CGContext(data: nil, width: target.width, height: target.height, bitsPerComponent: 8, bytesPerRow: target.width,
                              space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { throw ExtractionError.invalidPage }
    ctx.setFillColor(gray: 1, alpha: 1)
    ctx.fill(CGRect(x: 0, y: 0, width: target.width, height: target.height))
    let canvasMapping = CGAffineTransform(a: mapping.a, b: 0, c: 0, d: mapping.d, tx: mapping.tx,
                                         ty: CGFloat(target.height) - mapping.ty - CGFloat(source.height)*mapping.d)
    ctx.concatenate(canvasMapping)
    ctx.draw(original, in: CGRect(x: 0, y: 0, width: source.width, height: source.height))
    guard let aligned = ctx.makeImage() else { throw ExtractionError.invalidPage }
    return (try Gray(aligned), mapping)
}

/// Min filter in a 3x3 window tolerates antialiasing after export/registration.
private func darkNeighbor(_ g: Gray) -> [UInt8] {
    let w = g.width, h = g.height
    var horizontal = g.pixels, output = g.pixels
    for y in 0..<h {
        for x in 0..<w {
            let i = y*w+x
            horizontal[i] = min(g.pixels[i], min(g.pixels[x > 0 ? i-1 : i], g.pixels[x+1 < w ? i+1 : i]))
        }
    }
    for y in 0..<h {
        for x in 0..<w {
            let i = y*w+x
            output[i] = min(horizontal[i], min(horizontal[y > 0 ? i-w : i], horizontal[y+1 < h ? i+w : i]))
        }
    }
    return output
}

private func newInk(_ inked: Gray, original: Gray) throws -> Gray {
    // Raster exports blur fonts differently from their vector sources. Allow a two-pixel
    // halo around original strokes, while the stricter reverse check still catches deletions.
    var halo = original
    halo.pixels = darkNeighbor(original)
    let reference = darkNeighbor(halo), comparison = darkNeighbor(inked)
    var mask = inked, sourceCount = 0, missing = 0
    let tileSize = max(12, max(inked.width, inked.height)/95)
    let columns = (inked.width+tileSize-1)/tileSize, rows = (inked.height+tileSize-1)/tileSize
    var tileTotal = [Int](repeating: 0, count: columns * rows), tileLost = tileTotal
    for y in 0..<inked.height {
        for x in 0..<inked.width {
            let i = y*inked.width+x, exp = Int(inked.pixels[i]), base = Int(original.pixels[i])
            if base < 175 {
                let tile = (y/tileSize)*columns + x/tileSize
                sourceCount += 1; tileTotal[tile] += 1
                if Int(comparison[i]) > base+70 { missing += 1; tileLost[tile] += 1 }
            }
            let contrast = Int(reference[i])-exp
            mask.pixels[i] = exp < 202 && contrast > 65 ? UInt8(max(0, 255-contrast*2)) : 255
        }
    }
    guard sourceCount >= 40, Double(missing)/Double(sourceCount) < 0.035,
          !tileTotal.indices.contains(where: { tileLost[$0] >= 15 && Double(tileLost[$0])/Double(tileTotal[$0]) > 0.23 })
    else { throw ExtractionError.registration }
    return mask
}

private func extractPage(_ page: PDFPage, index: Int, original: PDFDocument?, candidates: [(Int, Fingerprint)],
                         notebook: Bool) throws -> ExtractedPage? {
    guard let ref = page.pageRef else { throw ExtractionError.invalidPage }
    let g = try RasterGeometry(ref, longEdge: 2304)
    let composite = try render(page, geometry: g, layers: .all)
    var mask: Gray
    var clean: CGImage?
    var printed: [ExtractedTextLine] = []
    if let original {
        guard let (i, guess) = try findPage(Fingerprint(page), candidates: candidates),
              let basePage = original.page(at: i), let baseRef = basePage.pageRef else { throw ExtractionError.registration }
        let sourceGeometry = try RasterGeometry(baseRef, longEdge: 2304)
        let baseImage = try render(basePage, geometry: sourceGeometry, layers: .inkAndBase)
        let src = try Gray(baseImage)
        let target = try Gray(render(page, geometry: g, layers: .inkAndBase))
        let (aligned, mapping) = try registered(baseImage, source: src, target: target, initial: guess)
        mask = try newInk(target, original: aligned)
        printed = textLines(basePage, transform: sourceGeometry.pdfToRaster.concatenating(mapping))
        clean = try aligned.image()
    } else if notebook {
        let ink = try render(page, geometry: g, layers: .inkAndBase)
        mask = try Gray(ink).textMasked(textLines(page, transform: g.pdfToRaster))
    } else {
        guard page.annotations.contains(where: { isInk($0) && $0.shouldDisplay }) else { return nil }
        mask = try Gray(render(page, geometry: g, layers: .inkOnly))
        clean = try render(page, geometry: g, layers: .baseOnly)
        printed = textLines(page, transform: g.pdfToRaster)
    }
    let regions = mask.regions()
    return ExtractedPage(index: index, cropBox: ref.getBoxRect(.cropBox).standardized, rotation: Int(ref.rotationAngle),
        composite: composite, handwriting: try mask.image(), regions: regions, original: clean, printedLines: printed,
        rasterToPDF: g.pdfToRaster.inverted())
}

/// Streams each safely attributable page. A supplied original is authoritative: mismatches are skipped.
/// Errors thrown by the consumer are propagated, so the caller can roll back the staged index.
public func extractDocument(exportURL: URL, originalURL: URL?, notebook: Bool,
                            emit: (ExtractedPage) throws -> Void, skip: (Int, String) -> Void) throws {
    let exported = try document(exportURL), original = try originalURL.map(document)
    var candidates: [(Int, Fingerprint)] = []
    if let original {
        for i in 0..<original.pageCount {
            if let page = original.page(at: i), let fingerprint = try? autoreleasepool(invoking: { try Fingerprint(page) }) {
                candidates.append((i, fingerprint))
            }
        }
    }
    for index in 0..<exported.pageCount {
        try autoreleasepool {
            let result: ExtractedPage?
            do {
                guard let page = exported.page(at: index) else { throw ExtractionError.invalidPage }
                result = try extractPage(page, index: index, original: original, candidates: candidates, notebook: notebook)
            } catch { skip(index, error.localizedDescription); return }
            if let result {
                try emit(result)
            } else {
                skip(index, "Fant ingen egne pennestrøk. En flat PDF-side trenger en matchende original.")
            }
        }
    }
}
