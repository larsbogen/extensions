import Foundation

struct FocusRequestInbox {
    let directory: URL

    func consume(_ handle: (FocusRequest) -> Bool) {
        let files = FileManager.default
        let legacyURL = directory.appendingPathComponent("request.json")
        let legacyData = try? Data(contentsOf: legacyURL)
        let inbox = directory.appendingPathComponent("requests")
        let queued = ((try? files.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
            .compactMap { url -> (URL, FocusRequest)? in
                guard let data = try? Data(contentsOf: url),
                      let request = try? JSONDecoder().decode(FocusRequest.self, from: data) else { return nil }
                return (url, request)
            }

        func removeLegacyIfUnchanged() {
            // An older client may replace the file during handling; leave that
            // new command for the next pass rather than deleting it unseen.
            if let legacyData = legacyData, (try? Data(contentsOf: legacyURL)) == legacyData {
                try? files.removeItem(at: legacyURL)
            }
        }

        if !queued.isEmpty {
            for (url, request) in queued {
                // A pending modern command supersedes the leftover single-file
                // command. Never replay the legacy start after selecting a task.
                guard handle(request) else { break }
                // Only discard messages after the handler durably acknowledges
                // the command, and retire the legacy file before the queue file.
                removeLegacyIfUnchanged()
                try? files.removeItem(at: url)
            }
        } else if let data = legacyData,
                  let request = try? JSONDecoder().decode(FocusRequest.self, from: data), handle(request) {
            removeLegacyIfUnchanged()
        }
    }
}
