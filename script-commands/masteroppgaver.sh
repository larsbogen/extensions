#!/bin/bash
# @raycast.schemaVersion 1
# @raycast.title Masteroppgaver
# @raycast.mode silent
# @raycast.packageName Lokale nettsider
# @raycast.icon 📚
# @raycast.description Start eller gjenbruk den lokale tjenesten.
# Managed by PersonalRaycast

set -euo pipefail
base="$(cd -- "$(dirname -- "$0")/.." && pwd)"
exec "$base/bin/raycast-setup" launch library "$@"
