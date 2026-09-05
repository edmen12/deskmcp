#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

[[ "$(uname -s)" == "Darwin" ]] || { echo "macOS process host requires Darwin" >&2; exit 2; }

MACHINE="$(uname -m)"
case "$MACHINE" in
  arm64) TARGET="darwin-arm64" ;;
  x86_64) TARGET="darwin-x64" ;;
  *) echo "Unsupported macOS architecture: $MACHINE" >&2; exit 2 ;;
esac

SOURCE="$PROJECT_ROOT/process-host/macos/DeskMCPProcessHost.c"
OUTPUT="${1:-$PROJECT_ROOT/runtime/process-host/$TARGET/DeskMCPProcessHost}"
mkdir -p "$(dirname "$OUTPUT")"

xcrun clang \
  -O2 \
  -std=c11 \
  -Wall -Wextra -Werror \
  -mmacosx-version-min=13.0 \
  "$SOURCE" \
  -o "$OUTPUT"

chmod +x "$OUTPUT"
file "$OUTPUT" | grep -q "$MACHINE"

for SHELL_NAME in auto zsh bash sh fish; do
  ln -sfn "$(basename "$OUTPUT")" "${OUTPUT}-${SHELL_NAME}"
  test -x "${OUTPUT}-${SHELL_NAME}"
done

echo "MACOS_PROCESS_HOST_OK"
echo "TARGET=$TARGET"
echo "OUTPUT=$OUTPUT"
