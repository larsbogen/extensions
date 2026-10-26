#!/bin/bash

# @raycast.schemaVersion 1
# @raycast.title Åpne Turatlas
# @raycast.mode silent
# @raycast.packageName Lokale nettsider
# @raycast.icon 🗺️
# @raycast.description Start eller gjenbruk Turatlas og åpne det lokale atlaset.
# Managed by Turatlas raycast:install

set -euo pipefail
project_dir='/Users/lmboge01/Strava'
node_binary='/opt/homebrew/bin/node'

if [[ ! -x "$node_binary" ]]; then
  printf 'Finner ikke Node. Kjør Raycast-installasjonen for Turatlas igjen.\n' >&2
  exit 1
fi
if [[ ! -f "$project_dir/scripts/atlas-control.ts" ]]; then
  printf 'Finner ikke Turatlas-prosjektet i %s\n' "$project_dir" >&2
  exit 1
fi
if [[ ! -f "$project_dir/node_modules/tsx/package.json" ]]; then
  printf 'Turatlas mangler avhengigheter. Kjør npm ci og npm run build i prosjektmappen.\n' >&2
  exit 1
fi
cd "$project_dir"
"$node_binary" -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("Turatlas trenger Node 24 eller nyere."); process.exit(1); }'
exec "$node_binary" --import tsx scripts/atlas-control.ts start "$@"
