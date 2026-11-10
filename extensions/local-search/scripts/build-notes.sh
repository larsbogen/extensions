#!/bin/sh
set -eu
project=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
work="$project/work/remarkable-notes-build"
mkdir -p "$work"
export CLANG_MODULE_CACHE_PATH="$work/modules"
export SWIFTPM_MODULECACHE_OVERRIDE="$work/modules"
run_swift() {
  subcommand="$1"
  shift
  /usr/bin/xcrun swift "$subcommand" --package-path "$project/native" --scratch-path "$work/products" \
    --cache-path "$work/cache" --config-path "$work/config" --security-path "$work/security" \
    --disable-sandbox --jobs 1 -debug-info-format none "$@"
}
if [ "${1:-}" = test ]; then
  shift
  run_swift test "$@"
else
  run_swift build -c release --product remarkable-notes
  bin_dir=$(run_swift build -c release --show-bin-path)
  install -m 755 "$bin_dir/remarkable-notes" "$project/assets/remarkable-notes.new"
  mv -f "$project/assets/remarkable-notes.new" "$project/assets/remarkable-notes"
fi
