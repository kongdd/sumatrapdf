#!/bin/bash
# Build with: bun cmd/ng-build.ts -rel SumatraPDF
set -euo pipefail
cd "$(dirname "$0")/.."

binary=out/mac/rel/SumatraPDF
arch=$(uname -m)
version=$(sed -n 's/^#define CURR_VERSION //p' src/shared/Version.h | head -1)
build=${GITHUB_RUN_NUMBER:-1}
dist=out/mac/package
stage="$dist/stage"
app="$stage/SumatraPDF.app"
rm -rf "$stage"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$binary" "$app/Contents/MacOS/SumatraPDF"
cp COPYING COPYING.BSD AUTHORS "$app/Contents/Resources/"

cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>SumatraPDF</string>
  <key>CFBundleDisplayName</key><string>SumatraPDF Preview</string>
  <key>CFBundleIdentifier</key><string>io.github.kongdd.SumatraPDF</string>
  <key>CFBundleExecutable</key><string>SumatraPDF</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$build</string>
  <key>LSMinimumSystemVersion</key><string>${MACOSX_DEPLOYMENT_TARGET:-15.0}</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
EOF
plutil -lint "$app/Contents/Info.plist"
# Reject dependencies that would make the app work only on the build runner.
otool -L "$binary"
if otool -L "$binary" | tail -n +2 | awk '{print $1}' | grep -Ev '^(/usr/lib/|/System/Library/)'; then
  echo "Unexpected non-system dynamic library dependency" >&2
  exit 1
fi
codesign --force --sign - "$app"
codesign --verify --deep --strict "$app"
ln -s /Applications "$stage/Applications"
dmg="$dist/SumatraPDF-$version-macos-$arch.dmg"
rm -f "$dmg"
hdiutil create -volname "SumatraPDF Preview" -srcfolder "$stage" -format UDZO "$dmg"
hdiutil verify "$dmg"
shasum -a 256 "$dmg" > "$dmg.sha256"
