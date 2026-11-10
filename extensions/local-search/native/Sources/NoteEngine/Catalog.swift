import CryptoKit
import Darwin
import Foundation
import PDFKit

public struct NoteError: LocalizedError {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

public struct Skip: Codable {
    public let document: String
    public let page: Int?
    public let reason: String
}

public struct IndexReport: Codable {
    public var indexed = 0
    public var unchanged = 0
    public var removed = 0
    public var skipped: [Skip] = []
}

public struct NoteEntry: Codable {
    public let id: String
    public let document: String
    public let page: Int
    public let ink: String
    public let alternatives: [String]
    public let uncertain: Bool
    public let context: String
    public let rect: [Double]
    public let preview: String
    public let lines: [RecognizedInkLine]
}

struct LocatedInk: Codable {
    let page: Int
    let rect: [Double]
}

struct DocumentState: Codable {
    let source: String
    let original: String?
    let pages: Int
    let reusable: Bool
    let located: [LocatedInk]
}

public struct Catalog: Codable {
    public let version: Int
    let processor: String
    public let root: String
    var documents: [String: DocumentState] = [:]
    public var entries: [NoteEntry] = []
    public var skipped: [Skip] = []
}

private let fm = FileManager.default
// Bump when extraction, geometry, or recognition changes so unchanged PDFs are reprocessed.
private let processorVersion = "1|" + ProcessInfo.processInfo.operatingSystemVersionString

private func digest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func fileDigest(_ url: URL) throws -> String {
    let file = try FileHandle(forReadingFrom: url)
    defer { try? file.close() }
    var hash = SHA256()
    while let data = try file.read(upToCount: 256 * 1024), !data.isEmpty { hash.update(data: data) }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
}

private func canonical(_ url: URL) -> URL {
    url.standardizedFileURL.resolvingSymlinksInPath()
}

private func child(_ relative: String, of directory: URL) throws -> URL {
    let parts = relative.components(separatedBy: "/")
    guard !parts.contains(where: { $0 == ".." || $0 == "." || $0.isEmpty }) else {
        throw NoteError("Ugyldig relativ filsti.")
    }
    let url = directory.appendingPathComponent(relative).standardizedFileURL
    guard canonical(url).path == url.path else {
        throw NoteError("Symbolske lenker i filstien kan ikke brukes.")
    }
    return url
}

private func isDirectory(_ url: URL) -> Bool {
    var isDir: ObjCBool = false
    return fm.fileExists(atPath: url.path, isDirectory: &isDir) && isDir.boolValue
}

private func pdfFiles(in directory: URL, prefix: String) throws -> [String] {
    var paths: [String] = []
    let keys: Set<URLResourceKey> = [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey]
    for url in try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: Array(keys), options: [.skipsHiddenFiles]) {
        let values = try url.resourceValues(forKeys: keys)
        guard values.isSymbolicLink != true else { continue }
        let relative = prefix + "/" + url.lastPathComponent
        if values.isDirectory == true {
            paths += try pdfFiles(in: url, prefix: relative)
        } else if values.isRegularFile == true && url.pathExtension.lowercased() == "pdf" { paths.append(relative) }
    }
    return paths
}

private func readCatalog(_ store: URL) throws -> Catalog? {
    let file = try child("catalog.json", of: store)
    guard fm.fileExists(atPath: file.path) else { return nil }
    return try JSONDecoder().decode(Catalog.self, from: Data(contentsOf: file))
}

private func withWriteLock<T>(store: URL, _ body: () throws -> T) throws -> T {
    try fm.createDirectory(at: store, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let fd = open(try child("index.lock", of: store).path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw NoteError("Kunne ikke låse indeksmappen.") }
    defer { close(fd) }
    guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw NoteError("Indeksen oppdateres allerede.") }
    return try body()
}

private func tidyPreviews(_ base: URL, retaining entries: [NoteEntry]) {
    // Only generated directories directly under previews/ belong to this index.
    let live = Set(entries.compactMap { $0.preview.split(separator: "/").dropFirst().first.map(String.init) })
    for dir in (try? fm.contentsOfDirectory(at: base, includingPropertiesForKeys: nil)) ?? [] {
        guard UUID(uuidString: dir.lastPathComponent) != nil, !live.contains(dir.lastPathComponent) else { continue }
        try? fm.removeItem(at: dir)
    }
}

public func indexNotes(root rootURL: URL, store storeURL: URL) throws -> IndexReport {
    if (try? fm.destinationOfSymbolicLink(atPath: storeURL.path)) != nil {
        throw NoteError("Indeksmappen er en symbolsk lenke.")
    }
    let root = canonical(rootURL), store = canonical(storeURL)
    let kinds = ["Kommenterte", "Notatbøker"]
    var files: [String] = [], directories = 0
    for kind in kinds {
        let folder = try child(kind, of: root)
        if isDirectory(folder) { files += try pdfFiles(in: folder, prefix: kind); directories += 1 }
    }
    guard directories > 0 else { throw NoteError("Importmappen må inneholde Kommenterte eller Notatbøker.") }
    return try withWriteLock(store: store) {
        // A manual update is also the recovery path for an old or damaged catalog.
        let saved = try? readCatalog(store)
        let old = saved.flatMap { $0.version == 1 && $0.processor == processorVersion && $0.root == root.path ? $0 : nil }
        var catalog = Catalog(version: 1, processor: processorVersion, root: root.path)
        let existing = Dictionary(grouping: old?.entries ?? [], by: { $0.document })
        let skips = Dictionary(grouping: old?.skipped ?? [], by: { $0.document })
        let previews = try child("previews", of: store)
        var report = IndexReport()
        report.removed = Set(old?.documents.keys.map { $0 } ?? []).subtracting(files).count
        for name in files.sorted() {
            try autoreleasepool {
                let url = try child(name, of: root)
                let notebook = name.hasPrefix("Notatbøker/")
                let source: String, original: URL?, originalHash: String?, pageCount: Int
                do {
                    source = try fileDigest(url)
                    let paired = notebook ? nil : try child("Originaler/" + name.dropFirst("Kommenterte/".count), of: root)
                    original = paired.flatMap { fm.fileExists(atPath: $0.path) ? $0 : nil }
                    originalHash = try original.map(fileDigest)
                    if let record = old?.documents[name], record.reusable, record.source == source, record.original == originalHash,
                       (existing[name] ?? []).allSatisfy({ entry in
                           guard let path = try? child(entry.preview, of: store) else { return false }
                           return fm.fileExists(atPath: path.path)
                       }) {
                        catalog.documents[name] = record
                        catalog.entries += existing[name] ?? []
                        catalog.skipped += skips[name] ?? []
                        report.unchanged += 1
                        return
                    }
                    guard let doc = PDFDocument(url: url), !doc.isLocked, doc.pageCount > 0 else {
                        throw NoteError("PDF-en er låst, ugyldig eller tom.")
                    }
                    pageCount = doc.pageCount
                } catch {
                    catalog.skipped.append(Skip(document: name, page: nil, reason: error.localizedDescription))
                    return
                }

                // All previews from a replaced document can be removed as a group after the catalog commit.
                let generation = UUID().uuidString
                let relative = "previews/" + generation
                let directory = try child(relative, of: store)
                var entries: [NoteEntry] = [], warnings: [Skip] = []
                var retry = false, located: [LocatedInk] = []
                do {
                    try extractDocument(exportURL: url, originalURL: original, notebook: notebook, emit: { page in
                        let comments: [RecognizedComment]
                        do {
                            comments = try recognize(page) { regions in
                                for box in regions {
                                    located.append(LocatedInk(page: page.index + 1, rect: [box.minX, box.minY, box.width, box.height]))
                                }
                            }
                        } catch {
                            warnings.append(Skip(document: name, page: page.index + 1, reason: "Tekstgjenkjenning feilet: " + error.localizedDescription))
                            retry = true
                            return
                        }
                        if !comments.isEmpty && !isDirectory(directory) {
                            try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                        }
                        for (i, comment) in comments.enumerated() {
                            let id = digest(Data([name, source, originalHash ?? "", String(page.index), String(i)].joined(separator: "\0").utf8))
                            let filename = id + ".png"
                            try comment.preview.write(to: directory.appendingPathComponent(filename))
                            entries.append(NoteEntry(id: id, document: name, page: page.index + 1, ink: comment.ink,
                                alternatives: comment.alternatives, uncertain: comment.uncertain, context: comment.context,
                                rect: comment.rect, preview: relative + "/" + filename, lines: comment.lines))
                        }
                    }, skip: { index, reason in warnings.append(Skip(document: name, page: index + 1, reason: reason)) })
                    guard try fileDigest(url) == source, try original.map(fileDigest) == originalHash else {
                        throw NoteError("Filen ble endret under indeksering. Oppdater indeksen igjen.")
                    }
                    catalog.entries += entries
                    catalog.skipped += warnings
                    catalog.documents[name] = DocumentState(source: source, original: originalHash, pages: pageCount, reusable: !retry, located: located)
                    report.indexed += 1
                } catch {
                    catalog.skipped.append(Skip(document: name, page: nil, reason: error.localizedDescription))
                }
            }
        }
        let encoder = JSONEncoder()
        let data = try encoder.encode(catalog)
        try data.write(to: try child("catalog.json", of: store), options: .atomic)
        tidyPreviews(previews, retaining: catalog.entries)
        report.skipped = catalog.skipped
        return report
    }
}

public struct NoteDestination {
    public let document: PDFDocument
    public let page: PDFPage
    public let rect: CGRect
    public let title: String

    @MainActor public func show(in view: PDFView) {
        view.document = document
        view.layoutDocumentView()
        view.scaleFactor = max(view.scaleFactorForSizeToFit,
            min(2, (view.bounds.width - 60) / max(1, rect.width)))
        view.go(to: page)
        view.go(to: rect, on: page)
    }
}

public func destination(root: URL, store: URL, id: String) throws -> NoteDestination {
    let root = canonical(root), store = canonical(store)
    guard let catalog = try readCatalog(store), catalog.version == 1, catalog.root == root.path,
          let entry = catalog.entries.first(where: { $0.id == id }),
          ["Notatbøker", "Kommenterte"].contains(entry.document.split(separator: "/").first.map(String.init) ?? "") else {
        throw NoteError("Treffet er utgått. Oppdater indeksen.")
    }
    let file = try child(entry.document, of: root)
    let bytes = try Data(contentsOf: file)
    guard let record = catalog.documents[entry.document], digest(bytes) == record.source else {
        throw NoteError("PDF-en er endret. Oppdater indeksen før du åpner treffet.")
    }
    guard let doc = PDFDocument(data: bytes), entry.page > 0, entry.page <= doc.pageCount,
          let page = doc.page(at: entry.page - 1), entry.rect.count == 4, entry.rect.allSatisfy(\.isFinite) else {
        throw NoteError("Fant ikke siden til kommentaren.")
    }
    let values = entry.rect
    let rect = CGRect(x: values[0], y: values[1], width: values[2], height: values[3]).intersection(page.bounds(for: .cropBox))
    guard !rect.isNull, !rect.isEmpty else { throw NoteError("Fant ikke området til kommentaren.") }
    return NoteDestination(document: doc, page: page, rect: rect, title: file.lastPathComponent)
}
