#!/usr/bin/env bash
#
# Download the Inter and JetBrains Mono font files used by the kinetic
# typography demo renderer (render.py).
#
# Both fonts ship under SIL Open Font License and are safe to redistribute;
# the renderer expects them at docs/demo-video/fonts/ relative to the repo
# root. Re-run this script if the fonts/ directory is missing or outdated.
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
FONT_DIR="$HERE/fonts"
INTER_VERSION="4.0"
JB_VERSION="2.304"

mkdir -p "$FONT_DIR"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "▶ Downloading Inter v${INTER_VERSION}"
curl -sSfL \
  "https://github.com/rsms/inter/releases/download/v${INTER_VERSION}/Inter-${INTER_VERSION}.zip" \
  -o "$tmp/inter.zip"
unzip -qo "$tmp/inter.zip" -d "$tmp/inter"
cp "$tmp/inter/extras/ttf/Inter-Regular.ttf" "$FONT_DIR/"
cp "$tmp/inter/extras/ttf/Inter-Medium.ttf"  "$FONT_DIR/"
cp "$tmp/inter/extras/ttf/Inter-Bold.ttf"    "$FONT_DIR/"
cp "$tmp/inter/LICENSE.txt"                  "$FONT_DIR/Inter-LICENSE.txt"
echo "  ✓ Inter-Regular.ttf, Inter-Medium.ttf, Inter-Bold.ttf"

echo "▶ Downloading JetBrains Mono v${JB_VERSION}"
curl -sSfL \
  "https://github.com/JetBrains/JetBrainsMono/releases/download/v${JB_VERSION}/JetBrainsMono-${JB_VERSION}.zip" \
  -o "$tmp/jb.zip"
unzip -qo "$tmp/jb.zip" -d "$tmp/jb"
cp "$tmp/jb/fonts/ttf/JetBrainsMono-Regular.ttf" "$FONT_DIR/"
cp "$tmp/jb/OFL.txt"                              "$FONT_DIR/JetBrainsMono-OFL.txt"
echo "  ✓ JetBrainsMono-Regular.ttf"

echo ""
echo "Fonts written to $FONT_DIR"
ls -lh "$FONT_DIR"
