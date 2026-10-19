#!/bin/bash

# @raycast.schemaVersion 1
# @raycast.title Masteroppgaver
# @raycast.mode silent
# @raycast.packageName Lokale nettsider
# @raycast.icon 📚
# @raycast.description Start og åpne det lokale biblioteket med masteroppgaver ved UiA og HiA.

set -euo pipefail

library_dir="$HOME/Masteroppgaver/bibliotek"

if [[ ! -f "$library_dir/control.py" ]]; then
  printf 'Finner ikke Masteroppgaver i %s\n' "$library_dir" >&2
  exit 1
fi

cd "$library_dir"
exec /usr/bin/python3 control.py start
