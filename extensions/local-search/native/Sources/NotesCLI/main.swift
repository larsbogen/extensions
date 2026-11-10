import AppKit
import Foundation
import NoteEngine
import PDFKit

final class NoteReader: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let target: NoteDestination
    private var window: NSWindow?

    init(_ target: NoteDestination) { self.target = target }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let pdfView = PDFView(frame: NSRect(x: 0, y: 0, width: 880, height: 760))
        pdfView.displayMode = .singlePageContinuous
        pdfView.displaysPageBreaks = true
        let window = NSWindow(contentRect: pdfView.frame, styleMask: [.titled, .closable, .resizable, .miniaturizable],
                              backing: .buffered, defer: false)
        window.contentView = pdfView
        window.title = target.title
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        self.window = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        target.show(in: pdfView)
        FileHandle.standardOutput.write(Data("READY\n".utf8))
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

func run(_ args: [String]) throws {
    let usage = "Bruk: remarkable-notes index --root MAPPE --store MAPPE | open --root MAPPE --store MAPPE --id TREFF"
    guard let command = args.first, ["index", "open"].contains(command) else { throw NoteError(usage) }
    let expected = command == "open" ? ["--root", "--store", "--id"] : ["--root", "--store"]
    var options: [String: String] = [:]
    var it = args.dropFirst().makeIterator()
    while let flag = it.next() {
        guard expected.contains(flag), options[flag] == nil, let value = it.next(), !value.isEmpty else { throw NoteError(usage) }
        options[flag] = value
    }
    guard options.count == expected.count, let rootPath = options["--root"], rootPath.hasPrefix("/"),
          let storePath = options["--store"], storePath.hasPrefix("/") else { throw NoteError(usage) }
    let root = URL(fileURLWithPath: rootPath, isDirectory: true), store = URL(fileURLWithPath: storePath, isDirectory: true)
    if command == "index" {
        let report = try indexNotes(root: root, store: store)
        FileHandle.standardOutput.write(try JSONEncoder().encode(report))
        return
    }
    let target = try destination(root: root, store: store, id: options["--id"]!)
    let app = NSApplication.shared
    let reader = NoteReader(target)
    app.setActivationPolicy(.regular)
    app.delegate = reader
    withExtendedLifetime(reader) { app.run() }
}

do { try run(Array(CommandLine.arguments.dropFirst())) }
catch {
    FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
    exit(EXIT_FAILURE)
}
