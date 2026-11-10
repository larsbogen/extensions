import AppKit
import CoreGraphics
import CoreText
import PDFKit
import XCTest
@testable import NoteEngine

final class ExtractionTests: XCTestCase {
    private var dir: URL!
    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("rm-extraction-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: dir) }

    private struct Sheet {
        var code: String
        var ink = false
        var shiftX = 0.0, shiftY = 0.0
    }
    private func pdf(_ name: String, _ sheets: [Sheet]) throws -> URL {
        let url = dir.appendingPathComponent(name)
        var media = CGRect(x: 0, y: 0, width: 360, height: 500)
        let ctx = try XCTUnwrap(CGContext(url as CFURL, mediaBox: &media, nil))
        let font = CTFontCreateWithName("Helvetica" as CFString, 12, nil)
        for sheet in sheets {
            ctx.beginPDFPage(nil)
            ctx.saveGState()
            ctx.translateBy(x: sheet.shiftX, y: sheet.shiftY)
            let lines = [sheet.code, "Kontekst for merknaden", "Avsnitt med vanlige fagord", "Nok en trykt tekstlinje"]
            for (row, string) in lines.enumerated() {
                let line = CTLineCreateWithAttributedString(NSAttributedString(string: string, attributes: [.font: font]))
                ctx.textPosition = CGPoint(x: 28, y: 375-row*23)
                CTLineDraw(line, ctx)
            }
            ctx.restoreGState()
            if sheet.ink {
                ctx.setStrokeColor(gray: 0, alpha: 1)
                ctx.setLineWidth(2)
                ctx.move(to: CGPoint(x: 243, y: 345))
                ctx.addCurve(to: CGPoint(x: 290, y: 354), control1: CGPoint(x: 255, y: 370), control2: CGPoint(x: 263, y: 323))
                ctx.strokePath()
            }
            ctx.endPDFPage()
        }
        ctx.closePDF()
        return url
    }
    /// Mimic an exporter that bakes every glyph into pixels and drops the PDF text layer.
    private func rasterized(_ source: URL, _ name: String) throws -> URL {
        let document = try XCTUnwrap(CGPDFDocument(source as CFURL))
        let page = try XCTUnwrap(document.page(at: 1))
        var box = page.getBoxRect(.mediaBox)
        let context = try XCTUnwrap(CGContext(data: nil, width: Int(box.width*3), height: Int(box.height*3),
            bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue))
        context.scaleBy(x: 3, y: 3)
        context.setFillColor(gray: 1, alpha: 1)
        context.fill(box)
        context.drawPDFPage(page)
        let image = try XCTUnwrap(context.makeImage())
        let url = dir.appendingPathComponent(name)
        let pdf = try XCTUnwrap(CGContext(url as CFURL, mediaBox: &box, nil))
        pdf.beginPDFPage(nil)
        pdf.draw(image, in: box)
        pdf.endPDFPage()
        pdf.closePDF()
        return url
    }
    private func attachInk(_ source: URL, _ name: String, rotate: Bool = false) throws -> URL {
        let doc = try XCTUnwrap(PDFDocument(url: source))
        let page = try XCTUnwrap(doc.page(at: 0))
        let bounds = CGRect(x: 233, y: 330, width: 68, height: 47)
        let ink = PDFAnnotation(bounds: bounds, forType: .ink, withProperties: nil)
        let line = NSBezierPath()
        line.move(to: CGPoint(x: 4, y: 12))
        line.line(to: CGPoint(x: 22, y: 30))
        line.line(to: CGPoint(x: 44, y: 8))
        ink.add(line)
        ink.color = .black
        let border = PDFBorder()
        border.lineWidth = 2
        ink.border = border
        page.addAnnotation(ink)
        if rotate {
            page.setBounds(CGRect(x: 10, y: 18, width: 320, height: 450), for: .cropBox)
            page.rotation = 90
        }
        let url = dir.appendingPathComponent(name)
        XCTAssertTrue(doc.write(to: url))
        return url
    }
    private func run(_ source: URL, _ original: URL? = nil, notebook: Bool = false) throws -> ([ExtractedPage], [Int]) {
        var pages: [ExtractedPage] = [], skipped: [Int] = []
        try extractDocument(exportURL: source, originalURL: original, notebook: notebook,
                            emit: { pages.append($0) }, skip: { i, _ in skipped.append(i) })
        return (pages, skipped)
    }

    func testExplicitInkRespectsCropRotationAndIgnoresPrintedText() throws {
        let plain = try pdf("plain.pdf", [Sheet(code: "MUR107")])
        let marked = try attachInk(plain, "marked.pdf", rotate: true)
        let (pages, skipped) = try run(marked)
        XCTAssertEqual(skipped, [])
        let page = try XCTUnwrap(pages.first)
        XCTAssertEqual(page.rotation, 90)
        XCTAssertGreaterThan(page.composite.width, page.composite.height)
        XCTAssertTrue(page.printedLines.contains { $0.text.contains("MUR107") })
        XCTAssertNotNil(page.original)
        let box = try XCTUnwrap(page.regions.first).applying(page.rasterToPDF).standardized
        XCTAssertTrue(CGRect(x: 228, y: 325, width: 80, height: 60).contains(box), "\(box)")
    }

    func testFlattenedDifferencePairsByContentAcrossInsertedPageAndComparesSameVersion() throws {
        let base = try pdf("base.pdf", [Sheet(code: "MUR101"), Sheet(code: "MUR107")])
        let marked = try pdf("export.pdf", [Sheet(code: "MUR101"), Sheet(code: "MUR108"),
                                           Sheet(code: "MUR107", ink: true, shiftX: 3, shiftY: -2)])
        let (pages, skipped) = try run(marked, base)
        XCTAssertEqual(skipped, [1])
        XCTAssertEqual(pages.map(\.index), [0, 2])
        XCTAssertEqual(pages.first?.regions.count, 0)
        let page = try XCTUnwrap(pages.last)
        XCTAssertTrue(page.printedLines.contains { $0.text.contains("MUR107") })
        XCTAssertFalse(page.regions.isEmpty)
        for region in page.regions {
            XCTAssertTrue(CGRect(x: 232, y: 325, width: 72, height: 53).contains(page.pdfBounds(for: region)),
                          "Printed material leaked into mask at \(page.pdfBounds(for: region))")
        }
    }

    func testRasterExportRetainsMarginButRejectsChangedPrintedDigit() throws {
        let base = try pdf("base.pdf", [Sheet(code: "MUR101")])
        let annotated = try pdf("annotated.pdf", [Sheet(code: "MUR101", ink: true)])
        let good = try rasterized(annotated, "rendered.pdf")
        let (pages, skipped) = try run(good, base)
        XCTAssertEqual(skipped, [])
        let page = try XCTUnwrap(pages.first)
        XCTAssertFalse(page.regions.isEmpty)
        XCTAssertTrue(page.regions.allSatisfy { page.pdfBounds(for: $0).minX > 230 })
        let wrong = try pdf("wrong.pdf", [Sheet(code: "MUR107", ink: true)])
        let wrongRendered = try rasterized(wrong, "wrong-rendered.pdf")
        XCTAssertEqual(try run(wrongRendered, base).1, [0])
    }

    func testRejectsUnpairedFlattenedAndAmbiguousRepeatedOriginalPages() throws {
        let annotated = try pdf("flat.pdf", [Sheet(code: "MUR101", ink: true)])
        XCTAssertEqual(try run(annotated).1, [0])
        let duplicate = try pdf("dup.pdf", [Sheet(code: "MUR101"), Sheet(code: "MUR101")])
        XCTAssertEqual(try run(annotated, duplicate).1, [0])
    }

    func testNotebookIgnoresEmbeddedPrintedLinesAndConsumerErrorPropagates() throws {
        let annotated = try pdf("notes.pdf", [Sheet(code: "MUR101", ink: true)])
        let (pages, skipped) = try run(annotated, notebook: true)
        XCTAssertTrue(skipped.isEmpty)
        let page = try XCTUnwrap(pages.first)
        XCTAssertFalse(page.regions.isEmpty)
        XCTAssertTrue(page.regions.allSatisfy { page.pdfBounds(for: $0).minX > 220 })
        enum StagedFailure: Error { case write }
        XCTAssertThrowsError(try extractDocument(exportURL: annotated, originalURL: nil, notebook: true,
                                                emit: { _ in throw StagedFailure.write },
                                                skip: { _,_ in XCTFail("Consumer failed; must abort") })) {
            XCTAssertTrue($0 is StagedFailure)
        }
    }

    func testIgnoresUnchangedNativeInkAlreadyInOriginal() throws {
        let base = try pdf("base.pdf", [Sheet(code: "MUR107")])
        let premarked = try attachInk(base, "shared.pdf")
        let (pages, skipped) = try run(premarked, premarked)
        XCTAssertEqual(skipped, [])
        XCTAssertEqual(pages.first?.regions.count, 0)
    }
}
