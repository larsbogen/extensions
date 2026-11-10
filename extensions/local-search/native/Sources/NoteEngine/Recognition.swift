import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

public struct RecognizedInkLine: Codable {
    public let ink: String
    public let alternatives: [String]
    public let uncertain: Bool
    public let rect: [Double] // PDF page coordinates: x, y, width, height.
}

public struct RecognizedComment: Codable {
    public let ink: String
    public let alternatives: [String]
    public let uncertain: Bool
    public let context: String
    public let rect: [Double]
    public let preview: Data
    public let lines: [RecognizedInkLine]
}

struct Reading {
    let text: String
    let confidence: Float
}

struct ReadLine {
    let bounds: CGRect // Top-left raster coordinates in the provided image.
    let candidates: [Reading]
}

typealias TextReader = (CGImage, Bool) throws -> [ReadLine]

private enum RecognitionError: LocalizedError {
    case crop, png, vision(NSError)
    var errorDescription: String? {
        switch self {
        case .crop: return "Kunne ikke lese bildeutsnittet fra PDF-siden."
        case .png: return "Kunne ikke lage forhåndsvisningen av margnotatet."
        case .vision(let error):
            return "Apple Vision kunne ikke lese teksten (\(error.domain) \(error.code))."
        }
    }
}

private func visionRead(_ image: CGImage, correction: Bool) throws -> [ReadLine] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = correction
    do {
        let supported = try request.supportedRecognitionLanguages()
        let languages = ["nb-NO", "nn-NO", "no-NO", "en-US"].filter { supported.contains($0) }
        if !languages.isEmpty { request.recognitionLanguages = languages }
        request.minimumTextHeight = 0.002
        try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
    } catch {
        throw RecognitionError.vision(error as NSError)
    }
    return (request.results ?? []).compactMap { line in
        let bounds = line.boundingBox
        let box = CGRect(x: bounds.minX * CGFloat(image.width),
                         y: (1 - bounds.maxY) * CGFloat(image.height),
                         width: bounds.width * CGFloat(image.width),
                         height: bounds.height * CGFloat(image.height))
        let candidates = line.topCandidates(3).map { Reading(text: $0.string, confidence: $0.confidence) }
        return candidates.isEmpty ? nil : ReadLine(bounds: box, candidates: candidates)
    }
}

private func normalized(_ text: String) -> String {
    text.precomposedStringWithCanonicalMapping.lowercased().split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

private func yOverlap(_ a: CGRect, _ b: CGRect) -> CGFloat {
    max(0, min(a.maxY, b.maxY) - max(a.minY, b.minY))
}

private func xOverlap(_ a: CGRect, _ b: CGRect) -> CGFloat {
    max(0, min(a.maxX, b.maxX) - max(a.minX, b.minX))
}

private func xGap(_ a: CGRect, _ b: CGRect) -> CGFloat {
    max(0, max(a.minX, b.minX) - min(a.maxX, b.maxX))
}

private func yGap(_ a: CGRect, _ b: CGRect) -> CGFloat {
    max(0, max(a.minY, b.minY) - min(a.maxY, b.maxY))
}

// Group extraction blobs into writing lines, then adjacent lines into one comment.
// Join the original line boxes, so a bounding rectangle growing around an L-shaped
// comment cannot join an unrelated, distant note lying inside it.
private func cluster(_ boxes: [CGRect], linked: (CGRect, CGRect) -> Bool) -> [[Int]] {
    var parent = Array(boxes.indices)
    func root(_ index: Int) -> Int {
        var i = index
        while parent[i] != i {
            parent[i] = parent[parent[i]]
            i = parent[i]
        }
        return i
    }
    let ordered = boxes.indices.sorted { boxes[$0].minY < boxes[$1].minY }
    let maxHeight = boxes.map(\.height).max() ?? 0
    for (position, a) in ordered.enumerated() {
        for b in ordered.dropFirst(position + 1) {
            if boxes[b].minY > boxes[a].maxY + maxHeight { break }
            if linked(boxes[a], boxes[b]) {
                let ra = root(a)
                let rb = root(b)
                if ra != rb { parent[rb] = ra }
            }
        }
    }
    var groups = [Int: [Int]]()
    for i in boxes.indices { groups[root(i), default: []].append(i) }
    return groups.values.sorted { ($0.min() ?? 0) < ($1.min() ?? 0) }
}

func commentBoxes(_ seeds: [CGRect], within bounds: CGRect) -> [CGRect] {
    let blobs = seeds.map { $0.intersection(bounds) }.filter { !$0.isNull && !$0.isEmpty }
    let rows = cluster(blobs) { a, b in
        yOverlap(a, b) >= min(a.height, b.height) * 0.35 &&
        xGap(a, b) <= max(4, min(a.height, b.height) * 1.4)
    }.map { group in group.reduce(CGRect.null) { $0.union(blobs[$1]) } }
    return cluster(rows) { a, b in
        let h = min(a.height, b.height)
        return yGap(a, b) <= h * 0.65 &&
               (xOverlap(a, b) >= min(a.width, b.width) * 0.25 || abs(a.minX - b.minX) <= h * 0.4)
    }.map { group in group.reduce(CGRect.null) { $0.union(rows[$1]) } }
        .sorted { a, b in a.minY == b.minY ? a.minX < b.minX : a.minY < b.minY }
}

struct TextBlock {
    let text: String
    let bounds: CGRect
}

func printedParagraphs(_ lines: [TextBlock]) -> [TextBlock] {
    let lines = lines.filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !$0.bounds.isEmpty }
    let boxes = lines.map(\.bounds)
    return cluster(boxes) { a, b in
        let h = min(a.height, b.height)
        guard yOverlap(a, b) < h * 0.35,
              yGap(a, b) <= h * 0.65,
              max(a.height, b.height) <= 1.45 * h else { return false }
        return abs(a.minX - b.minX) <= h && xOverlap(a, b) >= min(a.width, b.width) * 0.6
    }.map { ids in
        let ordered = ids.sorted { boxes[$0].minY < boxes[$1].minY }
        return TextBlock(text: ordered.map { lines[$0].text }.joined(separator: " "),
                         bounds: ids.reduce(CGRect.null) { $0.union(boxes[$1]) })
    }
}

func adjacentParagraph(_ comment: CGRect, in paragraphs: [TextBlock], pageWidth: CGFloat) -> TextBlock? {
    let near = paragraphs.compactMap { paragraph -> (TextBlock, CGFloat)? in
        let box = paragraph.bounds
        guard yOverlap(box, comment) >= min(box.height, comment.height) * 0.3 else { return nil }
        let gap = xGap(box, comment)
        guard gap <= pageWidth * 0.18 else { return nil }
        return (paragraph, gap)
    }.sorted { $0.1 < $1.1 }
    guard let best = near.first else { return nil }
    // Adjacent lines spanning two paragraphs, or a note between two columns, have no unique referent.
    if near.count > 1 && near[1].1 - best.1 < max(4, pageWidth * 0.035) { return nil }
    return best.0
}

private func pdfRect(_ rect: CGRect, on page: ExtractedPage) -> [Double] {
    let box = page.pdfBounds(for: rect)
    return [Double(box.minX), Double(box.minY), Double(box.width), Double(box.height)]
}

private func sameLine(_ a: CGRect, _ b: CGRect) -> Bool {
    // A shared substring or a word in a neighboring line is not evidence of a competing reading.
    yOverlap(a, b) >= min(a.height, b.height) * 0.5 && xOverlap(a, b) >= max(a.width, b.width) * 0.58
}

private func usable(_ text: String) -> Bool {
    text.unicodeScalars.contains { CharacterSet.alphanumerics.contains($0) }
}

private func recognizedLine(_ read: ReadLine, comparedWith full: [ReadLine], page: ExtractedPage) -> RecognizedInkLine? {
    guard let top = read.candidates.first, usable(top.text) else { return nil }
    let best = normalized(top.text)
    var alternatives = [String]()
    var seen: Set<String> = [best]
    func add(_ candidate: String) {
        let key = normalized(candidate)
        if usable(candidate), seen.insert(key).inserted { alternatives.append(candidate) }
    }
    for alternative in read.candidates.dropFirst() where alternative.confidence >= top.confidence - 0.12 {
        add(alternative.text)
    }
    let other = full.filter { sameLine(read.bounds, $0.bounds) }
    for line in other { if let first = line.candidates.first { add(first.text) } }
    let agrees = other.contains { normalized($0.candidates.first?.text ?? "") == best }
    return RecognizedInkLine(ink: top.text, alternatives: alternatives,
                             uncertain: top.confidence < 0.75 || !alternatives.isEmpty || !agrees,
                             rect: pdfRect(read.bounds, on: page))
}

// Distinguish unreadable handwriting from a highlighter swipe, dash or circle.
// Used on the ink-only image. Counts oscillations in the top and bottom of
// the ink envelope and spaces between strokes at a bounded sampling size.
func writingShape(_ image: CGImage) -> Bool {
    let scale = min(1, 400 / CGFloat(max(image.width, image.height)))
    let w = max(1, Int(CGFloat(image.width) * scale)), h = max(1, Int(CGFloat(image.height) * scale))
    guard w >= 3, h >= 3 else { return false }
    var pixels = [UInt8](repeating: 255, count: w * h)
    let drew = pixels.withUnsafeMutableBytes { buf -> Bool in
        guard let cg = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8,
                                 bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0) else { return false }
        cg.interpolationQuality = .medium
        cg.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return true
    }
    guard drew else { return false }
    var high = [Int](), low = [Int](), islands = 0, previous = false, count = 0
    var minY = h, maxY = 0
    for x in 0..<w {
        var first = h, last = -1
        for y in 0..<h where pixels[y * w + x] < 205 {
            first = min(first, y); last = y; count += 1
        }
        if last >= 0 {
            minY = min(minY, first); maxY = max(maxY, last)
            high.append(first); low.append(last)
            if !previous { islands += 1 }
        }
        previous = last >= 0
    }
    let inkHeight = maxY - minY + 1
    guard inkHeight >= 3, !high.isEmpty,
          Double(count) / Double(inkHeight * high.count) < 0.83 else { return false }
    func turns(_ values: [Int]) -> Int {
        guard let first = values.first else { return 0 }
        let tolerance = max(2, inkHeight / 7)
        var direction = 0, extremum = first, changes = 0
        for v in values.dropFirst() {
            if direction >= 0 && v < extremum - tolerance {
                if direction > 0 { changes += 1 }; direction = -1; extremum = v
            } else if direction <= 0 && v > extremum + tolerance {
                if direction < 0 { changes += 1 }; direction = 1; extremum = v
            } else if (direction > 0 && v > extremum) || (direction < 0 && v < extremum) { extremum = v }
        }
        return changes
    }
    return islands >= 3 || turns(high) + turns(low) >= 4
}

private func preview(_ image: CGImage, _ bounds: CGRect) throws -> Data {
    guard let snippet = image.cropping(to: bounds.integral) else { throw RecognitionError.crop }
    let bytes = NSMutableData()
    guard let encoder = CGImageDestinationCreateWithData(bytes, UTType.png.identifier as CFString, 1, nil) else {
        throw RecognitionError.png
    }
    CGImageDestinationAddImage(encoder, snippet, nil)
    guard CGImageDestinationFinalize(encoder) else { throw RecognitionError.png }
    return bytes as Data
}

private func enlargedForReading(_ image: CGImage) throws -> CGImage {
    let scale = min(3, 160 / CGFloat(image.height), 2200 / CGFloat(image.width))
    guard scale >= 1.25 else { return image }
    let w = Int((CGFloat(image.width) * scale).rounded()), h = Int((CGFloat(image.height) * scale).rounded())
    guard let cg = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                             space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0) else { throw RecognitionError.crop }
    cg.interpolationQuality = .high
    cg.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    guard let enlarged = cg.makeImage() else { throw RecognitionError.crop }
    return enlarged
}

public func recognize(_ page: ExtractedPage, didLocate: ([CGRect]) -> Void = { _ in }) throws -> [RecognizedComment] {
    try recognize(page, read: visionRead, didLocate: didLocate)
}

func recognize(_ page: ExtractedPage, read: TextReader, didLocate: ([CGRect]) -> Void = { _ in }) throws -> [RecognizedComment] {
    let extent = CGRect(x: 0, y: 0, width: page.handwriting.width, height: page.handwriting.height)
    let comments = commentBoxes(page.regions, within: extent)
    didLocate(comments.map { page.pdfBounds(for: $0) })
    guard !comments.isEmpty else { return [] }
    // Both providers of searchable ink text see isolated strokes. Words on the printed
    // page can only enter the separate context field through a verified clean source.
    let full = try read(page.handwriting, true)
    var printed = page.printedLines.map { TextBlock(text: $0.text, bounds: $0.bounds) }
    if printed.isEmpty, let original = page.original {
        printed = try read(original, true).compactMap { row in
            row.candidates.first.map { TextBlock(text: $0.text, bounds: row.bounds) }
        }
    }
    let paragraphs = printedParagraphs(printed)
    return try comments.compactMap { comment in
        try autoreleasepool {
            let margin = max(4, min(20, comment.height * 0.17))
            let crop = comment.insetBy(dx: -margin, dy: -margin).integral.intersection(extent)
            guard let isolated = page.handwriting.cropping(to: crop) else { throw RecognitionError.crop }
            let nearby = full.filter { comment.contains(CGPoint(x: $0.bounds.midX, y: $0.bounds.midY)) }
            let enlarged = try enlargedForReading(isolated)
            let fromEnlarged = CGAffineTransform(scaleX: crop.width / CGFloat(enlarged.width),
                                                 y: crop.height / CGFloat(enlarged.height))
            let local = try read(enlarged, false).map { row in
                ReadLine(bounds: row.bounds.applying(fromEnlarged).offsetBy(dx: crop.minX, dy: crop.minY),
                         candidates: row.candidates)
            }.filter { comment.contains(CGPoint(x: $0.bounds.midX, y: $0.bounds.midY)) }
            var lines = local.compactMap { recognizedLine($0, comparedWith: nearby, page: page) }
            for missed in nearby where !local.contains(where: {
                xOverlap($0.bounds, missed.bounds) >= min($0.bounds.width, missed.bounds.width) * 0.5 &&
                yOverlap($0.bounds, missed.bounds) >= min($0.bounds.height, missed.bounds.height) * 0.5
            }) {
                if let line = recognizedLine(missed, comparedWith: [], page: page) { lines.append(line) }
            }
            let hasWords = lines.contains { $0.ink.filter { $0.isLetter || $0.isNumber }.count >= 2 }
            guard hasWords || writingShape(isolated) else { return nil }
            let context = adjacentParagraph(comment, in: paragraphs, pageWidth: extent.width)
            guard !lines.isEmpty || context != nil else { return nil }
            // Preserve reading order in the displayed page, also on rotated PDFs.
            func visualBounds(_ line: RecognizedInkLine) -> CGRect {
                CGRect(x: line.rect[0], y: line.rect[1], width: line.rect[2], height: line.rect[3])
                    .applying(page.rasterToPDF.inverted())
            }
            lines.sort {
                let a = visualBounds($0), b = visualBounds($1)
                if yOverlap(a,b) >= min(a.height, b.height) * 0.5 { return a.minX < b.minX }
                return a.minY < b.minY
            }
            let ink = lines.map(\.ink).joined(separator: " ")
            var alternatives = [String]()
            for (i, line) in lines.enumerated() {
                for alternative in line.alternatives.prefix(3) {
                    var words = lines.map(\.ink); words[i] = alternative
                    alternatives.append(words.joined(separator: " "))
                }
            }
            let display = (context?.bounds.union(comment) ?? comment.insetBy(dx: -extent.width * 0.07, dy: -margin))
                .insetBy(dx: -margin, dy: -margin).integral.intersection(extent)
            return RecognizedComment(ink: ink, alternatives: alternatives, uncertain: lines.isEmpty || lines.contains(where: \.uncertain),
                                     context: context?.text ?? "", rect: pdfRect(comment, on: page),
                                     preview: try preview(page.composite, display), lines: lines)
        }
    }
}
