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
