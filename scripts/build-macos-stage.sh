#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"
[[ "$(uname -s)" == "Darwin" ]] || { echo "macOS stage requires Darwin" >&2; exit 2; }
[[ "$(uname -m)" == "arm64" ]] || { echo "macOS ARM64 stage requires arm64" >&2; exit 2; }

VERSION="$(node -p "require('./package.json').version")"
NODE_VERSION="24.19.0"
NODE_ARCHIVE="node-v${NODE_VERSION}-darwin-arm64.tar.gz"
NODE_SHA="8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"
TUNNEL_VERSION="v0.0.13"
TUNNEL_ASSET="tunnel-client-v0.0.13-darwin-arm64.zip"
TUNNEL_SHA="15abf165f06050af642c948ba6bd6c905191dc5420a9422dadde2b49d892e2c6"
TUNNEL_URL="https://github.com/openai/tunnel-client/releases/download/${TUNNEL_VERSION}/${TUNNEL_ASSET}"
RUNTIME="$PROJECT_ROOT/runtime"
DOWNLOADS="$RUNTIME/downloads"
STAGE="$RUNTIME/release-stage/darwin-arm64"
APP="$STAGE/DeskMCP.app"
CONTENTS="$APP/Contents"
RESOURCES="$CONTENTS/Resources"
mkdir -p "$DOWNLOADS"

npm_ci_with_audit_proof() {
  local stdout status
  stdout="$(mktemp)"
  set +e
  npm ci "$@" --audit=true 2>&1 | tee "$stdout"
  status=${PIPESTATUS[0]}
  set -e
  if [[ $status -ne 0 ]]; then
    rm -f "$stdout"
    echo "Production npm ci failed: exit=$status" >&2
    return $status
  fi
  if grep -Eqi 'npm (warn|error) audit|audit endpoint returned an error' "$stdout"; then
    tail -c 1200 "$stdout" >&2
    rm -f "$stdout"
    echo "Production npm ci audit was unavailable; refusing release." >&2
    return 1
  fi
  if ! grep -Eqi '^[[:space:]]*found[[:space:]]+0[[:space:]]+vulnerabilities[[:space:]]*$' "$stdout"; then
    tail -c 1200 "$stdout" >&2
    rm -f "$stdout"
    echo "Production npm ci did not prove zero vulnerabilities; refusing release." >&2
    return 1
  fi
  rm -f "$stdout"
  echo "NPM_AUDIT_OK source=npm-ci"
}
verified_download() {
  local url="$1" path="$2" sha="$3"
  if [[ -f "$path" ]] && echo "$sha  $path" | shasum -a 256 -c - >/dev/null 2>&1; then return; fi
  rm -f "$path"
  curl -fL --retry 3 --retry-delay 2 -o "$path" "$url"
  echo "$sha  $path" | shasum -a 256 -c -
}
rm -rf "$STAGE"
mkdir -p "$CONTENTS/MacOS" "$RESOURCES/node/bin" "$RESOURCES/tunnel-client/bin" "$RESOURCES/gateway"

swift test -c release --package-path control-panel/macos
swift build -c release --package-path control-panel/macos
SWIFT_BIN="$(swift build -c release --package-path control-panel/macos --show-bin-path)/DeskMCPMac"
cp "$SWIFT_BIN" "$CONTENTS/MacOS/DeskMCP"
chmod +x "$CONTENTS/MacOS/DeskMCP"
file "$CONTENTS/MacOS/DeskMCP" | grep -q 'arm64'

verified_download "$NODE_URL" "$DOWNLOADS/$NODE_ARCHIVE" "$NODE_SHA"
NODE_EXTRACT="$RUNTIME/downloads/node-darwin-arm64"
rm -rf "$NODE_EXTRACT"
mkdir -p "$NODE_EXTRACT"
tar -xzf "$DOWNLOADS/$NODE_ARCHIVE" -C "$NODE_EXTRACT"
cp "$NODE_EXTRACT/node-v${NODE_VERSION}-darwin-arm64/bin/node" "$RESOURCES/node/bin/node"
cp "$NODE_EXTRACT/node-v${NODE_VERSION}-darwin-arm64/LICENSE" "$RESOURCES/node/LICENSE"
chmod +x "$RESOURCES/node/bin/node"
file "$RESOURCES/node/bin/node" | grep -q 'arm64'

verified_download "$TUNNEL_URL" "$DOWNLOADS/$TUNNEL_ASSET" "$TUNNEL_SHA"
TUNNEL_EXTRACT="$RUNTIME/downloads/tunnel-darwin-arm64"
rm -rf "$TUNNEL_EXTRACT"
mkdir -p "$TUNNEL_EXTRACT"
unzip -q "$DOWNLOADS/$TUNNEL_ASSET" -d "$TUNNEL_EXTRACT"
cp -R "$TUNNEL_EXTRACT/"* "$RESOURCES/tunnel-client/bin/"
chmod +x "$RESOURCES/tunnel-client/bin/tunnel-client"
[[ ! -f "$RESOURCES/tunnel-client/bin/cloudflared" ]] || chmod +x "$RESOURCES/tunnel-client/bin/cloudflared"
file "$RESOURCES/tunnel-client/bin/tunnel-client" | grep -q 'arm64'
"$RESOURCES/tunnel-client/bin/tunnel-client" --version
cp -R dist "$RESOURCES/gateway/dist"
cp package.json package-lock.json .npmrc "$RESOURCES/gateway/"
pushd "$RESOURCES/gateway" >/dev/null
npm_ci_with_audit_proof --omit=dev --ignore-scripts --os=darwin --cpu=arm64
popd >/dev/null

test -f "$RESOURCES/gateway/node_modules/@img/sharp-darwin-arm64/package.json"
test -f "$RESOURCES/gateway/node_modules/@vscode/ripgrep-darwin-arm64/package.json"
test ! -e "$RESOURCES/gateway/node_modules/@img/sharp-darwin-x64"
test ! -e "$RESOURCES/gateway/node_modules/@vscode/ripgrep-darwin-x64"

node scripts/generate-third-party-notices.mjs "$PROJECT_ROOT" "$RESOURCES" darwin-arm64 "$NODE_VERSION"
cp LICENSE "$RESOURCES/LICENSE"
cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>DeskMCP</string>
  <key>CFBundleIdentifier</key><string>io.github.edmen12.deskmcp</string>
  <key>CFBundleName</key><string>DeskMCP</string>
  <key>CFBundleDisplayName</key><string>DeskMCP</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
plutil -lint "$CONTENTS/Info.plist"
cat > "$RESOURCES/release-target.json" <<JSON
{
  "target": "darwin-arm64",
  "architecture": "arm64",
  "minimumMacOS": "13.0",
  "nodeVersion": "$NODE_VERSION",
  "tunnelVersion": "$TUNNEL_VERSION",
  "signing": "ad-hoc-test-only",
  "notarized": false,
  "distributionReady": false
}
JSON

codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

RELEASE="$RUNTIME/release"
mkdir -p "$RELEASE"
ZIP="$RELEASE/DeskMCP-${VERSION}-macos-arm64-unsigned.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
ZIP_SHA="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
printf '%s  %s\n' "$ZIP_SHA" "$(basename "$ZIP")" > "$RELEASE/SHA256SUMS-macos-arm64-unsigned.txt"

echo "MACOS_STAGE_OK"
echo "TARGET=darwin-arm64"
echo "APP=$APP"
echo "UNSIGNED_ZIP=$ZIP"
echo "ZIP_SHA256=$ZIP_SHA"
echo "DISTRIBUTION_READY=false"
