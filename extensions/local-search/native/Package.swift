// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "RemarkableNoteSearch",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "remarkable-notes", targets: ["NotesCLI"])],
    targets: [
        .target(name: "NoteEngine"),
        .executableTarget(name: "NotesCLI", dependencies: ["NoteEngine"]),
        .testTarget(name: "NoteEngineTests", dependencies: ["NoteEngine"])
    ]
)
