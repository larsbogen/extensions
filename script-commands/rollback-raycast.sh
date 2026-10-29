#!/bin/bash
# @raycast.schemaVersion 1
# @raycast.title Tilbakestill siste oppdatering
# @raycast.mode fullOutput
# @raycast.packageName Raycast-oppsett
# @raycast.icon 🛠️
# Managed by PersonalRaycast
set -euo pipefail
base="$(cd -- "$(dirname -- "$0")/.." && pwd)"
exec "$base/bin/raycast-setup" rollback
