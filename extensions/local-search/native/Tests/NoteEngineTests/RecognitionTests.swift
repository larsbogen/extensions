import CoreGraphics
import Foundation
import ImageIO
import XCTest
@testable import NoteEngine

final class RecognitionTests: XCTestCase {
    private let ink = CGRect(x: 158, y: 45, width: 70, height: 13)
    private let paragraph = CGRect(x: 14, y: 44, width: 129, height: 14)

    private func image(w: Int = 260, h: Int = 140, _ paint: (CGContext) -> Void = { _ in }) -> CGImage {
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0)!
        ctx.setFillColor(gray: 1, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.translateBy(x: 0, y: CGFloat(h)); ctx.scaleBy(x: 1, y: -1)
        ctx.setFillColor(gray: 0, alpha: 1); ctx.setStrokeColor(gray: 0, alpha: 1)
        paint(ctx)
        return ctx.makeImage()!
    }

    private func page(printed: [ExtractedTextLine], mask: CGImage? = nil) -> ExtractedPage {
        let writing = mask ?? image {
            for i in 0..<7 {
                $0.fill(CGRect(x: 159 + i * 9, y: 45 + i % 3, width: 3, height: 9 - i % 3))
                $0.fill(CGRect(x: 160 + i * 9, y: 52, width: 6, height: 2))
            }
        }
        let composite = image {
            $0.setFillColor(gray: 0.3, alpha: 1); $0.fill(self.paragraph)
            $0.setFillColor(gray: 0, alpha: 1); $0.fill(self.ink)
        }
        return ExtractedPage(index: 2, cropBox: CGRect(x: 20, y: 30, width: 260, height: 140), rotation: 0,
                             composite: composite, handwriting: writing, regions: [ink], original: nil,
                             printedLines: printed, rasterToPDF: CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 20, ty: 170))
    }

    private func reader(whole: String, crop: String) -> TextReader {
        // Set bounds relative to the OCR image (including crop padding and upsampling).
        { [ink] image, full in
            let rect: CGRect
            if full { rect = ink }
            else {
                let scaleX = CGFloat(image.width) / (ink.width + 8)
                let scaleY = CGFloat(image.height) / (ink.height + 8)
                rect = CGRect(x: 4, y: 4, width: ink.width, height: ink.height)
                    .applying(CGAffineTransform(scaleX: scaleX, y: scaleY))
            }
            return [ReadLine(bounds: rect, candidates: [Reading(text: full ? whole : crop, confidence: 0.98)])]
        }
    }

    func testConflictingDigitsPreserveOriginalReadingAlternativeBoxAndContext() throws {
        let fixture = page(printed: [ExtractedTextLine(text: "Trykt emnekode MUR103", bounds: paragraph)])
        let comment = try XCTUnwrap(recognize(fixture, read: reader(whole: "MUR101", crop: "MUR107")).first)
        XCTAssertEqual(comment.ink, "MUR107")
        XCTAssertEqual(comment.alternatives, ["MUR101"])
        XCTAssertTrue(comment.uncertain)
        XCTAssertEqual(comment.context, "Trykt emnekode MUR103")
        XCTAssertEqual(comment.rect, [178, 112, 70, 13])
        XCTAssertEqual(comment.lines.first?.rect, comment.rect)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(comment.preview as CFData, nil))
        let preview = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        XCTAssertGreaterThan(preview.width, Int(comment.rect[2] + paragraph.width))
        XCTAssertLessThan(preview.height, fixture.composite.height)
    }

    func testAgreedLiteralCodeAndAmbiguousNeighbors() throws {
        let page = page(printed: [
            ExtractedTextLine(text: "Avsnitt over", bounds: CGRect(x: 50, y: 26, width: 95, height: 23)),
            ExtractedTextLine(text: "Avsnitt under", bounds: CGRect(x: 95, y: 52, width: 51, height: 20))
        ])
        let comment = try XCTUnwrap(recognize(page, read: reader(whole: "MUR107", crop: "MUR107")).first)
        XCTAssertFalse(comment.uncertain)
        XCTAssertTrue(comment.alternatives.isEmpty)
        XCTAssertEqual(comment.context, "")
    }

    func testUnreadableInkCanBeFoundViaUniqueNeighborButUnderlineCannot() throws {
        let printed = [ExtractedTextLine(text: "Ekstern sensor", bounds: paragraph)]
        let comments = try recognize(page(printed: printed), read: { _, _ in [] })
        XCTAssertEqual(comments.count, 1)
        let comment = try XCTUnwrap(comments.first)
        XCTAssertEqual(comment.context, "Ekstern sensor")
        XCTAssertEqual(comment.ink, "")
        XCTAssertTrue(comment.uncertain)
        let underline = image { $0.fill(CGRect(x: self.ink.minX, y: self.ink.midY, width: self.ink.width, height: 2)) }
        XCTAssertTrue(try recognize(page(printed: printed, mask: underline), read: { _, _ in [] }).isEmpty)
    }

    func testVisionFailurePropagates() {
        enum MockFailure: Error { case vision }
        XCTAssertThrowsError(try recognize(page(printed: []), read: { _, _ in throw MockFailure.vision }))
    }

    func testGroupOneMultilineMarginNoteAndKeepOtherColumnsAndDistantRowsSeparate() {
        let extent = CGRect(x: 0, y: 0, width: 400, height: 300)
        let left = CGRect(x: 12, y: 25, width: 40, height: 10)
        let word = CGRect(x: 57, y: 25, width: 32, height: 10)
        let next = CGRect(x: 13, y: 39, width: 42, height: 10)
        let other = CGRect(x: 179, y: 30, width: 36, height: 10)
        let bottom = CGRect(x: 12, y: 116, width: 48, height: 12)
        XCTAssertEqual(commentBoxes([bottom, other, left, word, next], within: extent),
                       [left.union(word).union(next), other, bottom])
    }
}
