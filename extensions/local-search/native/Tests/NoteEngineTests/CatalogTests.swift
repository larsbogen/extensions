import CoreGraphics
import Foundation
import PDFKit
import XCTest
@testable import NoteEngine

final class CatalogTests: XCTestCase {
    var temp: URL!
    var root: URL { temp.appendingPathComponent("import") }
    var store: URL { temp.appendingPathComponent("index") }
    let documentName = "Kommenterte/Emne 107.pdf"
    var export: URL { root.appendingPathComponent(documentName) }
    let fm = FileManager.default

    override func setUpWithError() throws {
        temp = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: export.deletingLastPathComponent(), withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try fm.removeItem(at: temp) }

    private func makePDF(pages: Int) throws {
        var box = CGRect(x: 0, y: 0, width: 250, height: 330)
        let context = try XCTUnwrap(CGContext(export as CFURL, mediaBox: &box, nil))
        for _ in 0..<pages {
            context.beginPDFPage(nil)
            context.setFillColor(gray: 0, alpha: 1)
            context.fill(CGRect(x: 10, y: 80, width: 40, height: 24))
            context.endPDFPage()
        }
        context.closePDF()
    }
    private func catalog() throws -> Catalog {
        try JSONDecoder().decode(Catalog.self, from: Data(contentsOf: store.appendingPathComponent("catalog.json")))
    }

    func testRefreshSkipsUnpairedFlatPagesReusesFingerprintsAndRemovesDeletedFiles() throws {
        try makePDF(pages: 2)
        let first = try indexNotes(root: root, store: store)
        XCTAssertEqual(first.indexed, 1)
        XCTAssertEqual(first.skipped.compactMap(\.page), [1, 2])
        XCTAssertTrue(try catalog().entries.isEmpty)
        XCTAssertEqual(try indexNotes(root: root, store: store).unchanged, 1)
        try makePDF(pages: 1)
        let changed = try indexNotes(root: root, store: store)
        XCTAssertEqual(changed.indexed, 1)
        XCTAssertEqual(changed.skipped.count, 1)
        try fm.removeItem(at: export)
        XCTAssertEqual(try indexNotes(root: root, store: store).removed, 1)
        XCTAssertTrue(try catalog().documents.isEmpty)
        XCTAssertTrue(try catalog().skipped.isEmpty)
    }

    func testMissingImportKeepsCatalogAndUpdateRepairsDamage() throws {
        try makePDF(pages: 1)
        _ = try indexNotes(root: root, store: store)
        let file = store.appendingPathComponent("catalog.json")
        let previous = try Data(contentsOf: file)
        XCTAssertThrowsError(try indexNotes(root: temp.appendingPathComponent("missing"), store: store))
        XCTAssertEqual(try Data(contentsOf: file), previous)
        try Data("{".utf8).write(to: file)
        XCTAssertEqual(try indexNotes(root: root, store: store).indexed, 1)
    }

    @MainActor func testOpensPhysicalSecondPageAtRegionAndRejectsModifiedPDF() throws {
        try makePDF(pages: 2)
        _ = try indexNotes(root: root, store: store)
        var current = try catalog()
        current.entries = [NoteEntry(id: "region", document: documentName, page: 2, ink: "MUR107",
            alternatives: [], uncertain: false, context: "", rect: [40, 120, 80, 15],
            preview: "previews/test.png", lines: [])]
        try JSONEncoder().encode(current).write(to: store.appendingPathComponent("catalog.json"))
        let target = try destination(root: root, store: store, id: "region")
        XCTAssertEqual(target.document.index(for: target.page), 1)
        XCTAssertEqual(target.rect, CGRect(x: 40, y: 120, width: 80, height: 15))
        let view = PDFView(frame: CGRect(x: 0, y: 0, width: 220, height: 160))
        view.displayMode = .singlePageContinuous
        target.show(in: view)
        XCTAssertEqual(view.currentPage, target.page)
        XCTAssertTrue(view.bounds.contains(view.convert(target.rect, from: target.page)))
        XCTAssertThrowsError(try destination(root: temp, store: store, id: "region"))
        try makePDF(pages: 1)
        XCTAssertThrowsError(try destination(root: root, store: store, id: "region"))
    }
}
