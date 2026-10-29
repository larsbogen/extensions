#!/bin/bash
# @raycast.schemaVersion 1
# @raycast.title Åpne Turatlas
# @raycast.mode silent
# @raycast.packageName Lokale nettsider
# @raycast.icon 🗺️
# @raycast.description Start eller gjenbruk den lokale tjenesten.
# Managed by PersonalRaycast
# Managed by Turatlas raycast:install
set -euo pipefail
base="$(cd -- "$(dirname -- "$0")/.." && pwd)"
exec "$base/bin/raycast-setup" launch atlas "$@"
