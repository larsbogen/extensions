# reMarkable folder creation dependency

The daily-plan command uses the locally installed `rm2` from
`~/Documents/Remarkable CLI`. This checkout already supplies the version-1 app
JSON protocol used for folder selection. Folder creation extends that protocol:

```sh
rm2 cloud capabilities --json
rm2 cloud mkdir 'Dagsplaner' --app-json
# Optional CLI-only parent selection:
rm2 cloud mkdir 'Dagsplaner' --parent '<canonical-folder-UUID>' --app-json
```

The second and third commands create or reuse a Cloud folder. Raycast performs
creation only when the user submits **Opprett og velg mappe**. Its form creates
folders at the root of **Mine filer**. Web authentication is required:
`rm2 cloud web-login`. PDF uploading continues to use the separate upload login.

## Companion change

[rm2-cloud-mkdir.patch](rm2-cloud-mkdir.patch) contains only the folder changes
and mocked tests added to the local CLI checkout on 2026-09-24. They are already
applied to the editable local installation. The patch intentionally excludes
unrelated work already present in that checkout. It depends on the existing
`CloudOperationError`, `canonical_document_id`, `app_cloud_item` and app JSON
protocol implementation; it is not a standalone patch for an older CLI release.

For another compatible checkout, check before applying (do not apply again to
the current installation):

```sh
git apply --check /absolute/path/to/rm2-cloud-mkdir.patch
git apply /absolute/path/to/rm2-cloud-mkdir.patch
PYTHONPATH=src python3 -m pytest -q
python3 -m py_compile src/remarkable_cli/cli.py src/remarkable_cli/cloud.py
```

Raycast checks for `create_folder` in the version-1 capabilities response before
attempting the operation, and gives upgrade guidance if it is unavailable.

## API contract and duplicate prevention

The request matches reMarkable's public [My files web client](https://my.remarkable.com/myfiles)
inspected on 2026-09-24 (`vendor-DtU9GNvd.js`, `P6.createFolder`):

- POST to the authenticated regional web API's `/doc/v2/files`.
- `Content-Type: folder`, empty body, `rm-source: WebLibrary`.
- Base64 JSON in `rm-meta`: `file_name` and canonical `parent` UUID (empty at root).
- Accept a confirmed `docID` UUID; the optional `hash` is the read-side identifier.

This is the web client's API contract, not a documented public SDK guarantee.
No legacy service-manager API or direct sync-manifest writes are used.

The CLI first reads fresh folder metadata, validates an optional parent, and
reuses a unique case-insensitive name match in that parent. A POST is attempted
once. Network failures, 5xx responses and success responses lacking a valid ID
are reported as uncertain; tokens and response bodies are not emitted in app
JSON. Raycast persists an uncertainty marker before starting the command and
blocks another write for that name until a fresh listing resolves it.

Tests use mocked HTTP/process responses. They cover the request contract, parent
UUID versus read hash, reuse, validation, authentication, uncertain outcomes,
process interruption and concurrent calls. No test creates real Cloud folders.

## Fresh Cloud state correction

The web file-list endpoint was observed returning an older index even after
successful folder creation and PDF upload. The documents and folder were present
in the live regional sync root. `rm2 cloud list --fresh --app-json` now reconciles
the web response with a read-only `/sync/v3/root` and its content-addressed indices.
Metadata is reused only when its hash matches. Changed or new entries are read
from storage; removed entries are excluded. A second root read rejects a changing
snapshot instead of returning stale results. Both v3 and v4 index formats are
supported; no sync files are written.

This requires both existing logins on the same account. `cloud mkdir` uses the
fresh view before checking for name collisions. Upload sessions now honor JWT
expiration with a short safety margin instead of a fixed 23-hour cache window.

Apply [rm2-fresh-cloud-state.patch](rm2-fresh-cloud-state.patch) after the folder
patch on a compatible checkout. Both are already applied to the local editable
installation. Live verification read the created folder and the two existing
uploads from sync storage; it did not repeat those PDF uploads.
